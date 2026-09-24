// Reading and writing contacts at Google and Microsoft.
//
// One shape in and out, two dialects underneath. Everything above this file
// works with `RemoteContact` and never learns which provider produced it,
// which is what lets the sync engine be written once.
//
// THE THREE THINGS THAT ARE EASY TO GET WRONG, and are handled here:
//
//   1. A DELETION IS A RECORD, not an absence. Both providers report deletes
//      in their incremental feed — Google as `metadata.deleted`, Microsoft as
//      `@removed` — and a reader that only looks at what is present will never
//      see one. It will then re-create everything the user deleted.
//
//   2. AN EXPIRED CURSOR IS NORMAL. Google answers 410 GONE and Microsoft
//      answers 410 with `syncStateNotFound` when a delta token has aged out.
//      That is not an error to surface; it is an instruction to read everything
//      once. Treating it as a failure means sync silently stops working after a
//      week away.
//
//   3. A PAGE IS NOT A RUN. The delta cursor arrives on the LAST page only.
//      Advancing it earlier, or losing the page cursor on a crash, skips
//      records permanently — and nothing ever notices, because the next run
//      starts after the gap.
//
// NOTHING HERE LOGS A CONTACT. Provider error bodies quote the request, and a
// request to a contacts API quotes somebody's address book.
import type { Provider } from '../capabilities.js';
import { ConnectorError, type ErrorCategory, type FetchOptions } from '../providers.js';

/** A contact as a provider describes it, reduced to what Josi stores. */
export interface RemoteContact {
  /** The provider's own stable id. Survives a rename. */
  sourceId: string;
  displayName: string | null;
  emails: string[];
  phones: string[];
  /** For a conditional write, so the provider refuses a lost update itself. */
  etag: string | null;
  updatedAt: string | null;
  /** True when this entry means "this is gone", not "this is the data". */
  deleted: boolean;
}

export interface ContactPage {
  contacts: RemoteContact[];
  /** More pages in THIS run. */
  nextPageCursor: string | null;
  /** The cursor for the NEXT run. Present on the last page only. */
  nextDeltaCursor: string | null;
  /** The provider said its cursor was too old and it has sent everything. */
  wasFullResync: boolean;
}

export interface ReadArgs {
  accessToken: string;
  /** From the previous run. Null means read everything. */
  deltaCursor?: string | null;
  /** Mid-run, from the previous page. */
  pageCursor?: string | null;
  pageSize?: number;
}

const GOOGLE_BASE = 'https://people.googleapis.com/v1';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/** The fields Josi asks for, and no more.
 *
 * Google returns exactly what `personFields` names. Asking for birthdays,
 * photos, addresses and biographies because they are available would mean
 * storing them, and Josi has nowhere to put them and no reason to hold them. */
const GOOGLE_PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,metadata';
const GRAPH_SELECT = 'id,displayName,givenName,surname,emailAddresses,homePhones,businessPhones,mobilePhone,lastModifiedDateTime';

// ------------------------------------------------------------------ shared

interface HttpResult {
  status: number;
  body: unknown;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfter: number | null;
}

async function request(
  url: string,
  init: RequestInit,
  opts: FetchOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const header = res.headers.get('retry-after');
    const retryAfter = header && /^\d+$/.test(header) ? Number(header) : null;
    return { status: res.status, body, retryAfter };
  } catch {
    throw new ConnectorError('could not reach the provider', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** A provider's short error code, if it gave one that is safe to repeat.
 *
 * Codes only — an identifier, never a sentence. A contacts API's `message`
 * field quotes the request, and the request names people. */
function safeCode(body: unknown): string | null {
  const err = (body as { error?: { status?: unknown; code?: unknown } } | null)?.error;
  for (const candidate of [err?.status, err?.code]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return null;
}

function classify(status: number, code: string | null): { category: ErrorCategory; revoked: boolean } {
  if (status === 401) return { category: 'expired', revoked: false };
  if (status === 403) {
    // Graph says `ErrorAccessDenied` for a missing scope and Google says
    // `PERMISSION_DENIED`; both mean re-consent rather than retry.
    return { category: 'insufficient_scope', revoked: false };
  }
  if (status === 429) return { category: 'rate_limited', revoked: false };
  if (code === 'invalid_grant') return { category: 'revoked', revoked: true };
  return { category: 'provider_error', revoked: false };
}

export class ExpiredCursor extends Error {}

function raise(status: number, body: unknown, retryAfter?: number | null): never {
  const code = safeCode(body);
  const { category, revoked } = classify(status, code);
  const err = new ConnectorError(
    code ? `the provider refused the request (${code})` : 'the provider refused the request',
    { category, revoked, status },
  );
  err.retryAfterSeconds = retryAfter ?? undefined;
  throw err;
}

/** Providers signal a too-old cursor with 410, and it is not a failure.
 *
 * Google: 410 with `EXPIRED` / `FAILED_PRECONDITION` on an old syncToken.
 * Microsoft: 410 with `syncStateNotFound` on an old deltaLink.
 *
 * The right response to both is to forget the cursor and read everything once.
 * Surfacing it as an error is how sync quietly stops working after a week. */
function isExpiredCursor(status: number, body: unknown): boolean {
  if (status !== 410) return false;
  const code = (safeCode(body) ?? '').toLowerCase();
  return code === '' || /expired|failed_precondition|syncstatenotfound|resyncrequired/.test(code);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const uniqueStrings = (values: Array<string | null>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

// ------------------------------------------------------------------- Google

interface GooglePerson {
  resourceName?: unknown;
  etag?: unknown;
  metadata?: { deleted?: unknown; sources?: Array<{ updateTime?: unknown }> };
  names?: Array<{ displayName?: unknown }>;
  emailAddresses?: Array<{ value?: unknown }>;
  phoneNumbers?: Array<{ value?: unknown }>;
}

function fromGoogle(person: GooglePerson): RemoteContact | null {
  const sourceId = str(person.resourceName);
  if (!sourceId) return null;
  return {
    sourceId,
    displayName: str(person.names?.[0]?.displayName),
    emails: uniqueStrings((person.emailAddresses ?? []).map((e) => str(e?.value))),
    phones: uniqueStrings((person.phoneNumbers ?? []).map((p) => str(p?.value))),
    etag: str(person.etag),
    updatedAt: str(person.metadata?.sources?.[0]?.updateTime),
    deleted: person.metadata?.deleted === true,
  };
}

async function readGoogle(args: ReadArgs, opts: FetchOptions): Promise<ContactPage> {
  const params = new URLSearchParams({
    personFields: GOOGLE_PERSON_FIELDS,
    pageSize: String(args.pageSize ?? 200),
    // Asked for on every request. Google only returns one on the last page,
    // and only if it was requested on every page of the run.
    requestSyncToken: 'true',
  });
  if (args.pageCursor) params.set('pageToken', args.pageCursor);
  else if (args.deltaCursor) params.set('syncToken', args.deltaCursor);

  const result = await request(
    `${GOOGLE_BASE}/people/me/connections?${params}`,
    { headers: { Authorization: `Bearer ${args.accessToken}` } },
    opts,
  );

  if (isExpiredCursor(result.status, result.body)) throw new ExpiredCursor('syncToken expired');
  if (result.status < 200 || result.status >= 300) raise(result.status, result.body, result.retryAfter);

  const body = result.body as {
    connections?: GooglePerson[];
    nextPageToken?: unknown;
    nextSyncToken?: unknown;
  } | null;

  return {
    contacts: (body?.connections ?? []).map(fromGoogle).filter(Boolean) as RemoteContact[],
    nextPageCursor: str(body?.nextPageToken),
    nextDeltaCursor: str(body?.nextSyncToken),
    wasFullResync: !args.deltaCursor && !args.pageCursor,
  };
}

// ---------------------------------------------------------------- Microsoft

interface GraphContact {
  id?: unknown;
  '@odata.etag'?: unknown;
  '@removed'?: unknown;
  displayName?: unknown;
  givenName?: unknown;
  surname?: unknown;
  lastModifiedDateTime?: unknown;
  emailAddresses?: Array<{ address?: unknown }>;
  homePhones?: unknown[];
  businessPhones?: unknown[];
  mobilePhone?: unknown;
}

function fromGraph(contact: GraphContact): RemoteContact | null {
  const sourceId = str(contact.id);
  if (!sourceId) return null;
  // Graph may omit displayName on a contact created by another client, so the
  // name is assembled from the parts rather than left null.
  const name = str(contact.displayName)
    ?? (str([str(contact.givenName), str(contact.surname)].filter(Boolean).join(' ')));
  return {
    sourceId,
    displayName: name,
    emails: uniqueStrings((contact.emailAddresses ?? []).map((e) => str(e?.address))),
    phones: uniqueStrings([
      ...(contact.businessPhones ?? []).map(str),
      ...(contact.homePhones ?? []).map(str),
      str(contact.mobilePhone),
    ]),
    etag: str(contact['@odata.etag']),
    updatedAt: str(contact.lastModifiedDateTime),
    // Graph reports a delete as an entry carrying only an id and `@removed`.
    deleted: contact['@removed'] !== undefined && contact['@removed'] !== null,
  };
}

async function readMicrosoft(args: ReadArgs, opts: FetchOptions): Promise<ContactPage> {
  // Graph hands back complete URLs for both cursors. They are used verbatim
  // rather than rebuilt: a reconstructed delta link is a delta link that
  // silently loses its state parameters.
  let url: string;
  if (args.pageCursor) url = args.pageCursor;
  else if (args.deltaCursor) url = args.deltaCursor;
  else url = `${GRAPH_BASE}/me/contacts/delta?$select=${encodeURIComponent(GRAPH_SELECT)}`;

  if (!url.startsWith(GRAPH_BASE)) {
    // A cursor is a URL we will call with a bearer token attached. One that
    // came back pointing somewhere else is not a cursor.
    throw new ConnectorError('the provider returned a cursor that is not a Microsoft Graph address', {
      category: 'provider_error',
    });
  }

  const result = await request(
    url,
    {
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        // Ask Graph to page rather than to stream everything at once.
        Prefer: `odata.maxpagesize=${args.pageSize ?? 200}`,
      },
    },
    opts,
  );

  if (isExpiredCursor(result.status, result.body)) throw new ExpiredCursor('deltaLink expired');
  if (result.status < 200 || result.status >= 300) raise(result.status, result.body, result.retryAfter);

  const body = result.body as {
    value?: GraphContact[];
    '@odata.nextLink'?: unknown;
    '@odata.deltaLink'?: unknown;
  } | null;

  return {
    contacts: (body?.value ?? []).map(fromGraph).filter(Boolean) as RemoteContact[],
    nextPageCursor: str(body?.['@odata.nextLink']),
    nextDeltaCursor: str(body?.['@odata.deltaLink']),
    wasFullResync: !args.deltaCursor && !args.pageCursor,
  };
}

// -------------------------------------------------------------------- read

/** One page of contacts from either provider. */
export async function readContactPage(
  provider: Provider,
  args: ReadArgs,
  opts: FetchOptions = {},
): Promise<ContactPage> {
  return provider === 'google' ? readGoogle(args, opts) : readMicrosoft(args, opts);
}

/** How long to wait before trying again, in milliseconds.
 *
 * Honours the provider's own `Retry-After` when it gave one, because a
 * provider that says "wait 30 seconds" and is retried in two is a provider
 * that starts refusing for longer. Exponential otherwise, capped so a
 * background job cannot sleep for an hour. */
export function backoffMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, 300_000);
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

// ------------------------------------------------------------------- write

export interface WriteArgs {
  accessToken: string;
  displayName: string | null;
  emails: string[];
  phones: string[];
  /** Present for an update; absent creates. */
  sourceId?: string | null;
  /** Sent as a precondition so the PROVIDER refuses a lost update. */
  etag?: string | null;
}

/** Create or update a contact at the provider. Two-way mode only. */
export async function writeContact(
  provider: Provider,
  args: WriteArgs,
  opts: FetchOptions = {},
): Promise<RemoteContact> {
  return provider === 'google' ? writeGoogle(args, opts) : writeMicrosoft(args, opts);
}

async function writeGoogle(args: WriteArgs, opts: FetchOptions): Promise<RemoteContact> {
  const person: Record<string, unknown> = {
    names: args.displayName ? [{ displayName: args.displayName, unstructuredName: args.displayName }] : [],
    emailAddresses: args.emails.map((value) => ({ value })),
    phoneNumbers: args.phones.map((value) => ({ value })),
  };

  let url: string;
  let method: string;
  if (args.sourceId) {
    // updatePersonFields names exactly what may be overwritten. Without it the
    // API refuses; with too much in it, fields Josi does not manage are wiped.
    const params = new URLSearchParams({ updatePersonFields: 'names,emailAddresses,phoneNumbers' });
    url = `${GOOGLE_BASE}/${args.sourceId}:updateContact?${params}`;
    method = 'PATCH';
    // Google's conditional update: the etag travels in the body.
    if (args.etag) person.etag = args.etag;
  } else {
    url = `${GOOGLE_BASE}/people:createContact?personFields=${GOOGLE_PERSON_FIELDS}`;
    method = 'POST';
  }

  const result = await request(url, {
    method,
    headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(person),
  }, opts);

  if (result.status < 200 || result.status >= 300) raise(result.status, result.body, result.retryAfter);
  const written = fromGoogle((result.body ?? {}) as GooglePerson);
  if (!written) throw new ConnectorError('the provider accepted the write but returned no contact', { category: 'provider_error' });
  return written;
}

async function writeMicrosoft(args: WriteArgs, opts: FetchOptions): Promise<RemoteContact> {
  const payload: Record<string, unknown> = {
    displayName: args.displayName,
    emailAddresses: args.emails.map((address) => ({ address, name: args.displayName ?? address })),
    businessPhones: args.phones.slice(0, 2),
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${args.accessToken}`,
    'Content-Type': 'application/json',
  };
  // Graph's conditional update is a header, and without it a PATCH silently
  // overwrites whatever changed since we read it.
  if (args.sourceId && args.etag) headers['If-Match'] = args.etag;

  const result = await request(
    args.sourceId ? `${GRAPH_BASE}/me/contacts/${encodeURIComponent(args.sourceId)}` : `${GRAPH_BASE}/me/contacts`,
    { method: args.sourceId ? 'PATCH' : 'POST', headers, body: JSON.stringify(payload) },
    opts,
  );

  if (result.status === 412) {
    // The provider refused because the record moved under us. That is the
    // precondition working, and it is a conflict rather than an error.
    throw new ConnectorError('the contact changed at the provider since Josi last read it', {
      category: 'provider_error', status: 412,
    });
  }
  if (result.status < 200 || result.status >= 300) raise(result.status, result.body, result.retryAfter);
  const written = fromGraph((result.body ?? {}) as GraphContact);
  if (!written) throw new ConnectorError('the provider accepted the write but returned no contact', { category: 'provider_error' });
  return written;
}
