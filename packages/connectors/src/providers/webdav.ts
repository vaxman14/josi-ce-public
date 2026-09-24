// Reading files and folders at a self-hosted Nextcloud, over WebDAV.
//
// This is NOT one of the four OAuth dialects in files.ts. Nextcloud has no
// central application to register — a self-hosted install has no console to
// register one WITH — so the standard integration pattern (and the one this
// mirrors) is WebDAV plus an app password the person generates in their own
// Nextcloud account under Settings → Security → "Devices & sessions". That
// password is sent as HTTP Basic auth on every request, sealed at rest
// exactly like an OAuth refresh token (see `NextcloudCredentials` in
// connections.ts), and never logged.
//
// READ-ONLY BY CONSTRUCTION, same as files.ts: PROPFIND to list, GET to
// download. No PUT, MOVE, DELETE or MKCOL anywhere in this file.
//
// NOTHING HERE LOGS A FILE OR A SERVER RESPONSE BODY. A WebDAV error body can
// quote a filename in the same way a REST API's does; failures become a
// CATEGORY exactly as everywhere else in this package.
import { ConnectorError, type ErrorCategory, type FetchOptions } from '../providers.js';
import { FileTooLarge, type EntryPage, type ListArgs, type RemoteEntry } from './files.js';

// Re-exported so a caller that only imports from webdav.ts can still catch it
// without a second import from files.ts — the same FileTooLarge class, not a
// look-alike: `downloadWebdavFile` throws the one imported above.
export { FileTooLarge };

export interface WebdavCredentials {
  /** As the person typed it. Normalised (scheme required, no trailing slash)
   * by `normalizeServerUrl` before it is stored. */
  serverUrl: string;
  username: string;
  appPassword: string;
}

/** Turns what a person types into a comparable, request-ready origin.
 *
 * Accepts "cloud.example.com", "https://cloud.example.com/", and
 * "https://cloud.example.com/nextcloud" (a sub-path install, which is common
 * behind a reverse proxy) and produces exactly one canonical form. Refuses
 * anything that is not http(s) — a `file:` or `javascript:` URL typed into
 * this field is a request smuggled to a scheme this client never intended to
 * speak, not a Nextcloud server. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  // A scheme is prefixed ONLY when none is present at all. Checking for
  // "starts with http(s)://" and prefixing https:// otherwise was the bug
  // here first: "file:///etc/passwd" does not start with http(s)://, so it
  // would have been turned into "https://file:///etc/passwd" — a URL whose
  // protocol IS https, whose host is the literal string "file", and which
  // sails straight through the protocol check below. Detecting ANY scheme
  // (`^[a-z][a-z0-9+.-]*:`) rather than only the one this function was about
  // to add is what closes that gap.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ConnectorError('that is not a web address', { category: 'provider_error' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectorError('the server address must be http or https', { category: 'provider_error' });
  }
  // No query, no fragment, no credentials embedded in the URL itself — the
  // password field is where a credential belongs, not smuggled into the host
  // the way "https://user:pass@host" would.
  if (url.username || url.password) {
    throw new ConnectorError('do not put a username or password in the server address', {
      category: 'provider_error',
    });
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Where WebDAV lives under a Nextcloud origin. Fixed by Nextcloud itself,
 * not configurable — every Nextcloud install answers WebDAV at this path for
 * its own users. */
function davRoot(serverUrl: string, username: string): string {
  return `${serverUrl}/remote.php/dav/files/${encodeURIComponent(username)}`;
}

/** A WebDAV path, as this client hands one to itself between calls.
 *
 * Always begins with "/", is relative to the user's DAV root (never the
 * server root), and — same rule as every other containment check in this
 * codebase — is refused if it contains a traversal segment or a NUL byte
 * rather than trusted to resolve safely on the server end. Nextcloud's own
 * server-side containment is not a reason to skip this: a path built from a
 * corrupted database row should be refused here, before it reaches a request. */
export function assertWebdavPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new ConnectorError('that is not a folder or file path this provider issues', {
      category: 'provider_error',
    });
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new ConnectorError('that is not a folder or file path this provider issues', {
      category: 'provider_error',
    });
  }
  return path;
}

function basicAuthHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString('base64')}`;
}

function classify(status: number): { category: ErrorCategory; revoked: boolean } {
  // WebDAV speaks in plain HTTP status codes, not a JSON error envelope —
  // there is no provider-specific error code to fold in here the way Google's
  // `invalid_grant` or Box's numeric codes are.
  if (status === 401) return { category: 'expired', revoked: false };
  if (status === 403) return { category: 'insufficient_scope', revoked: false };
  if (status === 429) return { category: 'rate_limited', revoked: false };
  return { category: 'provider_error', revoked: false };
}

function raise(status: number): never {
  const { category, revoked } = classify(status);
  throw new ConnectorError('the server refused the request', { category, revoked, status });
}

// -------------------------------------------------------------- PROPFIND

/** The XML this client sends. Depth 1, and exactly the four properties Josi
 * uses — the same "ask for what you use, not what is available" discipline
 * as the Drive `fields` parameter and the Graph `$select`. */
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:displayname/>
  </d:prop>
</d:propfind>`;

interface DavResponseNode {
  href: string;
  isCollection: boolean;
  contentLength: number;
  lastModified: string | null;
  displayName: string | null;
}

/** A minimal, dependency-free WebDAV multistatus reader.
 *
 * No XML library: the response shape from `remote.php/dav` is narrow and
 * well-known, and adding an XML parser dependency to read four fixed
 * properties is more supply chain than four regular expressions earn back.
 * Each `<d:response>` element is extracted, then its four properties inside
 * it — deliberately NOT a single global regex over the whole body, which
 * would confuse one file's `<d:href>` with another's. */
function parseMultistatus(xml: string): DavResponseNode[] {
  const responses: DavResponseNode[] = [];
  const responseBlocks = xml.match(/<d:response>[\s\S]*?<\/d:response>/gi)
    ?? xml.match(/<response[^>]*>[\s\S]*?<\/response>/gi)
    ?? [];
  for (const block of responseBlocks) {
    const href = matchTag(block, 'href');
    if (!href) continue;
    const isCollection = /<d:collection\s*\/>|<collection\s*\/>/i.test(block);
    const contentLength = Number(matchTag(block, 'getcontentlength') ?? '0') || 0;
    const lastModified = matchTag(block, 'getlastmodified');
    const displayName = matchTag(block, 'displayname');
    responses.push({
      href: decodeURIComponent(href),
      isCollection,
      contentLength,
      lastModified,
      displayName,
    });
  }
  return responses;
}

function matchTag(block: string, tag: string): string | null {
  const m = new RegExp(`<(?:d:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:d:)?${tag}>`, 'i').exec(block);
  const value = m?.[1]?.trim();
  return value ? value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : null;
}

/** One PROPFIND, depth 1, over the given path relative to the user's DAV
 * root. WebDAV has no cursor-based paging the way Drive or Graph do — a
 * Nextcloud folder is read in one request, and the folder-count ceilings
 * (`archive_max_entries`-style limits at the storage-policy level, and the
 * sync walk's own `maxEntries` bound) are what keep an enormous folder from
 * becoming an enormous response. */
export async function listWebdavFolder(
  creds: WebdavCredentials,
  args: { path: string },
  opts: FetchOptions = {},
): Promise<EntryPage> {
  const path = assertWebdavPath(args.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${davRoot(creds.serverUrl, creds.username)}${path}`, {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuthHeader(creds.username, creds.appPassword),
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      signal: controller.signal,
    });
  } catch {
    throw new ConnectorError('could not reach the server', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }

  // 207 Multi-Status is WebDAV's success code for PROPFIND, not 200.
  if (res.status !== 207) raise(res.status);
  const xml = await res.text().catch(() => '');
  const nodes = parseMultistatus(xml);

  // The FIRST response describes the folder being listed, not a child of it —
  // WebDAV's own convention, mirrored by every client. Skipped here so the
  // folder does not appear as an entry inside itself.
  const [self, ...children] = nodes;
  const selfHref = self ? decodeURIComponent(self.href).replace(/\/+$/, '') : null;

  const entries: RemoteEntry[] = [];
  for (const node of children) {
    const href = node.href.replace(/\/+$/, '');
    if (selfHref && href === selfHref) continue;
    const name = node.displayName ?? href.slice(href.lastIndexOf('/') + 1);
    if (!name) continue;
    const relPath = webdavRelativePath(creds, href);
    if (relPath === null) continue;
    entries.push({
      sourceId: relPath,
      name: decodeURIComponent(name),
      folder: node.isCollection,
      byteSize: node.contentLength,
      modifiedAt: node.lastModified ? new Date(node.lastModified).toISOString() : null,
      exportMime: null,
      exportExtension: null,
      unreadable: false,
    });
  }
  // No paging: everything came back in this one response.
  return { entries, nextPageCursor: null };
}

/** The href WebDAV returns is server-absolute (e.g.
 * "/remote.php/dav/files/roman/Documents/notes.txt"); everything above this
 * file works in DAV-root-relative paths ("/Documents/notes.txt"), the same
 * shape `assertWebdavPath` checks. Returns null for an href outside the
 * expected DAV root rather than guessing — a server proxying or rewriting
 * paths unexpectedly should produce a skipped entry, not a wrong one. */
function webdavRelativePath(creds: WebdavCredentials, href: string): string | null {
  const rootPath = new URL(davRoot(creds.serverUrl, creds.username)).pathname.replace(/\/+$/, '');
  if (!href.startsWith(rootPath)) return null;
  const rel = href.slice(rootPath.length);
  return rel.startsWith('/') ? rel : `/${rel}`;
}

/** The bytes of one file, bounded — same late-check-after-transfer shape as
 * `downloadEntry` in files.ts, for the same reason: simplicity, with the
 * ceiling enforced once the provider's own answer is in hand. */
export async function downloadWebdavFile(
  creds: WebdavCredentials,
  args: { entry: RemoteEntry; maxBytes: number },
  opts: FetchOptions = {},
): Promise<Buffer> {
  const path = assertWebdavPath(args.entry.sourceId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${davRoot(creds.serverUrl, creds.username)}${path}`, {
      method: 'GET',
      headers: { Authorization: basicAuthHeader(creds.username, creds.appPassword) },
      signal: controller.signal,
    });
  } catch {
    throw new ConnectorError('could not reach the server', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
  if (res.status !== 200) raise(res.status);
  const raw = await res.arrayBuffer().catch(() => null);
  if (!raw) raise(502);
  if (raw.byteLength > args.maxBytes) throw new FileTooLarge('larger than the configured ceiling');
  return Buffer.from(raw);
}

/** Verifies a credential actually works, at connect time — a PROPFIND on the
 * user's DAV root with Depth 0. Used only by the connect flow, not the sync
 * engine: this is the one place Josi checks a Nextcloud credential BEFORE
 * storing it, the WebDAV equivalent of the OAuth identity call every other
 * provider makes during its handshake. */
export async function verifyWebdavCredentials(
  creds: WebdavCredentials,
  opts: FetchOptions = {},
): Promise<{ ok: true } | { ok: false; category: ErrorCategory }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(davRoot(creds.serverUrl, creds.username), {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuthHeader(creds.username, creds.appPassword),
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
      signal: controller.signal,
    });
    if (res.status === 207) return { ok: true };
    return { ok: false, category: classify(res.status).category };
  } catch {
    return { ok: false, category: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** ListArgs's `folderId` doubles as the WebDAV path for this provider,
 * exactly the way Dropbox's file adapter reuses the same field for a path
 * instead of an opaque id. 'root' becomes the DAV root itself. */
export function webdavPathFromFolderId(folderId: string): string {
  return folderId === 'root' ? '/' : assertWebdavPath(folderId);
}

/** The facade shape the storage sync engine calls through, matching
 * `listFolderPage`/`downloadEntry` in files.ts closely enough that the walk
 * in storageSync.ts can treat Nextcloud as one more entry in a lookup table
 * rather than a parallel code path with its own duplicated walk logic.
 *
 * Deliberately NOT typed as the full `ListArgs` from files.ts — that shape
 * carries an `accessToken` every OAuth adapter needs and WebDAV does not: the
 * credential here is HTTP Basic auth, sent by `listWebdavFolder` itself, not
 * threaded through per call the way a bearer token is. A caller that reaches
 * for `args.accessToken` on a Nextcloud session is reaching for something
 * that was never there, and the narrower type is what makes that a compile
 * error instead of `undefined` silently reaching a header. */
export async function listNextcloudFolder(
  creds: WebdavCredentials,
  args: { folderId: string; pageCursor?: string | null },
  opts: FetchOptions = {},
): Promise<EntryPage> {
  return listWebdavFolder(creds, { path: webdavPathFromFolderId(args.folderId) }, opts);
}

export async function downloadNextcloudEntry(
  creds: WebdavCredentials,
  args: { entry: RemoteEntry; maxBytes: number },
  opts: FetchOptions = {},
): Promise<Buffer> {
  return downloadWebdavFile(creds, args, opts);
}
