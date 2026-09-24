// The processing queue: extraction, OCR, scanning, indexing.
//
// M52/M53 are both about not destroying the machine Josi runs on. OCR is
// bundled but disabled, super-admin only, throttled, and restrictable to
// configured hours — because the plan targets Pi-class hardware, and OCR on a
// Pi will happily consume the box for hours while somebody is trying to use it.
//
// M75 is about not destroying the machine's usefulness: the global pause stops
// NEW work and deletes nothing, so search over what is already built keeps
// working while the operator sorts out whatever went wrong.
import { appendEvent, type Db } from '@josi-ce/core';
import { withinHours } from './gates.js';

export type JobKind = 'extract' | 'ocr' | 'scan' | 'index';
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

export type JobErrorCategory =
  | 'unreadable' | 'encrypted' | 'too_large' | 'timeout' | 'malware_found'
  | 'out_of_hours' | 'paused' | 'quota_exceeded' | 'unknown';

export interface QueuePolicy {
  processing_paused: boolean;
  ocr_enabled: boolean;
  ocr_max_concurrency: number;
  ocr_hours_start: number | null;
  ocr_hours_end: number | null;
}

/** Why this job may not run right now, or null if it may.
 *
 * Returning a REASON rather than a boolean is deliberate: M74 asks for status
 * an owner can understand, and "paused" and "outside the hours your
 * administrator set" are different things to be told. */
export function blockedReason(
  policy: QueuePolicy,
  args: { kind: JobKind; hour: number },
): JobErrorCategory | null {
  // M75: the pause stops everything new. It is checked first so that a paused
  // installation gives one consistent answer rather than a different one per
  // job kind.
  if (policy.processing_paused) return 'paused';

  if (args.kind === 'ocr') {
    // M52: users cannot override this. There is no per-user OCR setting
    // anywhere — the capability does not exist, so there is nothing to override.
    if (!policy.ocr_enabled) return 'unreadable';
    if (!withinHours(policy, args.hour)) return 'out_of_hours';
  }
  return null;
}

/** M53: how many may run at once.
 *
 * OCR has its own ceiling because it is the expensive one; everything else
 * shares a modest default. On a single-core Pi the honest answer is 1. */
export function concurrencyFor(policy: QueuePolicy, kind: JobKind): number {
  if (kind === 'ocr') return Math.max(1, policy.ocr_max_concurrency);
  return 2;
}

export async function enqueue(
  db: Db,
  args: { documentId: string; ownerUserId: string; kind: JobKind },
): Promise<{ id: string; created: boolean }> {
  // The partial unique index refuses a second live job of the same kind. A
  // rescan queueing a second extraction while the first runs is how a queue
  // becomes a thrash on hardware with one core.
  const rows = await db.query<{ id: string }>(
    `insert into processing_jobs (document_id, owner_user_id, kind)
     values ($1, $2, $3)
     on conflict (document_id, kind) where state in ('queued', 'running')
       do nothing
     returning id`,
    [args.documentId, args.ownerUserId, args.kind],
  );
  if (rows.length) return { id: rows[0].id, created: true };

  const [existing] = await db.query<{ id: string }>(
    `select id from processing_jobs
     where document_id = $1 and kind = $2 and state in ('queued', 'running')`,
    [args.documentId, args.kind],
  );
  return { id: existing.id, created: false };
}

/** Take the next runnable job, or nothing.
 *
 * `for update skip locked` so two workers never take the same job. Without it,
 * the same document gets OCR'd twice on a machine that could barely afford it
 * once. */
export async function claimNext(
  db: Db,
  args: { policy: QueuePolicy; kind: JobKind; hour: number },
): Promise<{ id: string; document_id: string; owner_user_id: string } | null> {
  const blocked = blockedReason(args.policy, { kind: args.kind, hour: args.hour });
  if (blocked) return null;

  const running = await db.query<{ n: number }>(
    `select count(*)::int as n from processing_jobs where kind = $1 and state = 'running'`,
    [args.kind],
  );
  if ((running[0]?.n ?? 0) >= concurrencyFor(args.policy, args.kind)) return null;

  const [row] = await db.query<{ id: string; document_id: string; owner_user_id: string }>(
    `update processing_jobs set state = 'running', started_at = now(), attempts = attempts + 1
     where id = (
       select id from processing_jobs
       where kind = $1 and state = 'queued'
       order by queued_at
       for update skip locked
       limit 1
     )
     returning id, document_id, owner_user_id`,
    [args.kind],
  );
  return row ?? null;
}

export async function finishJob(
  db: Db,
  args: { jobId: string; state: 'done' | 'failed' | 'skipped'; errorCategory?: JobErrorCategory },
): Promise<void> {
  await db.query(
    `update processing_jobs set state = $2, error_category = $3, finished_at = now()
     where id = $1`,
    [args.jobId, args.state, args.errorCategory ?? null],
  );
}

/** M75: stop new work, delete nothing.
 *
 * The test that matters is not that this sets a flag — it is that search still
 * answers afterwards. An operator pausing processing because the box is
 * struggling has not asked to lose their index. */
export async function setGlobalPause(
  db: Db,
  args: { paused: boolean; byUserId: string },
): Promise<void> {
  await db.query(`update storage_policy set processing_paused = $1 where id = true`, [args.paused]);
  await appendEvent(db, {
    actorUserId: args.byUserId,
    actor: 'super_admin',
    kind: args.paused ? 'storage.processing_paused' : 'storage.processing_resumed',
    payload: {},
  });
}

export async function queuePolicy(db: Db): Promise<QueuePolicy> {
  const [row] = await db.query<QueuePolicy>(
    `select processing_paused, ocr_enabled, ocr_max_concurrency, ocr_hours_start, ocr_hours_end
     from storage_policy where id = true`,
  );
  return row;
}

/** M74: aggregate queue health for the administrator. Counts and categories,
 * never a document id turned into a filename. */
export async function queueHealth(db: Db): Promise<{
  byKind: Array<{ kind: string; state: string; n: number }>;
  failures: Array<{ error_category: string; n: number }>;
}> {
  const byKind = await db.query<{ kind: string; state: string; n: number }>(
    `select kind, state, count(*)::int as n from processing_jobs
     group by kind, state order by kind, state`,
  );
  const failures = await db.query<{ error_category: string; n: number }>(
    `select error_category, count(*)::int as n from processing_jobs
     where error_category is not null group by error_category order by n desc`,
  );
  return { byKind, failures };
}
