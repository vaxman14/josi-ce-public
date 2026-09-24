// Custom API connections: an external HTTP API this product has never heard of.
//
// WHAT THIS IS, STATED AS A BOUNDARY RATHER THAN A FEATURE
//
// An administrator names a service, gives its HTTPS base URL and a credential,
// and then lists — one row at a time, each one reviewed and switched on by
// hand — the exact requests Josi may make to it. The assistant chooses from
// that list and from nothing else. It cannot name a URL, a host, a method, a
// header or a path; the only two strings it supplies are a connection slug and
// an operation id, and both are looked up rather than interpolated.
//
// WHY IT IS NOT ONE OF THE THREE THINGS IT RESEMBLES
//
//   * A MODEL ENDPOINT (packages/llm) is one caller asking one question with
//     one shape. Nothing chooses its path. Here the assistant chooses, which is
//     the entire risk and the entire reason `custom_api_endpoints` exists.
//   * A DEVELOPER SERVICE (devServices.ts) has ONE PINNED HOST compiled into
//     CE and four hand-written probes. Nothing about it is operator-supplied,
//     so there is no allowlist to keep. Here the host comes from a form, so the
//     host IS the allowlist and it is a column that every request re-checks.
//   * AN MCP SERVER is not implemented in CE, and this is not a step towards
//     one: nothing here speaks a protocol and nothing here is a tunnel.
//
// OWNERSHIP, because it is the opposite of the call made in 0034
//
// These are INSTALLATION-SCOPED and administrator-owned. A GitHub personal
// access token acts as the person who minted it; a custom API credential is a
// service credential the operator holds on the installation's behalf, exactly
// like an SMTP profile or the LLM provider key. So there is no owner column on
// the connection — a member-owned connection would let one person's credential
// be spent by another person's conversation.
//
// Per-person isolation lives one table down and is absolute: every request is
// made FOR one person, and every write or delete becomes a
// `custom_api_pending_calls` row only its owner can see or decide.
//
// NOTHING IN THIS FILE RETURNS A CREDENTIAL. `openCustomApiCredentials` is the single
// exception and it hands the value to one caller at the moment of a request.
import { appendEvent, json, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { ErrorCategory } from './providers.js';

// ------------------------------------------------------------------- shapes

/** API key in a named header, bearer token, or HTTP basic.
 *
 * Deliberately three, and deliberately not four. There is no `none`: an API
 * worth connecting authenticates, and an unauthenticated entry would make this
 * a general outbound HTTP capability with extra steps.
 *
 * There is no `oauth` either, and that is a refusal rather than an omission.
 * CE's OAuth machinery (connections.ts) is built around a registered client, a
 * provider consent screen and a refresh cycle, none of which an arbitrary API
 * supplies. A value that said `oauth` while the code pasted a long-lived token
 * into a header would be a lie told in schema. */
export type CustomApiAuthKind = 'api_key' | 'bearer' | 'basic';

/** Read is separated from write and delete, and the METHOD decides — the
 * database refuses any other pairing. A search endpoint that genuinely needs
 * POST is therefore treated as a write and asks for approval. That is the safe
 * side of the trade-off and it is a deliberate one. */
export type CustomApiCapability = 'read' | 'write' | 'delete';

export type CustomApiMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const CUSTOM_API_METHODS: readonly CustomApiMethod[] = Object.freeze([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE',
]);

/** What the method means for approval. The one place the mapping is written. */
export function customApiCapabilityForMethod(method: CustomApiMethod): CustomApiCapability {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'delete';
  return 'write';
}

export interface CustomApiConnectionRow {
  id: string;
  name: string;
  slug: string;
  base_url: string;
  host: string;
  auth_kind: CustomApiAuthKind;
  auth_header: string | null;
  credentials_enc: string;
  test_path: string;
  enabled: boolean;
  status: 'unverified' | 'active' | 'needs_attention';
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: ErrorCategory | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One input an allowlisted action accepts. An argument the model supplies that
 * is not named here is DROPPED — a new query parameter is a decision somebody
 * makes, never one the model discovers. */
export interface CustomApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  /** What the model is told this is for. Never interpolated into a request. */
  description: string;
}

export interface CustomApiEndpointRow {
  id: string;
  connection_id: string;
  operation_id: string;
  summary: string;
  method: CustomApiMethod;
  path_template: string;
  capability: CustomApiCapability;
  parameters: CustomApiParameter[];
  accepts_body: boolean;
  enabled: boolean;
  source: 'manual' | 'openapi';
  created_at: string;
  updated_at: string;
}

export interface CustomApiPendingCallRow {
  id: string;
  owner_user_id: string;
  endpoint_id: string;
  thread_id: string | null;
  summary: string;
  request_enc: string;
  payload_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  result_status: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** What is sealed. Two shapes for three auth kinds, because bearer and API key
 * are both one opaque string and pretending otherwise would mean a third code
 * path that does the same thing. */
export type CustomApiSecret =
  | { secret: string }
  | { username: string; password: string };

/** The mask an administrator sees where the credential was.
 *
 * A CONSTANT. Not the last four characters, not the length, not a hash — four
 * characters of a credential are still four characters of a credential, and a
 * length narrows a search. "Which credential is this?" is answered by the
 * connection's name, which somebody typed and which is not a secret. */
export const CREDENTIAL_MASK = '••••••••••••';

// --------------------------------------------------------------- validation

export class CustomApiInputError extends Error {}

/** A ceiling on every free-text field. A field without one is a field somebody
 * pastes a file into. */
const MAX_NAME_CHARS = 80;
const MAX_SUMMARY_CHARS = 400;
const MAX_SECRET_CHARS = 4096;
const MAX_PATH_CHARS = 400;
const MAX_PARAMETERS = 40;

/** Whitespace and control characters, written as escapes so this file contains
 * none of them. Either one inside a pasted credential means the paste took
 * something it should not have — and a newline in a header value is request
 * splitting. */
const NOT_IN_A_SECRET = /[\s\u0000-\u001f\u007f]/;

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

export function validateCustomApiName(raw: unknown): string {
  const name = text(raw);
  if (!name) throw new CustomApiInputError('give this connection a name you will recognise later');
  if (name.length > MAX_NAME_CHARS) {
    throw new CustomApiInputError(`a name can be at most ${MAX_NAME_CHARS} characters`);
  }
  // Control characters in a name reach an admin table and a tool description.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new CustomApiInputError('a name cannot contain control characters or line breaks');
  }
  return name;
}

/**
 * The identifier the MODEL sees, and the first half of every tool argument it
 * can form.
 *
 * Constrained to an identifier so a name can never carry a path, a host, a
 * quote or a newline into a prompt or a URL. Derived from the display name when
 * the administrator does not supply one, because asking for two names to
 * describe one thing is how the second one ends up being `asdf`.
 */
export function validateCustomApiSlug(raw: unknown, fallbackName?: string): string {
  let slug = text(raw).toLowerCase();
  if (!slug && fallbackName) {
    slug = fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    // A generated slug must still satisfy the same grammar; a name of "1st API"
    // produces something starting with a digit, which the check below refuses.
    if (/^[0-9_]/.test(slug)) slug = `api_${slug}`.slice(0, 40);
    slug = slug.replace(/_+$/, '');
  }
  if (!/^[a-z][a-z0-9_]{0,38}[a-z0-9]$/.test(slug)) {
    throw new CustomApiInputError(
      'a short name for the assistant must be 2 to 40 characters of lowercase letters, digits and '
      + 'underscores, starting with a letter — for example "booking_system"',
    );
  }
  return slug;
}

export interface ValidatedCustomApiBaseUrl {
  baseUrl: string;
  host: string;
}

/**
 * The base URL, and the host allowlist derived from it.
 *
 * HTTPS ONLY, and that is not negotiable through the form: a plain `http://`
 * base URL would put this installation's credential on the wire in clear text
 * on every call, and "the operator typed it, so they meant it" is not a defence
 * for a credential held on everybody's behalf.
 *
 * Credentials in the URL are refused for the reason they always are — a URL
 * reaches logs, proxies and error messages, and this one is about to be stored.
 *
 * A query string or a fragment on the BASE is refused too, and that one is less
 * obvious: every request appends a path and its own query, so a base that
 * already carried one would either silently lose it or produce a URL nobody
 * reviewed. Saying so is better than picking one of those quietly.
 */
export function validateCustomApiBaseUrl(raw: unknown): ValidatedCustomApiBaseUrl {
  const value = text(raw);
  if (!value) throw new CustomApiInputError('give the API\'s base address, starting with https://');
  if (value.length > 300) throw new CustomApiInputError('that address is too long to be a base URL');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CustomApiInputError('that is not a valid web address');
  }
  if (url.protocol !== 'https:') {
    throw new CustomApiInputError(
      'the address must start with https://. Josi will not send this installation\'s credential '
      + 'over an unencrypted connection.',
    );
  }
  if (url.username || url.password) {
    throw new CustomApiInputError('put the credential in the authentication fields, not in the address');
  }
  if (url.search || url.hash) {
    throw new CustomApiInputError(
      'the base address cannot carry a query string or a #fragment — each action adds its own',
    );
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.includes('/')) throw new CustomApiInputError('that address has no host in it');
  // A non-default port is allowed in the base URL and travels in `base_url`;
  // `host` is the hostname alone because that is what DNS answers for and what
  // every request compares against.
  const path = url.pathname.replace(/\/+$/, '');
  if (path.includes('..')) throw new CustomApiInputError('the base address cannot contain ".."');
  return { baseUrl: `${url.origin}${path}`, host };
}

/** `api_key` only: which header carries it.
 *
 * A header NAME, checked against the RFC 7230 token grammar, so nothing here
 * can inject a second header or a request line. There is no query-string
 * variant on purpose: a key in a URL is a key in the access log of every proxy
 * between here and there. */
export function validateCustomApiAuthHeader(raw: unknown): string {
  const header = text(raw);
  if (!header) throw new CustomApiInputError('say which header carries the API key, for example X-API-Key');
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(header)) {
    throw new CustomApiInputError('that is not a valid HTTP header name');
  }
  return header;
}

/** What "test this connection" asks for: a path on this same host, GET, and
 * nothing else — so testing can never be the way an unlisted endpoint gets
 * called. */
export function validateCustomApiTestPath(raw: unknown): string {
  const path = text(raw) || '/';
  if (path.length > MAX_PATH_CHARS) throw new CustomApiInputError('that test path is too long');
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('://')) {
    throw new CustomApiInputError('the test path must be a simple path on this API, such as /health');
  }
  if (/[\s\u0000-\u001f\u007f]/.test(path)) {
    throw new CustomApiInputError('the test path cannot contain spaces or control characters');
  }
  return path;
}

/** The credential, wrapped so a caller cannot leave it lying around as a bare
 * string. Returns the sealed-payload shape, never the plaintext to anything
 * except `seal`. */
export function validateCustomApiCredentials(
  authKind: CustomApiAuthKind,
  body: { secret?: unknown; username?: unknown; password?: unknown },
): CustomApiSecret {
  const check = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new CustomApiInputError(`${what} is required`);
    const v = value.trim();
    if (v.length > MAX_SECRET_CHARS) throw new CustomApiInputError(`that ${what} is too long`);
    if (NOT_IN_A_SECRET.test(v)) {
      throw new CustomApiInputError(
        `that ${what} contains a space, a line break or a character that cannot travel in an HTTP `
        + 'header — paste just the value',
      );
    }
    return v;
  };

  if (authKind === 'basic') {
    return { username: check(body.username, 'a username'), password: check(body.password, 'a password') };
  }
  return { secret: check(body.secret, authKind === 'bearer' ? 'a token' : 'an API key') };
}

export function validateCustomApiAuthKind(raw: unknown): CustomApiAuthKind {
  const value = text(raw);
  if (value === 'api_key' || value === 'bearer' || value === 'basic') return value;
  throw new CustomApiInputError('choose API key, bearer token, or username and password');
}

/** What the model names when it asks for one action. Identifier-shaped for the
 * same reason `slug` is. */
export function validateCustomApiOperationId(raw: unknown): string {
  const id = text(raw).toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(id)) {
    throw new CustomApiInputError(
      'an action id must be lowercase letters, digits and underscores, starting with a letter — '
      + 'for example "list_customers"',
    );
  }
  return id;
}

export function validateCustomApiSummary(raw: unknown): string {
  const summary = text(raw);
  if (!summary) {
    throw new CustomApiInputError('say what this action does, in the words the assistant will read');
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new CustomApiInputError(`a description can be at most ${MAX_SUMMARY_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(summary)) {
    throw new CustomApiInputError('a description cannot contain control characters or line breaks');
  }
  return summary;
}

export function validateCustomApiMethod(raw: unknown): CustomApiMethod {
  const method = text(raw).toUpperCase();
  if ((CUSTOM_API_METHODS as readonly string[]).includes(method)) return method as CustomApiMethod;
  throw new CustomApiInputError('choose one of GET, HEAD, POST, PUT, PATCH or DELETE');
}

/**
 * A path on the connection's host, with `{name}` placeholders.
 *
 * NEVER A URL. A scheme, a protocol-relative prefix and dot-segments are all
 * refused here, so the only thing this value can express is "somewhere under
 * the base URL" — and `buildCustomApiRequest` re-checks the finished URL
 * against the host column anyway, because a validator that runs once at save
 * time protects nothing against a row edited afterwards.
 */
export function validateCustomApiPathTemplate(raw: unknown): string {
  const path = text(raw);
  if (!path) throw new CustomApiInputError('give the path this action calls, such as /customers/{id}');
  if (path.length > MAX_PATH_CHARS) throw new CustomApiInputError('that path is too long');
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new CustomApiInputError('a path must start with a single / and must not be a full web address');
  }
  if (path.includes('..') || path.includes('://')) {
    throw new CustomApiInputError('a path cannot contain ".." or a scheme — it is a path, not an address');
  }
  if (/[\s\u0000-\u001f\u007f]/.test(path)) {
    throw new CustomApiInputError('a path cannot contain spaces or control characters');
  }
  if (path.includes('?') || path.includes('#')) {
    throw new CustomApiInputError(
      'put query parameters in the parameter list rather than in the path, so each one can be reviewed',
    );
  }
  // Placeholders must be well-formed, or `{id` would travel to the API as a
  // literal brace and nobody would find out until it 404'd.
  const braces = path.replace(/\{[a-z][a-z0-9_]{0,38}\}/gi, '');
  if (braces.includes('{') || braces.includes('}')) {
    throw new CustomApiInputError('a placeholder looks like {name} — letters, digits and underscores only');
  }
  return path;
}

/** Every `{name}` in a path template, in order. */
export function customApiPathPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([a-z][a-z0-9_]{0,38})\}/gi)].map((m) => m[1]);
}

export function validateCustomApiParameters(raw: unknown, pathTemplate: string): CustomApiParameter[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_PARAMETERS) {
    throw new CustomApiInputError(`an action can accept at most ${MAX_PARAMETERS} parameters`);
  }
  const out: CustomApiParameter[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const name = text(entry.name);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) {
      throw new CustomApiInputError(`"${name || '(blank)'}" is not a usable parameter name`);
    }
    if (seen.has(name)) throw new CustomApiInputError(`there are two parameters called "${name}"`);
    seen.add(name);
    const where = text(entry.in);
    if (where !== 'path' && where !== 'query') {
      throw new CustomApiInputError(
        `parameter "${name}" must be in the path or the query string. Header and cookie parameters `
        + 'are not offered: a header the assistant can set is a header nobody reviewed.',
      );
    }
    out.push({
      name,
      in: where,
      required: entry.required === true,
      description: text(entry.description).slice(0, 200),
    });
  }

  // A placeholder with no parameter behind it can never be filled, so the
  // action could not be called at all. Saying so at save time beats a runtime
  // refusal nobody can explain.
  const declared = new Set(out.filter((p) => p.in === 'path').map((p) => p.name));
  for (const placeholder of customApiPathPlaceholders(pathTemplate)) {
    if (!declared.has(placeholder)) {
      throw new CustomApiInputError(
        `the path uses {${placeholder}} but no path parameter called "${placeholder}" is listed`,
      );
    }
    // A path placeholder is always required: there is no URL to build without it.
    const param = out.find((p) => p.name === placeholder);
    if (param) param.required = true;
  }
  return out;
}

// ------------------------------------------------------------------ storage

const UUID = /^[0-9a-fA-F-]{36}$/;

export async function listCustomApis(db: Db): Promise<CustomApiConnectionRow[]> {
  return db.query<CustomApiConnectionRow>(
    `select * from custom_api_connections order by name`,
  );
}

/** By id. A malformed id is "not found" rather than a query — the same rule
 * `resolveAccess` applies. */
export async function customApiById(db: Db, id: string): Promise<CustomApiConnectionRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<CustomApiConnectionRow>(
    `select * from custom_api_connections where id = $1`, [id],
  );
  return rows[0] ?? null;
}

export async function customApiBySlug(db: Db, slug: string): Promise<CustomApiConnectionRow | null> {
  const rows = await db.query<CustomApiConnectionRow>(
    `select * from custom_api_connections where slug = $1`, [slug],
  );
  return rows[0] ?? null;
}

export interface CreateCustomApiArgs {
  actorUserId: string;
  name: string;
  slug: string;
  baseUrl: string;
  host: string;
  authKind: CustomApiAuthKind;
  authHeader: string | null;
  credentials: CustomApiSecret;
  testPath: string;
}

/** Writes a connection. It arrives DISABLED and UNVERIFIED, always.
 *
 * There is no argument that turns it on, and `enableCustomApi` refuses unless
 * the API has actually answered — so a connection cannot reach the assistant on
 * the strength of a form somebody filled in. */
export async function createCustomApi(
  db: Db,
  key: MasterKey,
  args: CreateCustomApiArgs,
): Promise<CustomApiConnectionRow> {
  const sealed = seal(key, args.credentials);
  const rows = await db.query<CustomApiConnectionRow>(
    `insert into custom_api_connections
       (name, slug, base_url, host, auth_kind, auth_header, credentials_enc, test_path, created_by_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      args.name, args.slug, args.baseUrl, args.host, args.authKind,
      args.authKind === 'api_key' ? args.authHeader : null,
      sealed, args.testPath, args.actorUserId,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.connection_created',
    subjectType: 'custom_api_connection',
    subjectId: rows[0].id,
    // The slug, the host and which KIND of authentication. Never the credential
    // — and `appendEvent` would refuse a `secret` key anyway, which is the
    // backstop working rather than a reason to be careless here.
    payload: { slug: args.slug, host: args.host, authKind: args.authKind },
  });
  return rows[0];
}

export interface UpdateCustomApiArgs {
  actorUserId: string;
  connection: CustomApiConnectionRow;
  name?: string;
  baseUrl?: string;
  host?: string;
  authKind?: CustomApiAuthKind;
  authHeader?: string | null;
  /** Absent = leave the stored credential alone. Present = replace it. */
  credentials?: CustomApiSecret;
  testPath?: string;
}

/**
 * Edits a connection.
 *
 * ANY CHANGE TO WHERE OR HOW IT CONNECTS TAKES IT BACK TO UNVERIFIED AND
 * DISABLED. That is the point of this function existing rather than a bare
 * UPDATE: an administrator who edits the base URL of a working connection would
 * otherwise leave a row that still says "active, tested last Tuesday" while
 * pointing somewhere nobody has tested — and every endpoint under it would keep
 * running against the new host on the strength of the old check.
 *
 * Renaming is not such a change, so it does not cost the verification.
 */
export async function updateCustomApi(
  db: Db,
  key: MasterKey,
  args: UpdateCustomApiArgs,
): Promise<CustomApiConnectionRow> {
  const before = args.connection;
  const baseUrl = args.baseUrl ?? before.base_url;
  const host = args.host ?? before.host;
  const authKind = args.authKind ?? before.auth_kind;
  const authHeader = authKind === 'api_key'
    ? (args.authHeader ?? before.auth_header)
    : null;
  const testPath = args.testPath ?? before.test_path;

  const reconnects = baseUrl !== before.base_url
    || host !== before.host
    || authKind !== before.auth_kind
    || authHeader !== before.auth_header
    || args.credentials !== undefined;

  const rows = await db.query<CustomApiConnectionRow>(
    `update custom_api_connections set
       name = $2,
       base_url = $3,
       host = $4,
       auth_kind = $5,
       auth_header = $6,
       credentials_enc = coalesce($7, credentials_enc),
       test_path = $8,
       enabled = case when $9 then false else enabled end,
       status = case when $9 then 'unverified' else status end,
       last_check_at = case when $9 then null else last_check_at end,
       last_check_ok = case when $9 then null else last_check_ok end,
       last_error_category = case when $9 then null else last_error_category end
     where id = $1
     returning *`,
    [
      before.id, args.name ?? before.name, baseUrl, host, authKind, authHeader,
      args.credentials ? seal(key, args.credentials) : null,
      testPath, reconnects,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.connection_updated',
    subjectType: 'custom_api_connection',
    subjectId: before.id,
    payload: {
      slug: before.slug,
      host,
      authKind,
      credentialReplaced: args.credentials !== undefined,
      // Named so an audit reader can see the verification was reset without
      // having to diff two rows.
      requiresRetest: reconnects,
    },
  });
  return rows[0];
}

/**
 * Turns a connection on, or refuses.
 *
 * LEAST PRIVILEGE, ENFORCED RATHER THAN ADVISED: the only way past this is a
 * successful test. Every endpoint under the connection is still separately
 * disabled, so this grants the assistant nothing on its own.
 */
export async function enableCustomApi(
  db: Db,
  args: { actorUserId: string; connection: CustomApiConnectionRow },
): Promise<CustomApiConnectionRow> {
  if (args.connection.last_check_ok !== true) {
    throw new CustomApiInputError(
      'test the connection first. Josi will not offer an API to the assistant on the strength of a '
      + 'form somebody filled in — only on the strength of the API having answered.',
    );
  }
  const rows = await db.query<CustomApiConnectionRow>(
    `update custom_api_connections set enabled = true where id = $1 returning *`,
    [args.connection.id],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.connection_enabled',
    subjectType: 'custom_api_connection',
    subjectId: args.connection.id,
    payload: { slug: args.connection.slug },
  });
  return rows[0];
}

export async function disableCustomApi(
  db: Db,
  args: { actorUserId: string; connection: CustomApiConnectionRow },
): Promise<CustomApiConnectionRow> {
  const rows = await db.query<CustomApiConnectionRow>(
    `update custom_api_connections set enabled = false where id = $1 returning *`,
    [args.connection.id],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.connection_disabled',
    subjectType: 'custom_api_connection',
    subjectId: args.connection.id,
    payload: { slug: args.connection.slug },
  });
  return rows[0];
}

export async function deleteCustomApi(
  db: Db,
  args: { actorUserId: string; connection: CustomApiConnectionRow },
): Promise<void> {
  // The endpoints and any pending calls under it go with it, by cascade. A
  // pending write against an API that no longer exists is a request nobody
  // could honour and nobody should be asked about.
  await db.query(`delete from custom_api_connections where id = $1`, [args.connection.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.connection_deleted',
    subjectType: 'custom_api_connection',
    subjectId: args.connection.id,
    payload: { slug: args.connection.slug },
  });
}

/** The credential, for use right now. Returned to one caller, never stored
 * anywhere else, never logged, and never put in a response body. */
export function openCustomApiCredentials(key: MasterKey, row: CustomApiConnectionRow): CustomApiSecret {
  return openSealed<CustomApiSecret>(key, row.credentials_enc);
}

/**
 * Records what the last check found — whether it was the administrator's test
 * button or a call the assistant actually made.
 *
 * TWO DIFFERENT CONSEQUENCES, and the line between them is drawn on purpose:
 *
 *   * A REFUSED CREDENTIAL (401, or an expiry) switches the whole connection
 *     OFF, not merely flags it. That is stricter than the developer-service
 *     equivalent and it is the right side of the trade: there, a broken
 *     connection means one person's page says "reconnect"; here it means the
 *     assistant would go on choosing actions on an API that is rejecting this
 *     installation's credential, once per conversation, until somebody noticed.
 *   * A REFUSED REQUEST (403) marks the connection as needing attention and
 *     leaves it on. A 403 is very often about the ONE record being asked for
 *     rather than about the credential, and switching off nine working actions
 *     because the tenth touched somebody else's row would be a worse failure
 *     than the one being prevented.
 *
 * A rate limit or a transient outage changes neither: the credential is fine
 * and switching anything off would achieve nothing.
 */
export async function recordCustomApiCheck(
  db: Db,
  args: { connectionId: string; ok: boolean; category?: ErrorCategory | null },
): Promise<void> {
  const credentialRefused = args.category === 'revoked' || args.category === 'expired';
  const needsAttention = credentialRefused || args.category === 'insufficient_scope';
  await db.query(
    `update custom_api_connections set
       status = case when $2 then 'active' when $3 then 'needs_attention' else status end,
       enabled = case when $4 then false else enabled end,
       last_check_at = now(), last_check_ok = $2, last_error_category = $5
     where id = $1`,
    [
      args.connectionId, args.ok, needsAttention, credentialRefused,
      args.ok ? null : (args.category ?? 'provider_error'),
    ],
  );
}

// ---------------------------------------------------------------- endpoints

export async function listCustomApiEndpoints(db: Db, connectionId: string): Promise<CustomApiEndpointRow[]> {
  if (!UUID.test(connectionId)) return [];
  return db.query<CustomApiEndpointRow>(
    `select * from custom_api_endpoints where connection_id = $1 order by operation_id`,
    [connectionId],
  );
}

export async function customApiEndpointById(db: Db, id: string): Promise<CustomApiEndpointRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<CustomApiEndpointRow>(
    `select * from custom_api_endpoints where id = $1`, [id],
  );
  return rows[0] ?? null;
}

export interface CustomApiEndpointDraft {
  operationId: string;
  summary: string;
  method: CustomApiMethod;
  pathTemplate: string;
  parameters: CustomApiParameter[];
  acceptsBody: boolean;
  source: 'manual' | 'openapi';
}

/** Adds one allowlist row. DISABLED, always — importing a specification or
 * filling in a form proposes an action; it does not grant one. */
export async function createCustomApiEndpoint(
  db: Db,
  args: { actorUserId: string; connection: CustomApiConnectionRow; draft: CustomApiEndpointDraft },
): Promise<CustomApiEndpointRow> {
  const { draft } = args;
  const capability = customApiCapabilityForMethod(draft.method);
  // A GET with a body is not a thing this feature needs, and allowing one would
  // be an unreviewed channel into the API. The database refuses it too.
  const acceptsBody = capability === 'read' ? false : draft.acceptsBody;
  const rows = await db.query<CustomApiEndpointRow>(
    `insert into custom_api_endpoints
       (connection_id, operation_id, summary, method, path_template, capability, parameters,
        accepts_body, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      args.connection.id, draft.operationId, draft.summary, draft.method, draft.pathTemplate,
      // `json()`, never a hand-serialised string: postgres.js types a string as
      // text, so a pre-stringified array reaches jsonb as a scalar string.
      // Invisible under pglite, permanent in production.
      capability, json(draft.parameters), acceptsBody, draft.source,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.endpoint_added',
    subjectType: 'custom_api_endpoint',
    subjectId: rows[0].id,
    payload: {
      slug: args.connection.slug,
      operationId: draft.operationId,
      method: draft.method,
      capability,
      source: draft.source,
    },
  });
  return rows[0];
}

export async function updateCustomApiEndpoint(
  db: Db,
  args: {
    actorUserId: string;
    connection: CustomApiConnectionRow;
    endpoint: CustomApiEndpointRow;
    draft: CustomApiEndpointDraft;
  },
): Promise<CustomApiEndpointRow> {
  const { draft } = args;
  const capability = customApiCapabilityForMethod(draft.method);
  const acceptsBody = capability === 'read' ? false : draft.acceptsBody;
  // Editing what an action DOES takes it back off. An administrator who
  // repointed `list_customers` at a delete path would otherwise have changed
  // the meaning of a row somebody already approved of.
  const rows = await db.query<CustomApiEndpointRow>(
    `update custom_api_endpoints set
       operation_id = $2, summary = $3, method = $4, path_template = $5, capability = $6,
       parameters = $7, accepts_body = $8, enabled = false
     where id = $1
     returning *`,
    [
      args.endpoint.id, draft.operationId, draft.summary, draft.method, draft.pathTemplate,
      capability, json(draft.parameters), acceptsBody,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.endpoint_updated',
    subjectType: 'custom_api_endpoint',
    subjectId: args.endpoint.id,
    payload: {
      slug: args.connection.slug, operationId: draft.operationId,
      method: draft.method, capability,
    },
  });
  return rows[0];
}

export async function setCustomApiEndpointEnabled(
  db: Db,
  args: {
    actorUserId: string;
    connection: CustomApiConnectionRow;
    endpoint: CustomApiEndpointRow;
    enabled: boolean;
  },
): Promise<CustomApiEndpointRow> {
  const rows = await db.query<CustomApiEndpointRow>(
    `update custom_api_endpoints set enabled = $2 where id = $1 returning *`,
    [args.endpoint.id, args.enabled],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: args.enabled ? 'custom_api.endpoint_enabled' : 'custom_api.endpoint_disabled',
    subjectType: 'custom_api_endpoint',
    subjectId: args.endpoint.id,
    payload: {
      slug: args.connection.slug,
      operationId: args.endpoint.operation_id,
      method: args.endpoint.method,
      capability: args.endpoint.capability,
    },
  });
  return rows[0];
}

export async function deleteCustomApiEndpoint(
  db: Db,
  args: { actorUserId: string; connection: CustomApiConnectionRow; endpoint: CustomApiEndpointRow },
): Promise<void> {
  await db.query(`delete from custom_api_endpoints where id = $1`, [args.endpoint.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'custom_api.endpoint_deleted',
    subjectType: 'custom_api_endpoint',
    subjectId: args.endpoint.id,
    payload: { slug: args.connection.slug, operationId: args.endpoint.operation_id },
  });
}

// ------------------------------------------------------- what the model sees

export interface AvailableCustomApiAction {
  connection: CustomApiConnectionRow;
  endpoint: CustomApiEndpointRow;
}

/**
 * Every action the assistant may currently choose from: an ENABLED endpoint
 * under an ENABLED connection, and nothing else.
 *
 * Both switches are consulted in one query rather than in two places, because
 * "did we check the connection too?" is the question a second call site
 * eventually gets wrong.
 */
export async function availableCustomApiActions(db: Db): Promise<AvailableCustomApiAction[]> {
  const rows = await db.query<CustomApiEndpointRow & { c_id: string }>(
    `select e.*
       from custom_api_endpoints e
       join custom_api_connections c on c.id = e.connection_id
      where e.enabled and c.enabled
      order by c.slug, e.operation_id`,
  );
  if (!rows.length) return [];
  const connections = new Map(
    (await listCustomApis(db)).map((c) => [c.id, c] as const),
  );
  const out: AvailableCustomApiAction[] = [];
  for (const endpoint of rows) {
    const connection = connections.get(endpoint.connection_id);
    if (connection) out.push({ connection, endpoint });
  }
  return out;
}

/** One named action, re-resolved at the moment of use.
 *
 * The lookup is by (slug, operation id) against the ENABLED set, so a switch
 * flipped between the model being offered a tool and the model calling it
 * refuses — the offering is never the authority. */
export async function resolveCustomApiAction(
  db: Db,
  args: { slug: string; operationId: string },
): Promise<AvailableCustomApiAction | null> {
  const rows = await db.query<CustomApiEndpointRow>(
    `select e.*
       from custom_api_endpoints e
       join custom_api_connections c on c.id = e.connection_id
      where c.slug = $1 and e.operation_id = $2 and e.enabled and c.enabled`,
    [args.slug, args.operationId],
  );
  if (!rows.length) return null;
  const connection = await customApiById(db, rows[0].connection_id);
  return connection ? { connection, endpoint: rows[0] } : null;
}
