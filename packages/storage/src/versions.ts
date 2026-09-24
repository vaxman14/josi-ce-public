// History, sharing controls, sync, and audit retention.
//
// The through-line here is that each of these is a place where a setting could
// quietly mean more than it says. M60–M62 keep copies of people's documents;
// M69 governs who may see them; M76–M77 decide how often Josi reaches out; M73
// decides how long the record of all that survives. Each one is written so the
// honest sentence and the enforced behaviour are the same thing.
import { appendEvent, type Db } from '@josi-ce/core';

export type HistoryMode = 'disabled' | 'one' | 'two';
export type HistoryKind = 'snapshot' | 'recovery_copy';

export interface HistoryPolicy {
  history_mode: HistoryMode;
  history_kind: HistoryKind;
  recycle_bin_days: number;
}

export const HISTORY_LIMIT: Record<HistoryMode, number> = {
  disabled: 0, one: 1, two: 2,
};

/**
 * M61/M62: what the people affected must be able to read.
 *
 * M61 says history needs no extra per-user consent — the administrator alone
 * sets it — but that the policy must be plainly visible to affected users. That
 * combination only works if the wording is honest, so this is generated from the
 * actual settings rather than written once as marketing copy.
 *
 * M62 is the sentence people most need: recovery copies are NOT encrypted by
 * Josi. They inherit the Docker volume and host storage security, and the right
 * answer is full-disk or volume encryption.
 */
export function historyDisclosure(policy: HistoryPolicy): string {
  if (policy.history_mode === 'disabled') {
    return 'Josi keeps no previous versions of your documents. Only the current version is indexed.';
  }
  const n = HISTORY_LIMIT[policy.history_mode];
  const versions = n === 1 ? 'the previous version' : `the previous ${n} versions`;

  if (policy.history_kind === 'snapshot') {
    return `Josi records that ${versions} of your documents existed, but does not keep a copy of them. `
      + 'Nothing extra is stored on this server and there is nothing extra to download.';
  }
  return `Josi keeps a downloadable copy of ${versions} of your documents on this server. `
    + 'These copies count towards your storage limit, are deleted when you unmap the folder or turn '
    + 'off indexing, and are NOT encrypted by Josi — they are protected only by the security of this '
    + 'server\'s disk. Ask your administrator to use full-disk or volume encryption.';
}

/** Keeps history within the configured depth, oldest first.
 *
 * The trimming happens on the way IN. Doing it on a sweep instead would mean an
 * installation that drops from two versions to one keeps the extra copy until
 * whenever the sweep next ran — and "we deleted it eventually" is not what
 * "keep one previous version" says. */
export async function recordVersion(
  db: Db,
  args: {
    documentId: string;
    ownerUserId: string;
    contentHash: string;
    byteSize: number;
    policy: HistoryPolicy;
    storedPath?: string | null;
  },
): Promise<{ kept: boolean; trimmed: number }> {
  const limit = HISTORY_LIMIT[args.policy.history_mode];
  if (limit === 0) return { kept: false, trimmed: 0 };

  const kind = args.policy.history_kind;
  if (kind === 'recovery_copy' && !args.storedPath) {
    throw new Error('a recovery copy needs somewhere to live');
  }

  const [{ next }] = await db.query<{ next: number }>(
    `select coalesce(max(ordinal), 0) + 1 as next from document_versions where document_id = $1`,
    [args.documentId],
  );
  await db.query(
    `insert into document_versions
       (document_id, owner_user_id, ordinal, content_hash, byte_size, kind, stored_path)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      args.documentId, args.ownerUserId, next, args.contentHash, args.byteSize,
      kind, kind === 'recovery_copy' ? args.storedPath : null,
    ],
  );

  const trimmed = await db.query<{ id: string }>(
    `delete from document_versions
     where document_id = $1
       and ordinal <= (
         select max(ordinal) - $2 from document_versions where document_id = $1
       )
     returning id`,
    [args.documentId, limit],
  );
  return { kept: true, trimmed: trimmed.length };
}

/**
 * M79: the source is gone, but the mapping is still authorised.
 *
 * In recovery-copy mode the last copy goes to a recycle bin for the
 * administrator's window. In every other case the derived data goes now.
 *
 * Note what this function does NOT do: unmapping and revocation still purge
 * immediately, regardless of the recycle bin. The bin is for "your file
 * vanished", not for "you withdrew permission" — treating those the same would
 * mean revoking access left copies of the documents behind for up to 90 days.
 */
export async function sourceDeleted(
  db: Db,
  args: { documentId: string; policy: HistoryPolicy },
): Promise<{ recycled: number; purged: boolean }> {
  if (args.policy.history_kind !== 'recovery_copy' || args.policy.history_mode === 'disabled') {
    await db.query(`delete from documents where id = $1`, [args.documentId]);
    return { recycled: 0, purged: true };
  }

  const rows = await db.query<{ id: string }>(
    `update document_versions
       set source_deleted_at = now(),
           purge_after = now() + make_interval(days => $2)
     where document_id = $1 and kind = 'recovery_copy'
     returning id`,
    [args.documentId, args.policy.recycle_bin_days],
  );
  await db.query(
    `update documents set state = 'skipped', skip_reason = 'unreadable' where id = $1`,
    [args.documentId],
  );
  // The text goes now; only the recovery copy waits in the bin. Keeping the
  // searchable text of a file that no longer exists would make search return
  // results the person cannot open and did not ask to keep.
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  return { recycled: rows.length, purged: false };
}

/** Empties the recycle bin. Returns what it removed so the caller can delete
 * the corresponding files and report a number rather than a shrug. */
export async function runRecycleBin(db: Db): Promise<{ removed: Array<{ id: string; stored_path: string | null }> }> {
  const removed = await db.query<{ id: string; stored_path: string | null }>(
    `delete from document_versions
     where purge_after is not null and purge_after <= now()
     returning id, stored_path`,
  );
  return { removed };
}

/** M54 again, for versions: unmapping or revoking takes recovery copies too.
 *
 * A separate function from `purgeDerived` only because it returns the paths the
 * caller must unlink. The rows go either way — the foreign key cascades — but
 * "the row is gone" is not the same as "the file is gone", and this is where
 * that difference is made visible. */
export async function versionsToUnlink(db: Db, mappingId: string): Promise<string[]> {
  const rows = await db.query<{ stored_path: string }>(
    `select v.stored_path from document_versions v
     join documents d on d.id = v.document_id
     where d.mapping_id = $1 and v.stored_path is not null`,
    [mappingId],
  );
  return rows.map((r) => r.stored_path);
}

// ---------------------------------------------------------------------------
// Sharing (M69)
// ---------------------------------------------------------------------------

export class SharingDisabled extends Error {}

export interface SharingPolicy {
  sharing_enabled: boolean;
  workspace_sharing_enabled: boolean;
}

/**
 * M69: the administrator may switch sharing off entirely, and may separately
 * forbid workspace-wide sharing while allowing person-to-person.
 *
 * The second half is the useful one. "Share with everyone" and "share with
 * Priya" are different risks — one is a broadcast — and an installation that
 * wants colleagues to be able to help each other without anyone publishing a
 * folder to the whole company needs exactly this shape.
 *
 * Note the decision it does NOT make: M69 also says ordinary shares need no
 * per-share admin approval. An administrator approving each share would mean an
 * administrator seeing what is being shared, which is content.
 */
export function assertSharingAllowed(
  policy: SharingPolicy,
  args: { workspace: boolean },
): void {
  if (!policy.sharing_enabled) {
    throw new SharingDisabled('your administrator has turned off sharing');
  }
  if (args.workspace && !policy.workspace_sharing_enabled) {
    throw new SharingDisabled(
      'your administrator allows sharing with individual colleagues, but not with everyone',
    );
  }
}

export async function sharingPolicy(db: Db): Promise<SharingPolicy> {
  const [row] = await db.query<SharingPolicy>(
    `select sharing_enabled, workspace_sharing_enabled from storage_policy where id = true`,
  );
  return row;
}

// ---------------------------------------------------------------------------
// Sync (M76, M77, M78)
// ---------------------------------------------------------------------------

export class SyncRefused extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}

/** M77: a rate-limited manual sync, per user per mapping. */
export const MANUAL_SYNC_MIN_SECONDS = 60;

export interface SyncPolicy {
  cloud_sync_minutes: number;
  manual_sync_enabled: boolean;
  processing_paused: boolean;
}

/**
 * Whether "Sync now" may run.
 *
 * Three gates and the order is the point. The global pause wins over everything
 * (M77 is explicit that manual sync cannot bypass it), then the administrator's
 * switch, then the rate limit. A person who presses the button during a pause
 * should be told the installation is paused, not that they are going too fast.
 */
export function mayManualSync(
  policy: SyncPolicy,
  state: { last_manual_sync_at: string | null },
  now: Date,
): { ok: true } | { ok: false; reason: string; retryAfterSeconds?: number } {
  if (policy.processing_paused) {
    return { ok: false, reason: 'document processing is paused for the whole installation' };
  }
  if (!policy.manual_sync_enabled) {
    return { ok: false, reason: 'your administrator has turned off manual sync' };
  }
  if (state.last_manual_sync_at) {
    const elapsed = (now.getTime() - new Date(state.last_manual_sync_at).getTime()) / 1000;
    if (elapsed < MANUAL_SYNC_MIN_SECONDS) {
      return {
        ok: false,
        reason: 'you have just synced this folder',
        retryAfterSeconds: Math.ceil(MANUAL_SYNC_MIN_SECONDS - elapsed),
      };
    }
  }
  return { ok: true };
}

/** M78: expired provider access pauses the mapping and tells the owner.
 *
 * Pausing rather than revoking, and the difference is deliberate: a lapsed token
 * is usually somebody needing to sign in again, and destroying their index every
 * time that happens would be a far worse outcome than a paused folder. */
export async function recordSyncFailure(
  db: Db,
  args: {
    mappingId: string;
    ownerUserId: string;
    category: 'token_expired' | 'rate_limited' | 'unreachable' | 'permission_denied' | 'unknown';
  },
): Promise<{ paused: boolean }> {
  await db.query(
    `insert into sync_state (mapping_id, owner_user_id, consecutive_failures, last_error_category)
     values ($1, $2, 1, $3)
     on conflict (mapping_id) do update set
       consecutive_failures = sync_state.consecutive_failures + 1,
       last_error_category = excluded.last_error_category`,
    [args.mappingId, args.ownerUserId, args.category],
  );

  const shouldPause = args.category === 'token_expired' || args.category === 'permission_denied';
  if (shouldPause) {
    await db.query(
      `update folder_mappings set status = 'paused', paused_reason = 'token_expired'
       where id = $1 and status = 'active'`,
      [args.mappingId],
    );
    await appendEvent(db, {
      actorUserId: args.ownerUserId,
      actor: 'system',
      kind: 'storage.sync_paused',
      subjectType: 'folder_mapping',
      subjectId: args.mappingId,
      payload: { reason: args.category },
    });
  }
  return { paused: shouldPause };
}

/** M78: what the administrator may see about sync health.
 *
 * Connection health only — never a folder name, never a file. An administrator
 * needs to know that three of Priya's folders have expired tokens, not what is
 * in them. */
export async function syncHealth(db: Db): Promise<Array<{
  username: string; provider: string; status: string;
  failures: number; last_error_category: string | null;
}>> {
  return db.query(
    `select u.username, m.provider, m.status,
            coalesce(s.consecutive_failures, 0) as failures,
            s.last_error_category
     from folder_mappings m
     join users u on u.id = m.owner_user_id
     left join sync_state s on s.mapping_id = m.id
     where m.provider <> 'local'
     order by u.username, m.provider`,
  );
}

export interface FolderSyncHealth {
  mappingId: string;
  displayPath: string;
  provider: string;
  /** The mapping's own status — 'active' or 'paused' (M78 pauses on
   * token_expired / permission_denied). Never 'revoked' here: a revoked
   * mapping is gone, not degraded. */
  status: string;
  /** Never completed a single sync since the mapping was created. Distinct
   * from a folder that synced once and has since started failing — "this has
   * never worked" and "this used to work" are different sentences and call for
   * different owner action. */
  neverSynced: boolean;
  lastSyncAt: string | null;
  consecutiveFailures: number;
  lastErrorCategory: string | null;
}

/** The 2026-09 storage-sync diagnostic fix, assistant-facing half.
 *
 * `list_documents` and `search_documents` (packages/agent/src/execute.ts) used
 * to read straight from `documents` with no idea whether the folders behind
 * those rows were healthy, degraded, or had never synced a single file. A
 * person asking "check my docs" while two of three connected folders had never
 * completed a sync got an answer blended from whatever scraps of the third
 * folder DID make it in — confident-sounding and, turn to turn, inconsistent,
 * because which scraps existed kept changing as retries came and went. This is
 * the ONE owner-scoped query that makes the honest version of that answer
 * possible: which of MY folders are fine, which have never worked, which are
 * currently failing and why — in the same install-wide category vocabulary
 * `syncHealth` uses for the administrator, never a provider's own error text.
 *
 * Local mappings are excluded on purpose: they do not sync from anywhere, so
 * "never synced" would be true of every one of them and would say nothing. */
export async function folderSyncHealthFor(db: Db, ownerUserId: string): Promise<FolderSyncHealth[]> {
  return db.query<FolderSyncHealth>(
    `select
       m.id                                as "mappingId",
       m.display_path                      as "displayPath",
       m.provider                          as provider,
       m.status                            as status,
       (s.last_sync_at is null)            as "neverSynced",
       s.last_sync_at                      as "lastSyncAt",
       coalesce(s.consecutive_failures, 0) as "consecutiveFailures",
       s.last_error_category               as "lastErrorCategory"
     from folder_mappings m
     left join sync_state s on s.mapping_id = m.id
     where m.owner_user_id = $1
       and m.provider <> 'local'
       and m.status <> 'revoked'
     order by m.display_path`,
    [ownerUserId],
  );
}

// ---------------------------------------------------------------------------
// Audit retention (M73)
// ---------------------------------------------------------------------------

export type AuditRetention = '30d' | '90d' | 'one_year' | 'forever';

export const RETENTION_DAYS: Record<AuditRetention, number | null> = {
  '30d': 30, '90d': 90, one_year: 365, forever: null,
};

/** M73: "forever" gets a storage-growth warning, because it is the option that
 * costs something and does not look like it does. */
export function retentionNotice(policy: AuditRetention): string {
  if (policy === 'forever') {
    return 'Keeping the audit trail forever means it grows without limit. On a small machine '
      + 'this will eventually fill the disk. Check the size periodically.';
  }
  const days = RETENTION_DAYS[policy];
  return `Audit entries older than ${days} days are deleted automatically.`;
}

export async function runAuditRetention(db: Db): Promise<{ removed: number }> {
  const [policy] = await db.query<{ audit_retention: AuditRetention }>(
    `select audit_retention from storage_policy where id = true`,
  );
  const days = RETENTION_DAYS[policy?.audit_retention ?? 'one_year'];
  if (days === null) {
    await db.query(
      `insert into audit_retention_runs (policy, events_removed) values ('forever', 0)`,
    );
    return { removed: 0 };
  }

  const removed = await db.query<{ id: string }>(
    `delete from events where created_at < now() - make_interval(days => $1) returning id`,
    [days],
  );
  await db.query(
    `insert into audit_retention_runs (policy, events_removed) values ($1, $2)`,
    [policy.audit_retention, removed.length],
  );
  return { removed: removed.length };
}
