// Taking a file in: the gates applied, the outcome recorded, the reason kept.
//
// M74 asks for per-folder status with skipped-file reasons, and that is the
// shape this file produces. Every document ends in a state, and every state
// that is not `extracted` carries a reason from a fixed vocabulary — because
// these are shown in a list to the person who mapped the folder, and a list of
// raw parser errors is not an explanation.
//
// A parser error string is also a leak: parsers quote the document. So nothing
// a library says about a file ever reaches the database, the API, or the log.
import { appendEvent, type Db } from '@josi-ce/core';
import {
  checkFile, isArchive, scanDocument, scanRequired, sha256,
  type Candidate, type Scanner, type SkipReason, type StoragePolicy,
} from './gates.js';

export class ScanBlocked extends Error {}

export interface IngestDeps {
  policy: StoragePolicy;
  scanner?: Scanner;
  /** Reads the file. Injected so the suite never needs a real filesystem for
   * the decision logic, and so the byte source can be a cloud provider. */
  readFile?: (relativePath: string) => Promise<Buffer>;
}

export type IngestOutcome =
  | { kind: 'accepted'; documentId: string }
  | { kind: 'skipped'; documentId: string; reason: SkipReason }
  | { kind: 'blocked'; documentId: string; signature: string };

export async function ingestFile(
  db: Db,
  args: {
    mappingId: string;
    ownerUserId: string;
    candidate: Candidate;
    deps: IngestDeps;
    /** Which scan mode event this is, for M59. */
    event?: 'index' | 'change';
    /** Usage to gate against, supplied by the caller instead of read fresh
     * here.
     *
     * Why this exists (document-consistency fix, 2026-09): a cloud sync walk
     * processes many files in one pass, and `checkFile`'s quota gate compares
     * against usage AT THE MOMENT EACH FILE IS CHECKED. Reading that usage
     * fresh from the database on every single file made the quota gate's
     * outcome depend on two things that are not stable: the order the
     * provider happened to list files in on THIS call (Drive and Graph do not
     * promise a stable order without an explicit sort, and this codebase asks
     * for neither), and the running total left behind by whichever files in
     * THIS SAME WALK were accepted first. Two walks over an identical,
     * unchanged folder could therefore accept a different subset of files
     * every time — which is exactly the "index reports differently on every
     * check" failure the owner saw.
     *
     * The fix is not to stop counting file-by-file within a walk — a walk
     * that ignored its own already-accepted files would just blow through the
     * ceiling. The fix is to make the COUNTING deterministic: the walk reads
     * usage once, passes a running snapshot down through a caller-fixed,
     * deterministic file order (see `sortEntriesForIngest` in
     * connectors/storageSync.ts), and this function mutates that snapshot in
     * place rather than re-querying. Same starting usage, same sorted file
     * list, same policy -> same accept/reject decisions, every time. Callers
     * that do not pass one (a single-file local ingest, or a test) keep the
     * old behaviour: read live usage from the database, because there is
     * nothing else across one call for it to disagree with. */
    usage?: { files: number; bytes: number };
    /** Ceilings to gate against. Same reasoning as `usage`: a walk reads them
     * once and passes the same values to every file, rather than each file in
     * the walk re-reading a row that cannot have changed since the walk
     * started. */
    ceilings?: { maxFiles: number | null; maxBytes: number | null };
  },
): Promise<IngestOutcome> {
  const { candidate, deps } = args;

  const usage = args.usage ?? await usageFor(db, args.ownerUserId);
  const ceilings = args.ceilings ?? await ceilingsFor(db, args.ownerUserId);

  const documentId = await upsertDocument(db, {
    mappingId: args.mappingId,
    ownerUserId: args.ownerUserId,
    candidate,
  });

  const gate = checkFile({ candidate, policy: deps.policy, usage, ceilings });
  if (!gate.ok) {
    await markSkipped(db, documentId, args.ownerUserId, gate.reason);
    return { kind: 'skipped', documentId, reason: gate.reason };
  }
  // Accepted against `usage` as it stood for this decision: charge it now, in
  // place, so the NEXT file in a caller-supplied snapshot sees this one
  // counted. Only meaningful when the caller passed a snapshot at all --
  // `usageFor`'s one-shot read has nothing after it in the same call to stay
  // consistent with.
  if (args.usage) {
    args.usage.files += 1;
    args.usage.bytes += candidate.byteSize;
  }

  // M56/M57/M59. The scanner runs on the bytes, and only after the cheap gates
  // have already refused everything they can.
  if (scanRequired(deps.policy, args.event ?? 'index')) {
    if (!deps.scanner) {
      // Enabled but unreachable. Processing STOPS. An outage that silently
      // disables scanning is worse than no scanner, because the operator
      // believes files are being checked.
      await markSkipped(db, documentId, args.ownerUserId, 'unreadable');
      throw new ScanBlocked('the malware scanner is enabled but not reachable');
    }
    const bytes = deps.readFile ? await deps.readFile(candidate.relativePath) : Buffer.alloc(0);
    const { result, hashBefore, hashAfter } = await scanDocument(deps.scanner, bytes);
    if (!result.clean) {
      await recordFinding(db, {
        documentId,
        ownerUserId: args.ownerUserId,
        signature: result.signature ?? 'unknown',
        hashBefore,
        hashAfter,
      });
      return { kind: 'blocked', documentId, signature: result.signature ?? 'unknown' };
    }
  }

  await db.query(
    `update documents set state = 'discovered', skip_reason = null where id = $1`,
    [documentId],
  );
  return { kind: 'accepted', documentId };
}

async function upsertDocument(
  db: Db,
  args: { mappingId: string; ownerUserId: string; candidate: Candidate },
): Promise<string> {
  const { candidate } = args;
  const [row] = await db.query<{ id: string }>(
    `insert into documents
       (mapping_id, owner_user_id, relative_path, filename, extension, byte_size, content_hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (mapping_id, relative_path) do update set
       filename = excluded.filename,
       byte_size = excluded.byte_size,
       content_hash = excluded.content_hash,
       updated_at = now()
     returning id`,
    [
      args.mappingId, args.ownerUserId, candidate.relativePath, candidate.filename,
      extensionFor(candidate.filename), candidate.byteSize,
      candidate.header ? sha256(candidate.header) : null,
    ],
  );
  return row.id;
}

function extensionFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const slash = filename.lastIndexOf('/');
  return dot > slash + 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** M74: the reason is stored so the owner sees why, per file. */
async function markSkipped(
  db: Db, documentId: string, ownerUserId: string, reason: SkipReason,
): Promise<void> {
  await db.query(
    `update documents set state = 'skipped', skip_reason = $2 where id = $1`,
    [documentId, reason],
  );
  // Derived data goes when a file stops being eligible — a file that is now too
  // large must not leave yesterday's extracted text searchable.
  await db.query(`delete from document_text where document_id = $1`, [documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [documentId]);
  await appendEvent(db, {
    actorUserId: ownerUserId,
    actor: 'system',
    kind: 'storage.file_skipped',
    subjectType: 'document',
    subjectId: documentId,
    // The reason. Never the filename — the audit log is read by an
    // administrator, and "salary-review-2026.xlsx was too large" is content.
    payload: { reason },
  });
}

/** M57: block, alert both parties, and do not touch the source. */
async function recordFinding(
  db: Db,
  args: { documentId: string; ownerUserId: string; signature: string; hashBefore: string; hashAfter: string },
): Promise<void> {
  await db.query(
    `update documents set state = 'blocked', skip_reason = 'malware_found' where id = $1`,
    [args.documentId],
  );
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await db.query(
    `insert into malware_findings
       (document_id, owner_user_id, signature, source_hash_before, source_hash_after,
        owner_notified_at, admin_notified_at)
     values ($1, $2, $3, $4, $5, now(), now())`,
    [args.documentId, args.ownerUserId, args.signature, args.hashBefore, args.hashAfter],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'system',
    kind: 'storage.malware_found',
    subjectType: 'document',
    subjectId: args.documentId,
    // A signature name describes the malware, not the document's subject
    // matter, so it is metadata and may be logged.
    payload: { signature: args.signature, sourceUnmodified: args.hashBefore === args.hashAfter },
  });
}

export async function usageFor(db: Db, ownerUserId: string): Promise<{ files: number; bytes: number }> {
  const [row] = await db.query<{ files: number; bytes: string }>(
    `select count(*)::int as files, coalesce(sum(byte_size), 0)::text as bytes
     from documents where owner_user_id = $1 and state <> 'skipped'`,
    [ownerUserId],
  );
  return { files: row?.files ?? 0, bytes: Number(row?.bytes ?? 0) };
}

export async function ceilingsFor(
  db: Db, ownerUserId: string,
): Promise<{ maxFiles: number | null; maxBytes: number | null }> {
  const [row] = await db.query<{ max_files: number | null; max_bytes: string | null }>(
    `select max_files, max_bytes from storage_capabilities where user_id = $1`,
    [ownerUserId],
  );
  return {
    maxFiles: row?.max_files ?? null,
    maxBytes: row?.max_bytes === null || row?.max_bytes === undefined ? null : Number(row.max_bytes),
  };
}

export async function storagePolicy(db: Db): Promise<StoragePolicy> {
  const [row] = await db.query<StoragePolicy>(`select * from storage_policy where id = true`);
  return row;
}

/** M74: what the owner sees about their own folder. Reasons, counts, no guesses. */
export async function mappingStatus(
  db: Db, mappingId: string,
): Promise<{
  total: number;
  byState: Record<string, number>;
  skipped: Array<{ reason: string; count: number }>;
  blocked: number;
}> {
  const states = await db.query<{ state: string; n: number }>(
    `select state, count(*)::int as n from documents where mapping_id = $1 group by state`,
    [mappingId],
  );
  const skipped = await db.query<{ skip_reason: string; n: number }>(
    `select skip_reason, count(*)::int as n from documents
     where mapping_id = $1 and skip_reason is not null
     group by skip_reason order by n desc`,
    [mappingId],
  );
  const byState: Record<string, number> = {};
  let total = 0;
  for (const s of states) { byState[s.state] = s.n; total += s.n; }
  return {
    total,
    byState,
    skipped: skipped.map((s) => ({ reason: s.skip_reason, count: s.n })),
    blocked: byState.blocked ?? 0,
  };
}

/** Plain-language reasons. M74 asks for skipped-file reasons the owner can act
 * on, and a vocabulary token is not that. */
export const SKIP_EXPLANATIONS: Record<SkipReason, string> = {
  encrypted: 'This file is encrypted. Josi never asks for document passwords, so it was left alone.',
  password_protected: 'This file is password-protected. Josi never asks for document passwords, so it was left alone.',
  too_large: 'This file is larger than the maximum your administrator set.',
  extension_not_allowed: 'Your administrator has not allowed this kind of file to be indexed.',
  archive_excluded: 'Archives are not indexed unless your administrator turns them on.',
  archive_limits_exceeded: 'This archive expanded past the limits your administrator set, so it was stopped part-way.',
  unreadable: 'Josi could not read this file.',
  malware_found: 'A malware scan flagged this file. It has been left exactly as it was, and nothing was read from it.',
  quota_exceeded: 'You have reached your storage limit, so this file was not indexed.',
  unsupported_type: 'Josi cannot read this kind of file yet.',
  credential_detected: 'This looks like a credential or recovery-code file, so Josi deliberately did not index it.',
};
