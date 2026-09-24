// The one place a custom API connection is actually contacted.
//
// Everything dangerous about this feature is in this file, so the rules are
// written as code rather than as a convention, and each one is exported so a
// test can attack it directly rather than only through a route.
//
//   * THE HOST COLUMN IS THE ALLOWLIST. A request is built, then the finished
//     URL is re-parsed and refused unless its hostname equals
//     `connection.host` exactly and its path is under the base URL's path. A
//     path template with a scheme in it, a parameter substitution that escapes
//     the path, a base URL edited between save and use: all three end at that
//     comparison. It is done on the URL that will be SENT, not on the pieces
//     that went into it, because a check on the ingredients is a check on the
//     wrong thing.
//   * THE MODEL SUPPLIES VALUES, NEVER STRUCTURE. Arguments are matched
//     against the endpoint's declared parameter list by name; anything not on
//     that list is dropped rather than passed through. There is no argument
//     that names a header, a method, a host or a path.
//   * ADDRESSES ARE CHECKED AT REQUEST TIME, not once at save time. A hostname
//     that resolves to something benign when the administrator tested it and to
//     169.254.169.254 when the assistant uses it is the whole DNS-rebinding
//     trick, and it costs nothing to re-check.
//   * PUBLIC ADDRESSES ONLY. This is the opposite of packages/llm/src/ssrf.ts
//     and deliberately so. That module must permit loopback and LAN addresses
//     because self-hosted inference is the point of it, and nothing chooses its
//     path. Here the ASSISTANT chooses which of several actions to invoke, so
//     an internal address would turn a model's choice into a request against
//     this network. `nonPublicReason` is imported from `devServiceProbe`
//     rather than copied: it is a pure predicate with exactly ONE policy —
//     "is this on the public internet" — and this feature wants that same
//     answer. What that file warns against is a shared function with a
//     `strict` flag, which is a different thing and still not offered.
//   * REDIRECTS ARE NOT FOLLOWED. Validating a URL and then letting the client
//     chase a 302 checks the wrong thing.
//   * NOTHING FROM THE API'S ERROR BODY REACHES A LOG, AN AUDIT PAYLOAD OR A
//     DIAGNOSTIC. An arbitrary API's error text is attacker-influenced and may
//     quote the request back — and a request here carries this installation's
//     credential. Failures become an `ErrorCategory` and a sentence CE wrote.
//     A SUCCESSFUL read's body does go back to the assistant, which is the
//     point of the feature, capped and never logged.
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ConnectorError, type ErrorCategory } from './providers.js';
import {
  CustomApiInputError,
  type CustomApiConnectionRow, type CustomApiEndpointRow, type CustomApiMethod,
  type CustomApiParameter, type CustomApiSecret,
} from './customApi.js';

/** A refusal from this layer. Carries a category the UI already knows how to
 * say in plain language, and a message CE wrote — never the API's. */
export class CustomApiError extends ConnectorError {}

export interface CustomApiFetchOptions {
  /** Injected by the tests, so no suite contacts a real API. Unset in
   * production. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

/** An API that has not answered in twenty seconds is an API somebody is
 * waiting on. Long enough for a cold service, short enough that a conversation
 * does not stall behind it. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** The most of a response body Josi will read. Anything larger is either the
 * wrong endpoint or something trying to make this process hold it in memory. */
const MAX_BODY_BYTES = 512 * 1024;

/** The most of a response that goes back to the assistant. Smaller than what is
 * read, because a model context is not a place to put half a megabyte of
 * somebody's CRM. Truncation is always stated rather than silent. */
export const MAX_MODEL_BODY_CHARS = 20_000;

/** The longest a single argument value may be. A parameter without a ceiling is
 * a parameter somebody puts a document in. */
const MAX_ARGUMENT_CHARS = 1_000;

/** The largest JSON body an action may send. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function nonPublicReason(address: string): string | null {
  const normal = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return nonPublicReason([high >> 8, high & 255, low >> 8, low & 255].join('.'));
  }
  const dottedMapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(normal);
  if (dottedMapped) return nonPublicReason(dottedMapped[1]);
  if (isIP(normal) === 4) {
    const bytes = normal.split('.').map(Number);
    if (bytes[0] === 10 || bytes[0] === 127 || bytes[0] === 0
      || (bytes[0] === 169 && bytes[1] === 254)
      || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31)
      || (bytes[0] === 192 && bytes[1] === 168)
      || (bytes[0] === 100 && bytes[1] >= 64 && bytes[1] <= 127)
      || bytes[0] >= 224) return 'a non-public address';
    return null;
  }
  if (isIP(normal) === 6) {
    if (normal === '::' || normal === '::1' || /^f[cd]/.test(normal)
      || normal.startsWith('fe80') || normal.startsWith('ff')) return 'a non-public address';
    return null;
  }
  return 'not an address';
}

// --------------------------------------------------------------- arguments

/**
 * One argument value, narrowed to something that can safely become part of a
 * URL.
 *
 * Scalars only. An object or an array would have to be serialised by a choice
 * this code made on the model's behalf — comma-joined? repeated key? JSON? —
 * and every one of those choices is a guess about an API nobody here has read
 * the documentation for. Saying so is better than picking one.
 */
export function coerceArgument(name: string, value: unknown): string {
  if (typeof value === 'string') {
    if (value.length > MAX_ARGUMENT_CHARS) {
      throw new CustomApiInputError(`the value for "${name}" is too long`);
    }
    // A newline in a value that is about to be placed in a URL is the shape of
    // a request-splitting attempt, and `encodeURIComponent` would hide it
    // rather than refuse it.
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new CustomApiInputError(`the value for "${name}" contains a character that cannot be sent`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new CustomApiInputError(
    `"${name}" must be a piece of text, a number or true/false — this action does not accept a list `
    + 'or a nested object there',
  );
}

export interface BuiltCustomApiRequest {
  url: string;
  method: CustomApiMethod;
  /** The JSON body, or null. Never a string this code assembled. */
  body: unknown;
  /** Arguments the model supplied that this action does not declare. Reported
   * back so the assistant is told what was ignored rather than left to assume
   * it was honoured. */
  ignored: string[];
}

/**
 * Turns one allowlisted action plus the model's arguments into the exact
 * request that will be sent — and refuses if that request would leave the
 * connection it belongs to.
 *
 * Exported and pure so the test can attack the substitution directly: a value
 * of `../../admin`, a value containing `https://elsewhere`, a path parameter
 * carrying a `/`. None of them can escape, because path values are
 * percent-encoded (which encodes `/` and `.` sequences into something that
 * cannot be a segment boundary) and the finished URL is checked afterwards
 * anyway.
 */
export function buildCustomApiRequest(args: {
  connection: CustomApiConnectionRow;
  endpoint: CustomApiEndpointRow;
  arguments?: Record<string, unknown> | null;
  body?: unknown;
}): BuiltCustomApiRequest {
  const { connection, endpoint } = args;
  const supplied = (args.arguments ?? {}) as Record<string, unknown>;
  const declared: CustomApiParameter[] = Array.isArray(endpoint.parameters) ? endpoint.parameters : [];
  const byName = new Map(declared.map((p) => [p.name, p] as const));

  const ignored = Object.keys(supplied).filter((k) => !byName.has(k));

  const values = new Map<string, string>();
  for (const parameter of declared) {
    const raw = supplied[parameter.name];
    if (raw === undefined || raw === null || raw === '') {
      if (parameter.required) {
        throw new CustomApiInputError(`this action needs a value for "${parameter.name}"`);
      }
      continue;
    }
    values.set(parameter.name, coerceArgument(parameter.name, raw));
  }

  // Path substitution. Every placeholder must have a value — `validateCustomApiParameters`
  // forces a path parameter to be required, so a missing one has already been
  // refused above, and this is the second line rather than the only one.
  let path = endpoint.path_template;
  path = path.replace(/\{([a-zA-Z][a-zA-Z0-9_]{0,38})\}/g, (_match, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      throw new CustomApiInputError(`this action needs a value for "${name}"`);
    }
    return encodeURIComponent(value);
  });

  const query = new URLSearchParams();
  for (const parameter of declared) {
    if (parameter.in !== 'query') continue;
    const value = values.get(parameter.name);
    if (value !== undefined) query.append(parameter.name, value);
  }

  const search = query.toString();
  let url: URL;
  try {
    url = new URL(`${connection.base_url}${path}${search ? `?${search}` : ''}`);
  } catch {
    throw new CustomApiError('that request could not be assembled into a valid address', {
      category: 'provider_error',
    });
  }

  // THE CHECK. Everything above is construction; this is the invariant.
  const basePath = new URL(connection.base_url).pathname.replace(/\/+$/, '');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:'
    || hostname !== connection.host
    || url.username || url.password
    || !url.pathname.startsWith(`${basePath}/`)
    || url.pathname.includes('/../')
    || url.pathname.endsWith('/..')
  ) {
    throw new CustomApiError(
      `that request would leave ${connection.name}, so Josi refused to make it`,
      { category: 'provider_error' },
    );
  }

  let body: unknown = null;
  if (endpoint.accepts_body && args.body !== undefined && args.body !== null) {
    // Objects and arrays only. A bare string or number as a whole request body
    // is legal JSON and is almost never what an API meant, and accepting one
    // makes "what does this action send?" unanswerable from the allowlist row.
    if (typeof args.body !== 'object') {
      throw new CustomApiInputError('the body for this action must be an object of fields');
    }
    const encoded = JSON.stringify(args.body);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw new CustomApiInputError('that body is larger than Josi will send');
    }
    body = args.body;
  }

  return { url: url.toString(), method: endpoint.method, body, ignored };
}

/**
 * The one request "test this connection" makes: a GET to the configured test
 * path, on the same host, with the same credential.
 *
 * Its own function rather than a synthetic endpoint row, because a synthetic
 * row is a row — and a row is the thing this feature says the assistant can
 * only choose from. Testing must never become the way an unlisted endpoint gets
 * called, so this builds a GET and nothing else: no parameters, no body, no
 * method argument.
 */
export function buildCustomApiTestRequest(
  connection: CustomApiConnectionRow,
): BuiltCustomApiRequest {
  let url: URL;
  try {
    url = new URL(`${connection.base_url}${connection.test_path}`);
  } catch {
    throw new CustomApiError('that test path could not be turned into an address', {
      category: 'provider_error',
    });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || hostname !== connection.host || url.username || url.password) {
    throw new CustomApiError(
      `that test would leave ${connection.name}, so Josi refused to make it`,
      { category: 'provider_error' },
    );
  }
  return { url: url.toString(), method: 'GET', body: null, ignored: [] };
}

// ------------------------------------------------------------------ headers

/** The credential, applied.
 *
 * The one function that turns a sealed value into a header, kept separate from
 * the request so a test can assert what it produces without sending anything —
 * and so there is exactly one place to look when asking "where does the secret
 * go?". It goes in a header and never in the URL: a URL reaches logs, proxies
 * and error messages.
 */
export function authHeaders(
  connection: Pick<CustomApiConnectionRow, 'auth_kind' | 'auth_header'>,
  secret: CustomApiSecret,
): Record<string, string> {
  switch (connection.auth_kind) {
    case 'api_key': {
      const header = connection.auth_header;
      if (!header || !('secret' in secret)) {
        throw new CustomApiError('that connection is not configured properly', { category: 'provider_error' });
      }
      return { [header.toLowerCase()]: secret.secret };
    }
    case 'bearer': {
      if (!('secret' in secret)) {
        throw new CustomApiError('that connection is not configured properly', { category: 'provider_error' });
      }
      return { authorization: `Bearer ${secret.secret}` };
    }
    case 'basic': {
      if (!('username' in secret)) {
        throw new CustomApiError('that connection is not configured properly', { category: 'provider_error' });
      }
      const pair = Buffer.from(`${secret.username}:${secret.password}`, 'utf8').toString('base64');
      return { authorization: `Basic ${pair}` };
    }
  }
}

// ------------------------------------------------------------------ request

export interface CustomApiResponse {
  status: number;
  /** Parsed when the API sent JSON; otherwise the text, capped. Never logged. */
  body: unknown;
  /** True when the body was longer than Josi will pass on. Stated rather than
   * silently dropped, so nothing downstream treats a fragment as the whole
   * answer. */
  truncated: boolean;
  contentType: string | null;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolves a host and refuses anything that is not on the public internet.
 *
 * Exported because it is the SSRF control, and a control that can only be
 * exercised through a full request is a control that gets tested once.
 */
export async function assertPublicHost(
  host: string,
  opts: CustomApiFetchOptions = {},
): Promise<string[]> {
  // A base URL that is already a literal address never reaches a resolver, so
  // it would sail past a check that only inspects DNS answers.
  if (isIP(host)) {
    const reason = nonPublicReason(host);
    if (reason) {
      throw new CustomApiError(
        `${host} is ${reason}, and Josi only calls custom APIs on the public internet.`,
        { category: 'network' },
      );
    }
    return [host];
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw new CustomApiError(`${host} could not be looked up from this server`, { category: 'network' });
  }
  if (!addresses.length) {
    throw new CustomApiError(`${host} resolved to no addresses from this server`, { category: 'network' });
  }
  // EVERY address, not the first: a hostname answering with one public and one
  // metadata address is an attack, not a lucky draw.
  for (const address of addresses) {
    const reason = nonPublicReason(address);
    if (reason) {
      throw new CustomApiError(
        `${host} resolved to ${reason} on this server, so Josi refused the request. `
        + 'A custom API must be reachable on the public internet.',
        { category: 'network' },
      );
    }
  }
  return addresses;
}

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return {
    text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'),
    truncated,
  };
}

/**
 * One request to one allowlisted action on one allowed host.
 *
 * The credential is passed in and used once. It is never put in the URL, never
 * in a query string, never returned and never logged.
 */
export async function customApiFetch(
  args: {
    connection: CustomApiConnectionRow;
    request: Pick<BuiltCustomApiRequest, 'url' | 'method' | 'body'>;
    secret: CustomApiSecret;
  },
  opts: CustomApiFetchOptions = {},
): Promise<CustomApiResponse> {
  const { connection, request } = args;

  // Re-parsed here as well as in the builder. This function is exported, so
  // "the builder already checked" is a property of one call path rather than of
  // this function.
  const url = new URL(request.url);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || hostname !== connection.host) {
    throw new CustomApiError(
      `that request would leave ${connection.name}, so Josi refused to make it`,
      { category: 'provider_error' },
    );
  }

  const approvedAddresses = await assertPublicHost(connection.host, opts);

  const headers: Record<string, string> = {
    accept: 'application/json',
    // Named so an operator reading their own API's access log can see which
    // software called. Carries no version of anything sensitive.
    'user-agent': 'josi-ce',
    ...authHeaders(connection, args.secret),
  };
  if (request.body !== null && request.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  // Production requests pin the socket lookup to an address that passed the
  // public-IP check above. Resolving once for validation and again inside fetch
  // would leave a DNS-rebinding window between those two operations.
  const dispatcher = opts.fetchImpl ? undefined : new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        const address = approvedAddresses[0];
        callback(null, address, isIP(address));
      },
    },
  });
  try {
    const requestInit = {
      method: request.method,
      headers,
      body: request.body === null || request.body === undefined
        ? undefined
        : JSON.stringify(request.body),
      // Validating a URL and then chasing a 302 checks the wrong URL.
      redirect: 'manual',
      signal: controller.signal,
    } as const;
    res = opts.fetchImpl
      ? await opts.fetchImpl(request.url, requestInit)
      : await undiciFetch(request.url, { ...requestInit, dispatcher }) as unknown as Response;
  } catch {
    clearTimeout(timer);
    await dispatcher?.close().catch(() => undefined);
    // Deliberately not `err.message`: an undici error can carry the request
    // URL, and the habit of interpolating fetch errors is how a header ends up
    // in a log.
    throw new CustomApiError(`Josi could not reach ${connection.name}`, { category: 'network' });
  }

  if (res.status >= 300 && res.status < 400) {
    clearTimeout(timer);
    await dispatcher?.close().catch(() => undefined);
    throw new CustomApiError(
      `${connection.name} answered with a redirect, which Josi does not follow. If that API has `
      + 'moved, update its address on the Custom API page.',
      { category: 'provider_error' },
    );
  }

  const contentType = res.headers.get('content-type');
  const { text, truncated: capped } = await readCapped(res).catch(() => ({ text: '', truncated: false }));
  clearTimeout(timer);
  await dispatcher?.close();

  let body: unknown = null;
  let truncated = capped;
  if (text) {
    const clipped = text.length > MAX_MODEL_BODY_CHARS;
    if (clipped) truncated = true;
    try {
      // Parsed from the FULL text, so a truncation marker is about what is
      // passed on rather than about a JSON document cut in half.
      body = clipped ? text.slice(0, MAX_MODEL_BODY_CHARS) : JSON.parse(text);
    } catch {
      body = text.slice(0, MAX_MODEL_BODY_CHARS);
    }
  }
  return { status: res.status, body, truncated, contentType };
}

// ------------------------------------------------------------------ mapping

/** What an HTTP status from an arbitrary API means to the person who has to fix
 * it. Never the API's own words. */
export function categoryForCustomApiStatus(status: number): ErrorCategory {
  if (status === 401) return 'revoked';
  if (status === 403) return 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

/** The sentence shown when an API refuses. Written here, in CE's words, for
 * every category — so no code path is tempted to pass an API's error body
 * through to a screen. */
export function customApiSentence(name: string, category: ErrorCategory): string {
  switch (category) {
    case 'revoked':
      return `${name} did not accept the stored credential. It may have been revoked, rotated or mistyped.`;
    case 'insufficient_scope':
      return `${name} accepted the credential but refused this request, which usually means the `
        + 'credential is not permitted to do this.';
    case 'rate_limited':
      return `${name} is asking Josi to slow down. Nothing is wrong with the credential.`;
    case 'expired':
      return `The credential for ${name} has expired. Replace it on the Custom API page.`;
    case 'network':
      return `Josi could not reach ${name}.`;
    default:
      return `${name} returned an error.`;
  }
}
