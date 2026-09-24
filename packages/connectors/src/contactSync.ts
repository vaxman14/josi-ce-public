// Applying what a provider said to what Josi holds.
//
// The provider adapter answers "what changed". This decides what that MEANS,
// and every decision here is one that is destructive to get wrong.
//
// THE RULES, in the order they are applied:
//
//   1. A TOMBSTONE BEATS AN INCOMING RECORD. If this contact was deleted, a
//      full resync that re-sends it does not bring it back. Providers expire
//      their cursors routinely, so a full resync is a normal event, and
//      without this every delete is undone within a week.
//
//   2. A DELETE IS APPLIED ONLY WHERE IT WAS MADE. A remote delete removes the
//      LINK and, if nothing else links that contact, the contact. It never
//      reaches back out to another provider. A local delete never deletes at a
//      provider unless the origin is two-way and the user asked for it.
//
//   3. BOTH SIDES CHANGED IS A CONFLICT, AND A CONFLICT WRITES NOTHING. The
//      contact is flagged and left exactly as it is. Last-write-wins is the
//      easy answer and it silently discards whichever edit was slower.
//
//   4. MATCHING NEVER MERGES ON ITS OWN except for a record we already know.
//      Everything else is a suggestion. See contactIdentity.ts for why.
//
// PER-USER ISOLATION is not a check in this file; it is the shape of it. Every
// query is keyed by `owner_user_id` taken from the ORIGIN, never from a
// request, so there is no argument a caller could pass that would reach
// somebody else's contacts.
import {
  appendEvent, findDuplicates, json, matchContacts, normalizeEmail, normalizePhone,
  type Db, type ExternalContact, type MasterKey,
} from '@josi-ce/core';
import { createHash } from 'node:crypto';
import type { Provider } from './capabilities.js';
import { contactCapabilityFor } from './capabilities.js';
import { accessTokenFor, getConnection, type ConnectionRow } from './connections.js';
import { loadClient } from './oauthClients.js';
import { ConnectorError, type ErrorCategory, type FetchOptions } from './providers.js';
import {
  ExpiredCursor, backoffMs, readContactPage, writeContact, type RemoteContact,
} from './providers/contacts.js';

export type SyncMode = 'import_only' | 'two_way';
export type OriginStatus = 'idle' | 'syncing' | 'error' | 'paused' | 'disconnected';

export interface SyncOrigin {
  id: string;
  connection_id: string;
  owner_user_id: string;
  // Matches the DB check constraint on contact_sync_origins.provider: contacts
  // only ever meant Google and Microsoft. Dropbox, Box and Nextcloud are
  // storage-only providers with no address book to sync.
  provider: 'google' | 'microsoft';
  source_account: string;
  sync_mode: SyncMode;
  delta_cursor: string | null;
  page_cursor: string | null;
  status: OriginStatus;
  sync_interval_seconds: number;
  last_attempt_at: string | null;
  last_error_category: ErrorCategory | null;
  last_sync_at: string | null;
  last_sync_counts: Record<string, number>;
}

export interface LocalContact {
  id: string;
  owner_user_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  emails: string[];
  phones: string[];
  source: string;
  notes?: Record<string, unknown> | null;
  source_account: string | null;
  conflict_state: string | null;
  updated_at: string;
  synced_at: string | null;
}

export class SyncError extends Error {
  constructor(message: string, readonly category: ErrorCategory = 'provider_error') {
    super(message);
  }
}

/** Permission belongs to the exact origin connection, never another account. */
async function originAllowed(db: Db, connection: ConnectionRow, capability: string): Promise<boolean> {
  const [grant] = await db.query<{ allowed: boolean }>(
    `select (cc.enabled and cc.scopes_granted_at is not null and coalesce(p.allowed, true)) as allowed
     from connection_capabilities cc left join admin_capability_policy p on p.capability = cc.capability
     where cc.connection_id = $1 and cc.capability = $2`, [connection.id, capability]);
  return connection.status === 'active' && !!grant?.allowed;
}

// ---------------------------------------------------------------- fingerprint

/** A stable hash of the fields Josi syncs.
 *
 * Only those fields: a contact whose provider changed a photo has not changed
 * as far as Josi is concerned, and treating it as changed would manufacture
 * conflicts out of edits nobody made. Sorted and lower-cased so a provider
 * reordering an array is not a change either. */
export function fingerprint(value: {
  displayName: string | null;
  emails: string[];
  phones: string[];
}): string {
  const canonical = JSON.stringify({
    n: (value.displayName ?? '').trim().toLowerCase(),
    e: [...new Set(value.emails.map((v) => normalizeEmail(v) ?? v.trim().toLowerCase()))].sort(),
    p: [...new Set(value.phones.map((v) => normalizePhone(v) ?? v.trim()))].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

const localFingerprint = (c: LocalContact): string =>
  fingerprint({ displayName: c.name, emails: c.emails, phones: c.phones });

// -------------------------------------------------------------- the decision

export type ApplyAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'conflict'
  | 'deleted'
  | 'delete_ignored_tombstoned'
  | 'skipped_tombstoned';

export interface ApplyDecision {
  action: ApplyAction;
  /** Shown to the user when something needs explaining. */
  reason: string;
}

/** What should happen to one incoming record.
 *
 * A pure function of four facts, so the whole matrix is testable without a
 * provider, a network or a database. Everything the caller does afterwards
 * follows from this.
 */
export function decideApply(args: {
  remote: RemoteContact;
  /** The contact this remote record is already linked to, if any. */
  linked: LocalContact | null;
  /** What we recorded at the last agreement. */
  lastRemoteFingerprint: string | null;
  lastLocalFingerprint: string | null;
  /** Has this remote record been deleted before? */
  tombstoned: boolean;
}): ApplyDecision {
  const { remote, linked, tombstoned } = args;

  if (remote.deleted) {
    if (!linked) {
      return { action: 'delete_ignored_tombstoned', reason: 'Already gone here.' };
    }
    if (linked.source === 'josi' || (linked.notes != null && Object.keys(linked.notes).length > 0) ||
        (args.lastLocalFingerprint !== null && localFingerprint(linked) !== args.lastLocalFingerprint)) {
      return { action: 'conflict', reason: 'Deleted at the provider but edited here. The local edit was preserved.' };
    }
    return { action: 'deleted', reason: 'Deleted at the provider.' };
  }

  // Rule 1. A resurrection is the commonest contact-sync bug: the cursor
  // expires, the provider re-sends everything, and every delete is undone.
  if (tombstoned && !linked) {
    return {
      action: 'skipped_tombstoned',
      reason: 'This was deleted here, and a full resync is not a reason to bring it back.',
    };
  }

  if (!linked) {
    return { action: 'created', reason: 'New at the provider.' };
  }

  const remoteNow = fingerprint(remote);
  const localNow = localFingerprint(linked);
  const remoteChanged = args.lastRemoteFingerprint !== null && remoteNow !== args.lastRemoteFingerprint;
  const localChanged = args.lastLocalFingerprint !== null && localNow !== args.lastLocalFingerprint;

  if (remoteNow === localNow) {
    return { action: 'unchanged', reason: 'Both sides already agree.' };
  }

  // Rule 3. Both moved since the last agreement: write nothing, flag it, let a
  // person decide. Last-write-wins would silently discard one of the edits.
  if (remoteChanged && localChanged) {
    return {
      action: 'conflict',
      reason: 'This contact changed here and at the provider since the last sync. Nothing was overwritten.',
    };
  }

  if (remoteChanged || args.lastRemoteFingerprint === null) {
    return { action: 'updated', reason: 'Changed at the provider.' };
  }

  // Only the local side moved. In import-only that is left alone; a two-way
  // origin pushes it, which the push pass handles.
  return { action: 'unchanged', reason: 'Changed here only.' };
}

// ------------------------------------------------------------------ storage

async function loadOrigin(db: Db, originId: string): Promise<SyncOrigin | null> {
  const [row] = await db.query<SyncOrigin>(
    `select id, connection_id, owner_user_id, provider, source_account, sync_mode,
            delta_cursor, page_cursor, status, last_error_category, last_sync_at, last_sync_counts,
            sync_interval_seconds, last_attempt_at
     from contact_sync_origins where id = $1`,
    [originId],
  );
  return row ?? null;
}

async function loadContact(db: Db, contactId: string): Promise<LocalContact | null> {
  const [row] = await db.query<LocalContact>(
    `select id, owner_user_id, name, email, phone, emails, phones, source, notes, source_account,
            conflict_state, updated_at, synced_at
     from contacts where id = $1`,
    [contactId],
  );
  return row ?? null;
}

interface LinkRow {
  id: string;
  contact_id: string;
  source_id: string;
  remote_etag: string | null;
  remote_fingerprint: string | null;
  local_fingerprint: string | null;
}

async function loadLink(db: Db, originId: string, sourceId: string): Promise<LinkRow | null> {
  const [row] = await db.query<LinkRow>(
    `select id, contact_id, source_id, remote_etag, remote_fingerprint, local_fingerprint
     from contact_links where origin_id = $1 and source_id = $2`,
    [originId, sourceId],
  );
  return row ?? null;
}

async function isTombstoned(db: Db, origin: SyncOrigin, sourceId: string): Promise<boolean> {
  const [row] = await db.query<{ id: string }>(
    `select id from contact_tombstones
     where owner_user_id = $1 and provider = $2 and coalesce(source_account, '') = $3 and source_id = $4`,
    [origin.owner_user_id, origin.provider, origin.source_account, sourceId],
  );
  return !!row;
}

// --------------------------------------------------------------------- pull

export interface SyncCounts {
  created: number;
  updated: number;
  unchanged: number;
  conflicts: number;
  deleted: number;
  skipped: number;
  pushed: number;
}

const emptyCounts = (): SyncCounts => ({
  created: 0, updated: 0, unchanged: 0, conflicts: 0, deleted: 0, skipped: 0, pushed: 0,
});

export interface SyncResult {
  counts: SyncCounts;
  /** Pairs a person has to decide about. Never applied automatically. */
  needsReview: Array<{ left: string; right: string; reason: string; confidence: string }>;
  /** True when the provider's cursor had expired and everything was re-read. */
  wasFullResync: boolean;
  status: OriginStatus;
}

export interface SyncOptions extends FetchOptions {
  masterKey: MasterKey;
  /** Bounds one run. A run that would page forever is a run that never
   * finishes and never advances its cursor. */
  maxPages?: number;
  /** Injected so the retry test does not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pull everything the provider has changed, and apply it.
 *
 * Returns rather than throws for anything the operator can act on: an origin
 * that failed is an origin with a status and a category, and a background job
 * that throws is a background job whose failure nobody sees.
 */
export async function syncOrigin(
  db: Db,
  originId: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const origin = await loadOrigin(db, originId);
  if (!origin) throw new SyncError('no such contact sync origin');

  if (origin.status === 'paused' || origin.status === 'disconnected') {
    return { counts: emptyCounts(), needsReview: [], wasFullResync: false, status: origin.status };
  }

  const connection = await getConnection(db, origin.connection_id);
  if (!connection || connection.status !== 'active' || connection.owner_user_id !== origin.owner_user_id || connection.provider !== origin.provider) {
    // LB8.9. A revoked connection stops sync. It deletes nothing.
    await failOrigin(db, origin, 'revoked', 'disconnected');
    return { counts: emptyCounts(), needsReview: [], wasFullResync: false, status: 'disconnected' };
  }

  // The capability the MODE needs, checked at the moment of use rather than
  // when the mode was chosen. A scope removed at the provider since then must
  // stop the sync, not be discovered halfway through it.
  const needed = contactCapabilityFor(origin.provider, origin.sync_mode);
  const allowed = await originAllowed(db, connection, needed);
  if (!allowed) {
    await failOrigin(db, origin, 'insufficient_scope', 'error');
    return { counts: emptyCounts(), needsReview: [], wasFullResync: false, status: 'error' };
  }

  const claimed = await db.query<{ id: string }>(`update contact_sync_origins set status = 'syncing'
    where id = $1 and status in ('idle', 'error') returning id`, [origin.id]);
  if (!claimed.length) return { counts: emptyCounts(), needsReview: [], wasFullResync: false, status: origin.status };

  const counts = emptyCounts();
  const touched: string[] = [];
  let wasFullResync = false;
  let deltaCursor = origin.delta_cursor;
  let pageCursor = origin.page_cursor;
  const maxPages = opts.maxPages ?? 50;

  try {
    const client = await loadClient(db, opts.masterKey, origin.provider);

    for (let page = 0; page < maxPages; page++) {
      const accessToken = await accessTokenFor(db, opts.masterKey, { connection, client }, opts);

      let result;
      try {
        result = await withRetry(
          () => readContactPage(origin.provider, {
            accessToken, deltaCursor, pageCursor,
          }, opts),
          opts.sleep ?? defaultSleep,
        );
      } catch (err) {
        if (!(err instanceof ExpiredCursor)) throw err;
        // Not a failure. The cursor aged out, so read everything once — and
        // the tombstones are what stop that from resurrecting deletions.
        deltaCursor = null;
        pageCursor = null;
        wasFullResync = true;
        await db.query(
          `update contact_sync_origins set delta_cursor = null, page_cursor = null where id = $1`,
          [origin.id],
        );
        continue;
      }

      for (const remote of result.contacts) {
        const action = await applyRemote(db, origin, remote, counts);
        if (action) touched.push(action);
      }

      pageCursor = result.nextPageCursor;
      if (pageCursor) {
        // Held so a crash resumes rather than restarting. The DELTA cursor is
        // deliberately not advanced: it arrives on the last page only, and
        // advancing early skips whatever is still unread.
        await db.query(`update contact_sync_origins set page_cursor = $2 where id = $1`, [origin.id, pageCursor]);
        continue;
      }

      if (result.nextDeltaCursor) deltaCursor = result.nextDeltaCursor;
      break;
    }

    if (pageCursor) {
      // A bounded run is unfinished. Preserve its checkpoint and do not publish success.
      await db.query(`update contact_sync_origins set status = 'idle', page_cursor = $2, last_sync_counts = $3 where id = $1`,
        [origin.id, pageCursor, json(counts)]);
      return { counts, needsReview: [], wasFullResync, status: 'idle' };
    }

    if (origin.sync_mode === 'two_way') {
      counts.pushed = await pushLocalChanges(db, origin, connection, opts);
    }

    const needsReview = await proposeMerges(db, origin, touched);

    await db.query(
      `update contact_sync_origins
       set status = 'idle', delta_cursor = $2, page_cursor = null, last_sync_at = now(),
           last_error_category = null, last_sync_counts = $3
       where id = $1`,
      [origin.id, deltaCursor, json(counts)],
    );

    await appendEvent(db, {
      actorUserId: origin.owner_user_id,
      actor: 'system',
      kind: 'contacts.synced',
      // Counts, never a name or an address.
      payload: { provider: origin.provider, mode: origin.sync_mode, ...counts, fullResync: wasFullResync },
    });

    return { counts, needsReview, wasFullResync, status: 'idle' };
  } catch (err) {
    const category = err instanceof ConnectorError ? err.category : 'provider_error';
    await failOrigin(db, origin, category, category === 'revoked' ? 'disconnected' : 'error');
    return { counts, needsReview: [], wasFullResync, status: category === 'revoked' ? 'disconnected' : 'error' };
  }
}

async function failOrigin(
  db: Db,
  origin: SyncOrigin,
  category: ErrorCategory,
  status: OriginStatus,
): Promise<void> {
  await db.query(
    `update contact_sync_origins set status = $2, last_error_category = $3, page_cursor = null where id = $1`,
    [origin.id, status, category],
  );
  await appendEvent(db, {
    actorUserId: origin.owner_user_id,
    actor: 'system',
    kind: 'contacts.sync_failed',
    payload: { provider: origin.provider, category },
  });
}

/** Retry the transient, never the permanent.
 *
 * A rate limit and a 5xx are worth trying again; a revoked grant and a missing
 * scope are not, and retrying them just delays telling the user to reconnect. */
async function withRetry<T>(
  run: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastError = err;
      if (err instanceof ExpiredCursor) throw err;
      const category = err instanceof ConnectorError ? err.category : 'provider_error';
      const retryable = category === 'rate_limited' || category === 'network' || category === 'provider_error';
      if (!retryable || attempt === attempts) throw err;
      await sleep(backoffMs(attempt, err instanceof ConnectorError ? err.retryAfterSeconds : undefined));
    }
  }
  throw lastError;
}

/** Apply one incoming record. Returns the contact id it touched, if any. */
async function applyRemote(
  db: Db,
  origin: SyncOrigin,
  remote: RemoteContact,
  counts: SyncCounts,
): Promise<string | null> {
  const link = await loadLink(db, origin.id, remote.sourceId);
  const linked = link ? await loadContact(db, link.contact_id) : null;
  const tombstoned = await isTombstoned(db, origin, remote.sourceId);

  const decision = decideApply({
    remote,
    linked,
    lastRemoteFingerprint: link?.remote_fingerprint ?? null,
    lastLocalFingerprint: link?.local_fingerprint ?? null,
    tombstoned,
  });

  switch (decision.action) {
    case 'skipped_tombstoned':
    case 'delete_ignored_tombstoned':
      counts.skipped++;
      return null;

    case 'deleted': {
      // Remove the LINK first. The contact goes only if nothing else links it:
      // a person synced from both Google and Microsoft who is deleted at one
      // is not deleted here.
      await db.query(`delete from contact_links where origin_id = $1 and source_id = $2`, [origin.id, remote.sourceId]);
      await recordTombstone(db, origin, remote.sourceId, 'remote');
      const [remaining] = await db.query<{ n: string }>(
        `select count(*)::text as n from contact_links where contact_id = $1`,
        [link!.contact_id],
      );
      if (Number(remaining?.n ?? 0) === 0) {
        await db.query(
          `delete from contacts where id = $1 and owner_user_id = $2`,
          [link!.contact_id, origin.owner_user_id],
        );
      }
      counts.deleted++;
      return null;
    }

    case 'conflict': {
      await db.query(
        `update contacts set conflict_state = 'both_changed' where id = $1 and owner_user_id = $2`,
        [linked!.id, origin.owner_user_id],
      );
      counts.conflicts++;
      return linked!.id;
    }

    case 'unchanged':
      counts.unchanged++;
      // The fingerprints still move forward, so "agreed" stays current.
      if (link && linked && fingerprint(remote) === localFingerprint(linked)) {
        await touchLink(db, link.id, remote, linked);
      }
      return linked?.id ?? null;

    case 'created': {
      // The contact and provenance link commit as one statement. A crash must
      // never leave an unlinked contact that the next page replay duplicates.
      const [created] = await db.query<{ id: string }>(
        `with created as (
          insert into contacts (owner_user_id, name, email, phone, emails, phones,
            source, source_account, conflict_state, synced_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, 'none', now()) returning id
        ), linked as (
          insert into contact_links (origin_id, contact_id, owner_user_id, source_id,
            remote_etag, remote_updated_at, remote_fingerprint, local_fingerprint)
          select $9, id, $1, $10, $11, $12, $13, $13 from created returning contact_id
        ) select contact_id as id from linked`,
        [origin.owner_user_id, remote.displayName, remote.emails[0] ?? null,
          remote.phones[0] ?? null, json(remote.emails), json(remote.phones), origin.provider,
          origin.source_account, origin.id, remote.sourceId, remote.etag, remote.updatedAt, fingerprint(remote)],
      );
      counts.created++;
      return created.id;
    }

    case 'updated': {
      await db.query(
        `update contacts set name = $2, email = $3, phone = $4, emails = $5, phones = $6,
             conflict_state = 'none', synced_at = now()
         where id = $1 and owner_user_id = $7`,
        [
          linked!.id, remote.displayName, remote.emails[0] ?? null, remote.phones[0] ?? null,
          json(remote.emails), json(remote.phones), origin.owner_user_id,
        ],
      );
      const after = await loadContact(db, linked!.id);
      await touchLink(db, link!.id, remote, after);
      counts.updated++;
      return linked!.id;
    }
  }
  return null;
}

async function touchLink(
  db: Db,
  linkId: string,
  remote: RemoteContact,
  local: LocalContact | null,
): Promise<void> {
  await db.query(
    `update contact_links
     set remote_etag = $2, remote_updated_at = $3, remote_fingerprint = $4, local_fingerprint = $5
     where id = $1`,
    [
      linkId, remote.etag, remote.updatedAt, fingerprint(remote),
      local ? localFingerprint(local) : fingerprint(remote),
    ],
  );
}

export async function recordTombstone(
  db: Db,
  origin: Pick<SyncOrigin, 'id' | 'owner_user_id' | 'provider' | 'source_account'>,
  sourceId: string,
  side: 'remote' | 'local',
): Promise<void> {
  await db.query(
    `insert into contact_tombstones
       (owner_user_id, origin_id, provider, source_account, source_id, deleted_side)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (owner_user_id, provider, coalesce(source_account, ''), source_id) do nothing`,
    [origin.owner_user_id, origin.id, origin.provider, origin.source_account, sourceId, side],
  );
}

// --------------------------------------------------------------------- push

/** Send local changes to a two-way origin.
 *
 * Only contacts this origin already knows about, and only ones whose local
 * fingerprint has moved. A contact created in Josi is NOT pushed: choosing to
 * sync an account is not choosing to upload an address book into it, and the
 * user asks for that per contact.
 */
async function pushLocalChanges(
  db: Db,
  origin: SyncOrigin,
  connection: ConnectionRow,
  opts: SyncOptions,
): Promise<number> {
  const links = await db.query<LinkRow & { contact_id: string }>(
    `select l.id, l.contact_id, l.source_id, l.remote_etag, l.remote_fingerprint, l.local_fingerprint
     from contact_links l
     join contacts c on c.id = l.contact_id
     where l.origin_id = $1 and l.owner_user_id = $2 and coalesce(c.conflict_state, 'none') <> 'both_changed'`,
    [origin.id, origin.owner_user_id],
  );

  const client = await loadClient(db, opts.masterKey, origin.provider);
  let pushed = 0;

  for (const link of links) {
    const local = await loadContact(db, link.contact_id);
    if (!local) continue;
    const now = localFingerprint(local);
    if (link.local_fingerprint === now) continue;

    const accessToken = await accessTokenFor(db, opts.masterKey, { connection, client }, opts);
    try {
      const written = await writeContact(origin.provider, {
        accessToken,
        displayName: local.name,
        emails: local.emails,
        phones: local.phones,
        sourceId: link.source_id,
        // The provider refuses the write itself if the record moved under us.
        etag: link.remote_etag,
      }, opts);
      await db.query(
        `update contact_links set remote_etag = $2, remote_fingerprint = $3, local_fingerprint = $4 where id = $1`,
        [link.id, written.etag, fingerprint(written), now],
      );
      pushed++;
    } catch (err) {
      // A precondition failure is a conflict, not a crash: the remote moved
      // between the read and the write, so it is flagged like any other.
      const status = err instanceof ConnectorError ? err.status : undefined;
      if (status === 412 || status === 409) {
        await db.query(
          `update contacts set conflict_state = 'both_changed' where id = $1 and owner_user_id = $2`,
          [local.id, origin.owner_user_id],
        );
        continue;
      }
      throw err;
    }
  }
  return pushed;
}

// ------------------------------------------------------------------- merges

/** Duplicate suggestions, scoped to one person's contacts.
 *
 * Nothing here merges. `findDuplicates` decides what is even worth showing,
 * and a pair the user has already said no to is not shown again. */
async function proposeMerges(
  db: Db,
  origin: SyncOrigin,
  touchedIds: string[],
): Promise<Array<{ left: string; right: string; reason: string; confidence: string }>> {
  if (!touchedIds.length) return [];

  const rows = await db.query<LocalContact & { source_id: string | null }>(
    `select c.id, c.owner_user_id, c.name, c.email, c.phone, c.emails, c.phones,
            c.source, c.source_account, c.conflict_state, c.updated_at, c.synced_at,
            l.source_id
     from contacts c
     left join contact_links l on l.contact_id = c.id and l.origin_id = $2
     where c.owner_user_id = $1`,
    [origin.owner_user_id, origin.id],
  );

  const asExternal = rows.map((row): ExternalContact & { localId: string } => ({
    localId: row.id,
    // A contact typed into Josi has no provider id, so its own row id stands
    // in — unique, and never equal to another record's.
    sourceId: row.source_id ?? row.id,
    source: (row.source as ExternalContact['source']) ?? 'josi',
    sourceAccount: row.source_account ?? 'josi',
    displayName: row.name,
    emails: row.emails ?? [],
    phones: row.phones ?? [],
  }));

  const decided = await db.query<{ contact_a: string; contact_b: string }>(
    `select contact_a, contact_b from contact_merge_decisions where owner_user_id = $1`,
    [origin.owner_user_id],
  );
  const alreadyDecided = new Set(decided.map((d) => `${d.contact_a}:${d.contact_b}`));

  const { needsReview } = findDuplicates(asExternal);
  return needsReview
    .map((candidate) => {
      const [a, b] = [candidate.left.localId, candidate.right.localId].sort();
      return {
        left: a,
        right: b,
        reason: candidate.verdict.reason,
        confidence: candidate.verdict.confidence,
      };
    })
    .filter((c) => !alreadyDecided.has(`${c.left}:${c.right}`))
    // Only pairs this run actually touched, so an unchanged sync does not
    // re-present the same backlog every time.
    .filter((c) => touchedIds.includes(c.left) || touchedIds.includes(c.right));
}

/** Record that two contacts are not the same person, so it stops being asked. */
export async function keepSeparate(
  db: Db,
  args: { ownerUserId: string; contactA: string; contactB: string },
): Promise<void> {
  const [a, b] = [args.contactA, args.contactB].sort();
  await db.query(
    `insert into contact_merge_decisions (owner_user_id, contact_a, contact_b, decision)
     values ($1, $2, $3, 'keep_separate')
     on conflict (contact_a, contact_b) do update set decision = 'keep_separate', decided_at = now()`,
    [args.ownerUserId, a, b],
  );
}

/** Fold one contact into another, keeping every link. */
export async function mergeContacts(
  db: Db,
  args: { ownerUserId: string; keepId: string; mergeId: string },
): Promise<void> {
  const keep = await loadContact(db, args.keepId);
  const merge = await loadContact(db, args.mergeId);
  if (!keep || !merge) throw new SyncError('no such contact');
  // Isolation: both must belong to the caller. A merge is a write to two
  // records, and an id from a request is not evidence of ownership.
  if (keep.owner_user_id !== args.ownerUserId || merge.owner_user_id !== args.ownerUserId) {
    throw new SyncError('that contact belongs to somebody else');
  }

  const emails = [...new Set([...keep.emails, ...merge.emails])];
  const phones = [...new Set([...keep.phones, ...merge.phones])];
  await db.query(
    `update contacts set name = coalesce($2, name), emails = $3, phones = $4,
       email = coalesce(email, $5), phone = coalesce(phone, $6)
     where id = $1`,
    [keep.id, keep.name ?? merge.name, json(emails), json(phones),
     emails[0] ?? null, phones[0] ?? null],
  );

  // The links follow, so both providers keep syncing into the surviving
  // record. Any that would collide are dropped rather than duplicated.
  await db.query(
    `update contact_links set contact_id = $1 where contact_id = $2
       and origin_id not in (select origin_id from contact_links where contact_id = $1)`,
    [keep.id, merge.id],
  );
  await db.query(`delete from contacts where id = $1 and owner_user_id = $2`, [merge.id, args.ownerUserId]);

  // No `merged` row is written, and the first version of this wrote one — which
  // failed the foreign key, because the contact it referenced had just been
  // deleted. The failure was pointing at something real: the row would have had
  // no function. `contact_merge_decisions` exists so a REJECTED suggestion is
  // not re-proposed, and a merged contact cannot be re-proposed because it no
  // longer exists. The event below is the audit record.
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'contacts.merged',
    subjectType: 'contact',
    subjectId: keep.id,
    payload: {},
  });
}

// ------------------------------------------------------------------ origins

/** Start syncing an account, or change how it syncs.
 *
 * `two_way` is refused unless the write capability is actually granted — which
 * means a second trip through consent, not a checkbox. */
export async function setSyncMode(
  db: Db,
  args: { connectionId: string; ownerUserId: string; mode: SyncMode },
): Promise<SyncOrigin> {
  const connection = await getConnection(db, args.connectionId);
  if (!connection) throw new SyncError('no such connection');
  if (connection.owner_user_id !== args.ownerUserId) {
    throw new SyncError('that connection belongs to somebody else');
  }
  // Contacts only ever meant Google and Microsoft. A Dropbox, Box or Nextcloud
  // connection has no address book at the provider at all — refused here,
  // rather than reaching `contactCapabilityFor` with a provider it has no
  // entry for.
  if (connection.provider !== 'google' && connection.provider !== 'microsoft') {
    throw new SyncError('this connection has no contacts to sync');
  }

  const needed = contactCapabilityFor(connection.provider, args.mode);
  const allowed = await originAllowed(db, connection, needed);
  if (!allowed) {
    throw new SyncError(
      args.mode === 'two_way'
        ? 'two-way sync needs permission to change contacts at the provider, which has to be granted separately'
        : 'this connection has not been given permission to read contacts',
      'insufficient_scope',
    );
  }

  const [row] = await db.query<SyncOrigin>(
    `insert into contact_sync_origins (connection_id, owner_user_id, provider, source_account, sync_mode)
     values ($1, $2, $3, $4, $5)
     on conflict (connection_id) do update set sync_mode = excluded.sync_mode, status = 'idle'
     returning id, connection_id, owner_user_id, provider, source_account, sync_mode,
               delta_cursor, page_cursor, status, last_error_category, last_sync_at, last_sync_counts,
               sync_interval_seconds, last_attempt_at`,
    [
      connection.id, connection.owner_user_id, connection.provider,
      connection.account_email ?? connection.provider_account_id ?? 'unknown', args.mode,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'contacts.sync_mode_set',
    payload: { provider: connection.provider, mode: args.mode },
  });
  return row;
}

/** Stop syncing. Deletes nothing, anywhere.
 *
 * LB8.9. Disconnecting a source is not consent to lose what it brought, and it
 * is certainly not consent to delete anything at the provider. The contacts
 * stay, marked as no longer syncing. */
export async function stopSync(
  db: Db,
  args: { originId: string; ownerUserId: string },
): Promise<{ contactsKept: number }> {
  const origin = await loadOrigin(db, args.originId);
  if (!origin) throw new SyncError('no such contact sync origin');
  if (origin.owner_user_id !== args.ownerUserId) {
    throw new SyncError('that connection belongs to somebody else');
  }

  const [kept] = await db.query<{ n: string }>(
    `select count(*)::text as n from contact_links where origin_id = $1`,
    [origin.id],
  );
  await db.query(
    `update contact_sync_origins set status = 'disconnected', delta_cursor = null, page_cursor = null
     where id = $1`,
    [origin.id],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'contacts.sync_stopped',
    payload: { provider: origin.provider, contactsKept: Number(kept?.n ?? 0) },
  });
  return { contactsKept: Number(kept?.n ?? 0) };
}

// ----------------------------------------------------------- the schedule

/** Origins whose own interval has elapsed.
 *
 * Selected by `last_attempt_at` rather than `last_sync_at`, and the difference
 * is the whole of the pacing: a run that FAILS still counts as an attempt, so
 * an origin whose provider is down is retried on its interval instead of on
 * every tick. Using `last_sync_at` would mean a permanently failing account
 * being hammered forever, which is how an installation gets rate-limited into
 * a hole it cannot climb out of.
 *
 * `paused` and `disconnected` are excluded here as well as inside `syncOrigin`.
 * Two checks, because this one decides what the worker even wakes up for. */
export async function dueOrigins(db: Db, limit = 20): Promise<Array<{ id: string; owner_user_id: string }>> {
  // A crashed worker cannot strand an origin forever. Three hours exceeds the
  // bounded 50-page run, including request timeouts and capped retry sleeps.
  await db.query(`update contact_sync_origins set status = 'error', last_error_category = 'network'
    where status = 'syncing' and updated_at < now() - interval '3 hours'`);
  // Opted-in contact read capabilities automatically get an import-only origin.
  // Existing stopped origins remain stopped; reconnect never overrides that choice.
  await db.query(`insert into contact_sync_origins (connection_id, owner_user_id, provider, source_account)
    select c.id, c.owner_user_id, c.provider, coalesce(c.account_email, c.provider_account_id, 'unknown')
    from connections c join connection_capabilities cc on cc.connection_id = c.id
    left join admin_capability_policy p on p.capability = cc.capability
    where c.status = 'active' and c.provider in ('google', 'microsoft')
      and cc.capability = c.provider || '.contacts.read' and cc.enabled
      and cc.scopes_granted_at is not null and coalesce(p.allowed, true)
    on conflict (connection_id) do nothing`);
  return db.query<{ id: string; owner_user_id: string }>(
    `select id, owner_user_id from contact_sync_origins
     where status in ('idle', 'error')
       and (last_attempt_at is null
            or last_attempt_at < now() - make_interval(secs => sync_interval_seconds))
     order by last_attempt_at asc nulls first
     limit $1`,
    [limit],
  );
}

/** Record that the scheduler picked this origin up.
 *
 * Written BEFORE the run, not after. A crash mid-sync must not leave the origin
 * looking never-attempted, or the next tick picks it straight back up and the
 * crash repeats as fast as the worker can loop. */
export async function markAttempted(db: Db, originId: string): Promise<void> {
  await db.query(
    `update contact_sync_origins set last_attempt_at = now() where id = $1`,
    [originId],
  );
}

/** How often this account is synced. */
export async function setSyncInterval(
  db: Db,
  args: { originId: string; ownerUserId: string; seconds: number },
): Promise<void> {
  const origin = await loadOrigin(db, args.originId);
  if (!origin) throw new SyncError('no such contact sync origin');
  if (origin.owner_user_id !== args.ownerUserId) {
    throw new SyncError('that connection belongs to somebody else');
  }
  // The bounds are also a CHECK constraint. Both, because the constraint is a
  // promise about the column and this is the message a person reads.
  if (!Number.isInteger(args.seconds) || args.seconds < 300 || args.seconds > 86_400) {
    throw new SyncError('choose an interval between five minutes and a day');
  }
  await db.query(
    `update contact_sync_origins set sync_interval_seconds = $2 where id = $1`,
    [args.originId, args.seconds],
  );
}

/** Everything the contacts screen needs in order to say where a contact came
 * from and whether it is still arriving. */
export async function listOrigins(db: Db, ownerUserId: string): Promise<SyncOrigin[]> {
  return db.query<SyncOrigin>(
    `select id, connection_id, owner_user_id, provider, source_account, sync_mode,
            delta_cursor, page_cursor, status, last_error_category, last_sync_at, last_sync_counts,
            sync_interval_seconds, last_attempt_at
     from contact_sync_origins where owner_user_id = $1 order by provider, source_account`,
    [ownerUserId],
  );
}

export { matchContacts };
