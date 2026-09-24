// Syncing one mapped cloud folder into the document index.
//
// This is the cloud half of Phase 9's ingestion, built on the spine that
// already exists: `folder_mappings` (the grant), the ingest gates (untrusted
// bytes), `document_text`/`document_segments` (what search reads), and
// `sync_state` (health and pacing). Nothing here invents a parallel pipeline —
// a cloud file goes through exactly the gates a local file would.
//
// THE RULES, in the order they cost something when wrong:
//
//   1. THE OWNER COMES FROM THE MAPPING, never from a payload. A forged job id
//      can only sync a mapping that already exists, for its own owner, through
//      its owner's own connection.
//   2. CAPABILITY IS CHECKED AT THE MOMENT OF USE. A scope revoked at the
//      provider since the folder was mapped pauses the mapping; it does not
//      get discovered halfway through a download.
//   3. A FILE GONE AT THE PROVIDER GOES FROM THE INDEX. The removal pass runs
//      only after a COMPLETE walk — a truncated listing must never be read as
//      "everything else was deleted".
//   4. FAILURE IS A STATUS, NOT A THROW. A revoked grant, an expired token, a
//      rate limit: each becomes a category on `sync_state` the owner can act
//      on, and `recordSyncFailure` pauses the mapping when retrying cannot fix
//      it (M78). A background job that throws is a failure nobody sees.
//
// Full re-list rather than provider delta feeds, deliberately, for this round:
// Google's changes API is drive-wide — watching it would mean receiving events
// about files far outside the folder that was consented to — and one listing
// path shared by every provider is one path whose removal semantics are
// testable. Listings are bounded by the per-user file ceilings that already
// exist. Graph's per-folder delta is a candidate optimisation for later.
//
// FIVE PROVIDERS, ONE WALK. Google, Microsoft, Dropbox and Box share an OAuth
// bearer token acquired through `accessTokenFor`; Nextcloud shares a WebDAV
// app password acquired through `nextcloudCredentialsFor`. `openRemoteSession`
// is the one place that difference is resolved — everything below it, the walk
// and the ingest, calls `session.list` / `session.download` and does not learn
// which of the two a mapping's provider actually is.
import { appendEvent, SealingError, type Db, type MasterKey } from '@josi-ce/core';
import {
  ScanBlocked, ceilingsFor, extractRichSegments, ingestFile, looksEncrypted, looksLikeCredentialFile,
  recordSyncFailure, sha256, skipDocument,
  storagePolicy, storeExtraction, usageFor, type Scanner, type StoragePolicy,
} from '@josi-ce/storage';
import { NEXTCLOUD_STORAGE_CAPABILITY, STORAGE_CAPABILITY, isOAuthProvider, type OAuthProvider, type Provider } from './capabilities.js';
import {
  accessTokenFor, can, getConnection, nextcloudCredentialsFor, type ConnectionRow,
} from './connections.js';
import { loadClient } from './oauthClients.js';
import { ConnectorError, type ErrorCategory, type FetchOptions, type OAuthClient } from './providers.js';
import { FileTooLarge, downloadEntry, listFolderPage, type EntryPage, type RemoteEntry } from './providers/files.js';
import {
  downloadNextcloudEntry, listNextcloudFolder, type WebdavCredentials,
} from './providers/webdav.js';

export interface CloudSyncCounts {
  indexed: number;
  skipped: number;
  unchanged: number;
  removed: number;
  seen: number;
}

export type CloudSyncStatus =
  /** Ran to the end. Counts are the whole story. */
  | 'synced'
  /** Nothing to do: mapping gone, revoked, paused, or indexing off. */
  | 'nothing_to_sync'
  /** Failed with a category recorded on sync_state; possibly paused (M78). */
  | 'failed';

export interface CloudSyncResult {
  status: CloudSyncStatus;
  counts: CloudSyncCounts;
  /** Set when status is 'failed'. */
  errorCategory?: 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied' | 'unknown';
}

export interface CloudSyncOptions extends FetchOptions {
  masterKey: MasterKey;
  /** Injected when ClamAV is deployed; ingest refuses to proceed without one
   * when policy requires scanning, which is the honest outage behaviour. */
  scanner?: Scanner;
  /** Bounds one run. A walk that would page forever never finishes and never
   * reports. The bound refusing the REMOVAL pass is what keeps it safe. */
  maxEntries?: number;
}

const emptyCounts = (): CloudSyncCounts => ({ indexed: 0, skipped: 0, unchanged: 0, removed: 0, seen: 0 });

interface CloudMappingRow {
  id: string;
  owner_user_id: string;
  provider: 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'nextcloud';
  connection_id: string;
  remote_folder_id: string;
  recursive: boolean;
  indexing_enabled: boolean;
  status: string;
}

/** folder_mappings.provider speaks in folders; connections speak in accounts. */
const CONNECTION_PROVIDER: Record<CloudMappingRow['provider'], Provider> = {
  google_drive: 'google',
  onedrive: 'microsoft',
  dropbox: 'dropbox',
  box: 'box',
  nextcloud: 'nextcloud',
};

/** The capability a mapping's provider needs, whichever of the five it is.
 * OAuth providers look it up in `STORAGE_CAPABILITY`; Nextcloud, not being an
 * OAuth provider, has its own named constant instead — see the comment on
 * `NEXTCLOUD_STORAGE_CAPABILITY` in capabilities.ts for why it cannot live in
 * the same table. */
function storageCapabilityFor(provider: Provider): string {
  return isOAuthProvider(provider) ? STORAGE_CAPABILITY[provider] : NEXTCLOUD_STORAGE_CAPABILITY;
}

/** What the walk and the ingest actually need: something that lists a folder
 * page and downloads an entry, regardless of what sits underneath. Built once
 * per sync run by `openRemoteSession`, so a fresh OAuth token is still fetched
 * per PAGE (accessTokenFor's own 60-second-margin refresh, preserved exactly)
 * while a Nextcloud credential — which does not expire on a clock — is opened
 * once and reused for the whole run. */
interface RemoteSession {
  list(args: { folderId: string; pageCursor?: string | null }, opts: FetchOptions): Promise<EntryPage>;
  download(args: { entry: RemoteEntry; maxBytes: number }, opts: FetchOptions): Promise<Buffer>;
}

function oauthSession(
  db: Db, masterKey: MasterKey, connection: ConnectionRow, client: OAuthClient, provider: OAuthProvider,
): RemoteSession {
  return {
    async list(args, opts) {
      // A fresh token per page costs one clock check; a token that expires
      // mid-walk costs the whole run. Unchanged from the Drive/OneDrive round.
      const accessToken = await accessTokenFor(db, masterKey, { connection, client }, opts);
      return listFolderPage(provider, { accessToken, folderId: args.folderId, pageCursor: args.pageCursor }, opts);
    },
    async download(args, opts) {
      const accessToken = await accessTokenFor(db, masterKey, { connection, client }, opts);
      return downloadEntry(provider, { accessToken, entry: args.entry, maxBytes: args.maxBytes }, opts);
    },
  };
}

function nextcloudSession(creds: WebdavCredentials): RemoteSession {
  return {
    list: (args, opts) => listNextcloudFolder(creds, args, opts),
    download: (args, opts) => downloadNextcloudEntry(creds, args, opts),
  };
}

/** Opens whichever session this mapping's provider needs. The one place in
 * the whole sync engine that asks "is this OAuth or WebDAV" — everywhere else
 * calls `session.list` / `session.download` without knowing. */
async function openRemoteSession(
  db: Db,
  masterKey: MasterKey,
  connection: ConnectionRow,
  provider: Provider,
  opts: FetchOptions,
): Promise<RemoteSession> {
  if (isOAuthProvider(provider)) {
    const client = await loadClient(db, masterKey, provider);
    return oauthSession(db, masterKey, connection, client, provider);
  }
  const creds = await nextcloudCredentialsFor(db, masterKey, connection);
  return nextcloudSession(creds);
}

/** A remote name made safe as one path segment.
 *
 * The database refuses `..` and absolute paths outright (0007's constraints),
 * so a name a provider allows that ours does not becomes a defanged lookalike
 * rather than a refusal — the file is still the owner's, still indexed, still
 * findable by the rest of its name. */
export function sanitizeRemoteName(name: string): string {
  let safe = name.replace(/[/\\\u0000]/g, '_').trim();
  while (safe.includes('..')) safe = safe.replace(/\.\./g, '._');
  return safe || '_';
}

/** What this entry is called in Josi's index. Google-native documents carry
 * the EXPORTED format's extension, so the gates and the extractor agree on
 * what the bytes will be. */
function effectiveName(entry: RemoteEntry): string {
  const safe = sanitizeRemoteName(entry.name);
  if (!entry.exportExtension) return safe;
  return safe.toLowerCase().endsWith(`.${entry.exportExtension}`)
    ? safe
    : `${safe}.${entry.exportExtension}`;
}

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

// ------------------------------------------------------------- scheduling

/** Cloud mappings whose turn has come. Excludes everything the run itself
 * would refuse — paused installations, paused mappings, indexing off — so the
 * worker does not enqueue jobs whose whole outcome is "nothing to do". */
export async function dueCloudMappings(db: Db, limit = 20): Promise<Array<{ id: string }>> {
  return db.query<{ id: string }>(
    `select m.id from folder_mappings m
     left join sync_state s on s.mapping_id = m.id
     where m.provider <> 'local'
       and m.status = 'active'
       and m.indexing_enabled = true
       and (s.next_sync_after is null or s.next_sync_after <= now())
       and not (select processing_paused from storage_policy where id = true)
     order by s.next_sync_after asc nulls first
     limit $1`,
    [limit],
  );
}

/** Stamped BEFORE the job runs — the same crash rule as contact sync's
 * markAttempted: a worker that dies mid-run must cost this mapping its turn,
 * not repeat the crash as fast as the queue can loop. */
export async function markSyncScheduled(db: Db, mappingId: string): Promise<void> {
  const [policy] = await db.query<{ cloud_sync_minutes: number }>(
    `select cloud_sync_minutes from storage_policy where id = true`,
  );
  const [mapping] = await db.query<{ owner_user_id: string }>(
    `select owner_user_id from folder_mappings where id = $1`, [mappingId],
  );
  if (!mapping) return;
  await db.query(
    `insert into sync_state (mapping_id, owner_user_id, next_sync_after)
     values ($1, $2, now() + make_interval(mins => $3))
     on conflict (mapping_id) do update set
       next_sync_after = now() + make_interval(mins => $3)`,
    [mappingId, mapping.owner_user_id, policy?.cloud_sync_minutes ?? 15],
  );
}

// ------------------------------------------------------------------ the run

export async function syncCloudMapping(
  db: Db,
  mappingId: string,
  opts: CloudSyncOptions,
): Promise<CloudSyncResult> {
  const [mapping] = await db.query<CloudMappingRow>(
    `select id, owner_user_id, provider, connection_id, remote_folder_id,
            recursive, indexing_enabled, status
     from folder_mappings where id = $1 and provider <> 'local'`,
    [mappingId],
  );
  // Gone, paused, revoked, or never consented to indexing: nothing to sync,
  // and honestly nothing — not an error. M49: a mapped folder without the
  // indexing consent is opened on request, never read in bulk.
  if (!mapping || mapping.status !== 'active' || !mapping.indexing_enabled) {
    return { status: 'nothing_to_sync', counts: emptyCounts() };
  }

  const policy = await storagePolicy(db);
  if (policy.processing_paused) return { status: 'nothing_to_sync', counts: emptyCounts() };

  const connection = await getConnection(db, mapping.connection_id);
  if (!connection || connection.status !== 'active') {
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category: 'token_expired',
    });
    return { status: 'failed', counts: emptyCounts(), errorCategory: 'token_expired' };
  }

  // Rule 2: the capability, at the moment of use. The admin ceiling and the
  // owner's own switch both still count — a connection whose owner turned the
  // capability off after mapping stops syncing, exactly as it should.
  //
  // A provider this deployment does not implement yet (the DB's
  // `folder_mappings_provider_check` allows more values than this file's
  // `CONNECTION_PROVIDER` map does — see the 2026-09 storage-sync diagnostic
  // note below) must NOT be allowed to fall through into the capability
  // check: `CONNECTION_PROVIDER[mapping.provider]` would be `undefined`,
  // `STORAGE_CAPABILITY[undefined]` would be `undefined`, and `can()` would
  // deny it — recording 'permission_denied' against a connection whose scopes
  // are perfectly healthy. That mislabels a deployment gap as the owner's
  // problem. Caught here, by name, as its own honest category instead.
  const provider = CONNECTION_PROVIDER[mapping.provider];
  if (!provider) {
    console.error(
      `[storage.sync] mapping ${mapping.id} has provider '${mapping.provider}', which this deployment's `
      + `connectors package does not implement (CONNECTION_PROVIDER has no entry for it). The database `
      + `allows this provider value but the code running here predates it. Likely cause: a migration that `
      + `widens folder_mappings_provider_check landed without the matching application code being deployed.`,
    );
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category: 'unreachable',
    });
    return { status: 'failed', counts: emptyCounts(), errorCategory: 'unreachable' };
  }
  const allowed = await can(db, {
    ownerUserId: mapping.owner_user_id, capability: storageCapabilityFor(provider),
  });
  if (!allowed.allowed) {
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category: 'permission_denied',
    });
    return { status: 'failed', counts: emptyCounts(), errorCategory: 'permission_denied' };
  }

  const counts = emptyCounts();
  try {
    const session = await openRemoteSession(db, opts.masterKey, connection, provider, opts);
    const walk = await walkAndIngest(db, { mapping, session, policy, counts }, opts);

    // Rule 3: removal only after a COMPLETE walk.
    if (walk.complete) {
      counts.removed = await removeUnseen(db, mapping.id, walk.seenPaths);
    }

    await db.query(
      `insert into sync_state (mapping_id, owner_user_id, last_sync_at, consecutive_failures, last_error_category)
       values ($1, $2, now(), 0, null)
       on conflict (mapping_id) do update set
         last_sync_at = now(), consecutive_failures = 0, last_error_category = null`,
      [mapping.id, mapping.owner_user_id],
    );
    await appendEvent(db, {
      actorUserId: mapping.owner_user_id,
      actor: 'system',
      kind: 'storage.synced',
      subjectType: 'folder_mapping',
      subjectId: mapping.id,
      // Counts, never a filename.
      payload: { provider: mapping.provider, ...counts, complete: walk.complete },
    });
    return { status: 'synced', counts };
  } catch (err) {
    const category = failureCategory(err);
    // THE 2026-09 STORAGE-SYNC DIAGNOSTIC FIX. `sync_state.last_error_category`
    // is a CATEGORY on purpose — Rule 4 above says a provider error body must
    // never be stored, because it quotes the request that caused it, and a
    // request to a files API quotes folder and file names. But a category with
    // nothing behind it is not the same discipline; it is the discipline's
    // failure mode. Two of three real mappings on this installation sat at
    // 'unknown' for hours because the actual exception — a plain TypeError, a
    // SealingError from a master key that could not open a connection's stored
    // tokens, a DB constraint violation — was thrown, caught here, reduced to
    // one word, and never written down anywhere an operator could read it. The
    // worker's own job loop then reported the run as "done" regardless (it
    // only checks whether the job THREW, and this function does not).
    //
    // So: log the real message and stack to stderr, every time, unconditionally.
    // Not the provider's response body (Rule 4 still holds — `err.message` on a
    // ConnectorError is already a category-shaped sentence, never provider
    // text), but whatever Node's own exception actually says, so a bug in this
    // codebase cannot hide behind the enum forever. An operator watching
    // container logs sees the real fault; `sync_state` keeps its honest,
    // provider-body-free category for the owner-facing surface.
    console.error(
      `[storage.sync] mapping ${mapping.id} (${mapping.provider}) failed, category=${category}:`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    await recordSyncFailure(db, {
      mappingId: mapping.id, ownerUserId: mapping.owner_user_id, category,
    });
    return { status: 'failed', counts, errorCategory: category };
  }
}

function failureCategory(
  err: unknown,
): 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied' | 'unknown' {
  if (err instanceof ConnectorError) {
    const map: Partial<Record<ErrorCategory, 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied'>> = {
      revoked: 'token_expired',
      expired: 'token_expired',
      insufficient_scope: 'permission_denied',
      rate_limited: 'rate_limited',
      network: 'unreachable',
    };
    return map[err.category] ?? 'unknown';
  }
  // Scanner enabled but unreachable: processing must stop visibly, not carry
  // on unscanned. 'unknown' is the honest category sync_state has for it.
  if (err instanceof ScanBlocked) return 'unknown';
  // A sealed value that will not open — wrong master key, key rotated without
  // re-sealing every connection, or a tampered/corrupted ciphertext. This is
  // NOT a provider problem and retrying will never fix it; distinguished from
  // the generic fallback below because 'unreachable' at least tells the
  // operator "stop retrying, go look at the master key", where bare 'unknown'
  // told nobody anything. `SealingError` is thrown by `openSealed` in
  // `accessTokenFor` (connections.ts), OUTSIDE that function's own try/catch,
  // so it propagates here uncaught by anything more specific.
  if (err instanceof SealingError) return 'unreachable';
  return 'unknown';
}

// -------------------------------------------------------------- the walk

interface WalkCtx {
  mapping: CloudMappingRow;
  session: RemoteSession;
  policy: StoragePolicy;
  counts: CloudSyncCounts;
}

interface ExistingDoc {
  id: string;
  byte_size: string | number;
  modified_at: string | null;
  state: string;
}

/** Sorted, deterministically, by the path Josi will file it under.
 *
 * `Array.prototype.sort` on strings is locale-INDEPENDENT here on purpose
 * (plain code-point order, no `localeCompare`) — the point is not that the
 * order is pretty, it is that the same set of names sorts the same way on
 * every run, on every machine, regardless of `LANG`. */
function byRelativePath<T extends { relativePath: string }>(a: T, b: T): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

async function walkAndIngest(
  db: Db,
  ctx: WalkCtx,
  opts: CloudSyncOptions,
): Promise<{ complete: boolean; seenPaths: Set<string> }> {
  const { mapping, counts } = ctx;
  const maxEntries = opts.maxEntries ?? 5000;

  const existing = new Map<string, ExistingDoc>();
  for (const row of await db.query<ExistingDoc & { relative_path: string }>(
    `select id, relative_path, byte_size, modified_at, state from documents where mapping_id = $1`,
    [mapping.id],
  )) existing.set(row.relative_path, row);

  // The quota-flapping bug (document-consistency fix, 2026-09): this walk used
  // to hand `ingestFile` no usage of its own, so it read a fresh COUNT from the
  // database for every file, and processed files in whatever order the
  // provider's listing page happened to return them — which Drive and Graph do
  // not promise is stable. Same folder, two runs, two different orders, two
  // different sets of files landing on the wrong side of the quota ceiling.
  //
  // Read usage ONCE, here, before anything is decided, and thread it through
  // every `ingestOne` call in this walk as a running snapshot that
  // `ingestFile` updates in place. Combined with sorting every batch of
  // entries by relative path before they are ingested (below and in the
  // recursive descent), the whole walk's accept/reject decisions become a
  // pure function of (starting usage, this mapping's actual file set, policy)
  // — not of network pagination order.
  const usage = await usageFor(db, mapping.owner_user_id);
  const ceilings = await ceilingsFor(db, mapping.owner_user_id);

  const seenPaths = new Set<string>();
  const folders: Array<{ id: string; prefix: string }> = [
    { id: mapping.remote_folder_id, prefix: '' },
  ];
  let entriesSeen = 0;
  let complete = true;

  while (folders.length) {
    // Deterministic descent order too: which subfolder is visited first
    // affects which of ITS files get an early or late look at the quota
    // ceiling, the same way file order within one folder does. Sorted once
    // per pass rather than kept as a priority queue, because M50 recursion
    // trees are not expected to be large enough for this to matter, and a
    // plain sort is easy to read.
    folders.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
    const folder = folders.shift()!;

    // Buffered per folder, not per provider page: a provider is free to slice
    // one folder's listing across pages however it likes, and a page boundary
    // is not a meaningful place to sort from. Bounded by one folder's entry
    // count, which the existing per-user file ceilings already keep sane.
    const folderEntries: Array<{ entry: RemoteEntry; relativePath: string; filename: string }> = [];
    const subfolders: Array<{ id: string; prefix: string }> = [];

    let pageCursor: string | null = null;
    do {
      const page = await ctx.session.list({ folderId: folder.id, pageCursor }, opts);
      pageCursor = page.nextPageCursor;

      for (const entry of page.entries) {
        if (entriesSeen >= maxEntries) { complete = false; break; }
        entriesSeen++;

        if (entry.folder) {
          // M50: recursion is a property of the grant. A non-recursive mapping
          // does not descend, whatever appears later.
          if (mapping.recursive) subfolders.push({ id: entry.sourceId, prefix: `${folder.prefix}${sanitizeRemoteName(entry.name)}/` });
          continue;
        }

        const filename = effectiveName(entry);
        const relativePath = `${folder.prefix}${filename}`;
        folderEntries.push({ entry, relativePath, filename });
      }
      if (!complete) break;
    } while (pageCursor);

    folderEntries.sort(byRelativePath);
    for (const { entry, relativePath, filename } of folderEntries) {
      seenPaths.add(relativePath);
      counts.seen++;

      // Unchanged since last time: neither downloaded nor re-gated. The
      // modified stamp and size both have to agree, and only a settled state
      // may stand — a 'discovered' row is a run that never finished.
      const before = existing.get(relativePath);
      if (
        before && entry.modifiedAt && before.modified_at
        && new Date(entry.modifiedAt).getTime() === new Date(before.modified_at).getTime()
        && Number(before.byte_size) === entry.byteSize
        && (before.state === 'indexed' || before.state === 'skipped' || before.state === 'blocked')
      ) {
        counts.unchanged++;
        continue;
      }

      await ingestOne(db, ctx, { entry, relativePath, filename, usage, ceilings }, opts);
    }

    subfolders.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
    folders.push(...subfolders);
    if (!complete) break;
  }

  return { complete, seenPaths };
}

/** One file through the gates, then — if the gates said yes — through
 * download, encryption check, extraction and indexing. Every ending is a
 * recorded state with a reason the owner can read. */
async function ingestOne(
  db: Db,
  ctx: WalkCtx,
  args: {
    entry: RemoteEntry; relativePath: string; filename: string;
    /** The walk's running snapshot — see the note on `walkAndIngest`. Passed
     * straight through to `ingestFile`, which mutates it in place when this
     * file is accepted, so the next file in the (sorted, deterministic) walk
     * sees it counted. */
    usage: { files: number; bytes: number };
    ceilings: { maxFiles: number | null; maxBytes: number | null };
  },
  opts: CloudSyncOptions,
): Promise<void> {
  const { mapping, policy, counts } = ctx;
  const { entry, relativePath, filename, usage, ceilings } = args;
  const maxBytes = Number(policy.max_file_bytes);

  // Downloaded at most once, shared between the malware scan and extraction.
  let bytes: Buffer | null = null;
  const fetchBytes = async (): Promise<Buffer> => {
    if (bytes) return bytes;
    bytes = await ctx.session.download({ entry, maxBytes }, opts);
    return bytes;
  };

  const outcome = await ingestFile(db, {
    mappingId: mapping.id,
    ownerUserId: mapping.owner_user_id,
    candidate: { relativePath, filename, byteSize: entry.byteSize },
    deps: { policy, scanner: opts.scanner, readFile: () => fetchBytes() },
    usage,
    ceilings,
  });
  await db.query(
    `update documents set modified_at = $2 where id = $1`,
    [outcome.documentId, entry.modifiedAt],
  );

  if (outcome.kind !== 'accepted') { counts.skipped++; return; }

  if (entry.unreadable) {
    // A Google Form has no bytes to read. Counted and said, not silently absent.
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unsupported_type',
    });
    counts.skipped++;
    return;
  }

  try {
    await fetchBytes();
  } catch (err) {
    if (err instanceof FileTooLarge) {
      await skipDocument(db, {
        documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'too_large',
      });
      counts.skipped++;
      return;
    }
    if (err instanceof ConnectorError
      && (err.category === 'provider_error' || err.category === 'network')) {
      // THIS file could not be read; the run continues. Token and scope
      // problems are rethrown above this and fail the whole run instead.
      await skipDocument(db, {
        documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unreadable',
      });
      counts.skipped++;
      return;
    }
    throw err;
  }

  const content = bytes!;
  // The metadata gates could not see the bytes; the encryption check runs now
  // that they are here. M64: skipped, never cracked, password never asked for.
  if (looksEncrypted({ filename, relativePath, byteSize: content.length, header: content.subarray(0, 4096) })) {
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'encrypted',
    });
    counts.skipped++;
    return;
  }

  const extension = entry.exportExtension ?? extensionOf(filename);
  if (looksLikeCredentialFile(filename, extension === 'txt' ? content.toString('utf8') : '')) {
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'credential_detected',
    });
    counts.skipped++;
    return;
  }
  let segments = null;
  // This IS the document-ingestion pipeline (Drive/OneDrive folder sync), not
  // a chat attachment: an "image" arriving here is very often a scanned page,
  // and OCR text is a fair thing to index for search. `ocrImages: true` is
  // deliberate and scoped to exactly this call site.
  try { segments = await extractRichSegments({ extension, bytes: content, ocrImages: true }); } catch { segments = null; }
  if (!segments) {
    await skipDocument(db, {
      documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, reason: 'unsupported_type',
    });
    counts.skipped++;
    return;
  }

  await storeExtraction(db, {
    documentId: outcome.documentId, ownerUserId: mapping.owner_user_id, segments,
  });
  await db.query(
    `update documents set byte_size = $2, content_hash = $3 where id = $1`,
    [outcome.documentId, content.length, sha256(content)],
  );
  counts.indexed++;
}

/** Rule 3's second half: what a complete walk did not see is gone at the
 * provider, and goes here too — the row, and through the cascade every byte
 * derived from it. */
async function removeUnseen(db: Db, mappingId: string, seen: Set<string>): Promise<number> {
  const rows = await db.query<{ id: string; relative_path: string }>(
    `select id, relative_path from documents where mapping_id = $1`,
    [mappingId],
  );
  const goneIds = rows.filter((r) => !seen.has(r.relative_path)).map((r) => r.id);
  if (!goneIds.length) return 0;
  await db.query(`delete from documents where mapping_id = $1 and id = any($2)`, [mappingId, goneIds]);
  return goneIds.length;
}
