// Threads, trash and retention.
//
// M39/M40. Two separate clocks, and they mean different things:
//
//   trash_days     — how long a thread the OWNER deleted stays recoverable.
//                    Their decision, undoable for a while.
//   retention_days — a workspace maximum the administrator may impose. Not
//                    their decision to undo, which is why anyone affected is
//                    shown the policy and warned before anything disappears.
import { appendEvent, type Db } from '@josi-ce/core';
import { newRoutingToken, mailPolicy } from './send.js';

export interface EmailThread {
  id: string;
  owner_user_id: string;
  subject: string;
  routing_token: string;
  status: 'open' | 'closed';
  deleted_at: string | null;
  purge_after: string | null;
  last_activity_at: string;
  created_at: string;
}

export async function createThread(
  db: Db,
  args: { ownerUserId: string; subject: string; participants?: string[] },
): Promise<EmailThread> {
  const [thread] = await db.query<EmailThread>(
    `insert into email_threads (owner_user_id, subject, routing_token) values ($1, $2, $3) returning *`,
    [args.ownerUserId, args.subject, newRoutingToken()],
  );
  for (const address of args.participants ?? []) {
    await db.query(
      `insert into email_participants (thread_id, address, added_by) values ($1, $2, $3)
       on conflict do nothing`,
      [thread.id, address.toLowerCase(), args.ownerUserId],
    );
  }
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'mail.thread_created',
    subjectType: 'email_thread',
    subjectId: thread.id,
    // Not the subject line: that is the conversation.
    payload: { participants: (args.participants ?? []).length },
  });
  return thread;
}

export async function listThreadsFor(
  db: Db,
  args: { ownerUserId: string; includeTrashed?: boolean },
): Promise<EmailThread[]> {
  return db.query<EmailThread>(
    `select * from email_threads
     where owner_user_id = $1 and ($2::boolean or deleted_at is null)
     order by last_activity_at desc limit 200`,
    [args.ownerUserId, args.includeTrashed ?? false],
  );
}

/** Deleting puts a thread in the trash. It does not destroy it — unless the
 * administrator configured immediate deletion, which is a choice they have to
 * make deliberately. */
export async function trashThread(
  db: Db,
  args: { threadId: string; actorUserId: string },
): Promise<{ recoverableUntil: string | null }> {
  const policy = await mailPolicy(db);
  if (policy.trash_days === 0) {
    await db.query(`delete from email_threads where id = $1`, [args.threadId]);
    await appendEvent(db, {
      actorUserId: args.actorUserId, actor: 'user', kind: 'mail.thread_purged',
      subjectType: 'email_thread', subjectId: args.threadId,
    });
    return { recoverableUntil: null };
  }
  const [row] = await db.query<{ purge_after: string }>(
    `update email_threads
     set deleted_at = now(), purge_after = now() + make_interval(days => $2)
     where id = $1 and deleted_at is null
     returning purge_after`,
    [args.threadId, policy.trash_days],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId, actor: 'user', kind: 'mail.thread_trashed',
    subjectType: 'email_thread', subjectId: args.threadId,
    payload: { trashDays: policy.trash_days },
  });
  return { recoverableUntil: row?.purge_after ?? null };
}

export async function restoreThread(
  db: Db,
  args: { threadId: string; actorUserId: string },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update email_threads set deleted_at = null, purge_after = null
     where id = $1 and deleted_at is not null returning id`,
    [args.threadId],
  );
  if (rows.length) {
    await appendEvent(db, {
      actorUserId: args.actorUserId, actor: 'user', kind: 'mail.thread_restored',
      subjectType: 'email_thread', subjectId: args.threadId,
    });
  }
  return rows.length > 0;
}

/** What retention will do, and when — so the person can be told before it
 * happens rather than after (M39). */
export async function retentionNotice(
  db: Db,
  ownerUserId: string,
): Promise<{ retentionDays: number | null; affected: number; earliest: string | null }> {
  const policy = await mailPolicy(db);
  if (policy.retention_days === null) {
    return { retentionDays: null, affected: 0, earliest: null };
  }
  const [row] = await db.query<{ affected: string; earliest: string | null }>(
    `select count(*)::text as affected, min(last_activity_at)::text as earliest
     from email_threads
     where owner_user_id = $1 and deleted_at is null
       and last_activity_at < now() - make_interval(days => $2)`,
    [ownerUserId, policy.retention_days],
  );
  return {
    retentionDays: policy.retention_days,
    affected: Number(row.affected),
    earliest: row.earliest,
  };
}

/** Run by the worker. Empties trash whose time is up, and applies the
 * workspace retention maximum.
 *
 * Returns counts rather than rows: a caller does not need the contents of what
 * was deleted, and neither does the log. */
export async function runRetention(db: Db): Promise<{ purged: number; expired: number }> {
  const purged = await db.query<{ id: string }>(
    `delete from email_threads
     where deleted_at is not null and purge_after is not null and purge_after < now()
     returning id`,
  );

  const policy = await mailPolicy(db);
  let expired: Array<{ id: string }> = [];
  if (policy.retention_days !== null) {
    expired = await db.query<{ id: string }>(
      `delete from email_threads
       where deleted_at is null and last_activity_at < now() - make_interval(days => $1)
       returning id`,
      [policy.retention_days],
    );
  }

  if (purged.length || expired.length) {
    await appendEvent(db, {
      actor: 'system',
      kind: 'mail.retention_ran',
      payload: { purged: purged.length, expired: expired.length },
    });
  }
  return { purged: purged.length, expired: expired.length };
}
