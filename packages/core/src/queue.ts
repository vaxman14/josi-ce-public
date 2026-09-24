// The job queue and the scheduler.
//
// Ported from the engine with `tenant_id` dropped. Job payloads carry ids only:
// a queue row is infrastructure and is readable by anything that can reach the
// database, so putting a message body in one would route around every ownership
// check in the product.
import { json, type Db } from './db.js';

export interface Job {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueue(
  db: Db,
  args: { kind: string; payload?: Record<string, unknown>; runAt?: Date },
): Promise<number> {
  const rows = await db.query<{ id: number }>(
    `insert into job_queue (kind, payload, run_at) values ($1, $2, $3) returning id`,
    [args.kind, json(args.payload), (args.runAt ?? new Date()).toISOString()],
  );
  return rows[0].id;
}

/** Claim due jobs with SKIP LOCKED, so many stateless workers can poll the same
 * table without handing the same job to two of them. */
export async function claimJobs(db: Db, workerId: string, limit = 5): Promise<Job[]> {
  return db.query<Job>(
    `update job_queue set status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1
     where id in (
       select id from job_queue
       where ((status = 'queued' and run_at <= now())
          or (status = 'running' and kind = 'assistant.turn' and locked_at < now() - interval '10 minutes'
            and exists(select 1 from assistant_turns stale where stale.id::text=job_queue.payload->>'turnId'
              and (stale.status='queued' or (stale.status='running' and stale.lease_expires_at<now())))))
         and (kind <> 'assistant.turn' or not exists (
           select 1 from assistant_turns current_turn join assistant_turns earlier on earlier.thread_id=current_turn.thread_id
           where current_turn.id::text=job_queue.payload->>'turnId' and earlier.id<>current_turn.id
             and earlier.status in ('queued','running') and (earlier.created_at,earlier.id)<(current_turn.created_at,current_turn.id)
         ))
       order by run_at
       for update skip locked
       limit $2
     )
     returning *`,
    [workerId, limit],
  );
}

export async function renewJobLease(db:Db,jobId:number,workerId:string):Promise<boolean>{
  return !!(await db.query(`update job_queue set locked_at=now() where id=$1 and status='running' and locked_by=$2 returning id`,[jobId,workerId])).length;
}

export async function completeJob(db: Db, jobId: number, workerId?: string): Promise<void> {
  await db.query(`update job_queue set status = 'done' where id = $1 and ($2::text is null or locked_by=$2)`, [jobId,workerId??null]);
}

/** Exponential backoff to `max_attempts`, then dead.
 *
 * `last_error` is truncated and comes from our own code paths; a provider's
 * error text can quote the request that caused it, so callers pass a category,
 * not a raw provider body. */
export async function failJob(db: Db, jobId: number, error: string, workerId?: string): Promise<void> {
  await db.query(
    `update job_queue set
       status = case when attempts >= max_attempts then 'dead' else 'queued' end,
       run_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts))),
       last_error = $2,
       locked_at = null, locked_by = null
     where id = $1 and ($3::text is null or locked_by=$3)`,
    [jobId, error.slice(0, 2000),workerId??null],
  );
}

/** Turn due interval schedules into concrete jobs. */
export async function tickSchedules(db: Db): Promise<number> {
  const due = await db.query<{ kind: string; payload: Record<string, unknown> }>(
    `update schedules set next_run_at = case
       when interval_seconds is not null then now() + make_interval(secs => interval_seconds)
       else next_run_at end
     where enabled and next_run_at <= now()
     returning kind, payload`,
  );
  for (const s of due) {
    await enqueue(db, { kind: s.kind, payload: s.payload });
  }
  return due.length;
}
