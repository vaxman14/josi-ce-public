// Resource locks and calendar holds.
//
// Ported from the engine with `tenant_id` removed: a CE installation is one
// calendar-space, so a resource key is unique installation-wide. That is the
// correct scope rather than a simplification — two members booking the same
// room at the same time is exactly the collision this prevents, and scoping the
// lock per user would let it through.
import type { Db } from './db.js';
import { appendEvent } from './events.js';

export class LockError extends Error {}

/** Exclusive per-resource lock. Expired locks are reaped on acquisition, so a
 * crashed task can never wedge a resource permanently. */
export async function acquireLock(
  db: Db,
  args: { resourceKey: string; taskId: string; ttlSeconds?: number },
): Promise<boolean> {
  const ttl = args.ttlSeconds ?? 300;
  await db.query(`delete from resource_locks where resource_key = $1 and expires_at < now()`, [
    args.resourceKey,
  ]);
  const rows = await db.query(
    `insert into resource_locks (resource_key, task_id, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     on conflict (resource_key) do nothing
     returning task_id`,
    [args.resourceKey, args.taskId, ttl],
  );
  return rows.length > 0;
}

export async function releaseLock(
  db: Db,
  args: { resourceKey: string; taskId: string },
): Promise<void> {
  await db.query(`delete from resource_locks where resource_key = $1 and task_id = $2`, [
    args.resourceKey,
    args.taskId,
  ]);
}

// ---------- holds ----------

export interface Hold {
  id: string;
  task_id: string;
  resource_key: string;
  starts_at: string;
  ends_at: string;
  status: string;
  expires_at: string;
  external_ref: string | null;
}

export async function placeHold(
  db: Db,
  args: {
    taskId: string;
    resourceKey: string;
    startsAt: Date;
    endsAt: Date;
    ttlSeconds: number;
    externalRef?: string;
  },
): Promise<Hold> {
  const rows = await db.query<Hold>(
    `insert into holds (task_id, resource_key, starts_at, ends_at, expires_at, external_ref)
     values ($1, $2, $3, $4, now() + make_interval(secs => $5), $6) returning *`,
    [
      args.taskId,
      args.resourceKey,
      args.startsAt.toISOString(),
      args.endsAt.toISOString(),
      args.ttlSeconds,
      args.externalRef ?? null,
    ],
  );
  await appendEvent(db, {
    actor: 'system',
    kind: 'hold.placed',
    subjectType: 'task',
    subjectId: args.taskId,
    payload: { holdId: rows[0].id, resource: args.resourceKey },
  });
  return rows[0];
}

export async function settleHold(
  db: Db,
  holdId: string,
  status: 'converted' | 'released',
): Promise<void> {
  const rows = await db.query<Hold>(
    `update holds set status = $2 where id = $1 and status = 'active' returning *`,
    [holdId, status],
  );
  if (rows.length) {
    await appendEvent(db, {
      actor: 'system',
      kind: `hold.${status}`,
      subjectType: 'task',
      subjectId: rows[0].task_id,
      payload: { holdId },
    });
  }
}

/** Reap TTL-expired holds. Returns them so the caller can also delete the
 * external calendar events by `external_ref` — a hold that expired in our
 * database but not on the calendar is worse than no hold at all. */
export async function expireHolds(db: Db): Promise<Hold[]> {
  const rows = await db.query<Hold>(
    `update holds set status = 'expired'
     where status = 'active' and expires_at < now() returning *`,
  );
  for (const h of rows) {
    await appendEvent(db, {
      actor: 'system',
      kind: 'hold.expired',
      subjectType: 'task',
      subjectId: h.task_id,
      payload: { holdId: h.id, externalRef: h.external_ref },
    });
  }
  return rows;
}
