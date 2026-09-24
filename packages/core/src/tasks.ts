// The task state machine.
//
// Ported from the commercial engine (`packages/core/src/tasks.ts`). The
// transition table is byte-for-byte the same set of edges, deliberately: it is
// the part of the engine that has been run against real work, and inventing a
// second version of it is how two products drift into disagreeing about what
// "held" means.
//
// What changed for CE:
//   * `tenant_id` → `owner_user_id`. A task belongs to the person who asked for
//     it, not to the installation. See 0004_assistant.sql for why.
//   * Template lookup no longer joins a per-tenant enable/config table; one
//     workspace means `enabled` lives on the template row.
//   * `requires_capability` is new. Phase 5 ships no executors, so a task can
//     legitimately be ready with nothing able to attempt it, and the caller has
//     to be told that rather than shown a failure.
import { json, type Db } from './db.js';
import { appendEvent } from './events.js';

export type TaskState =
  | 'drafting'
  | 'awaiting_approval'
  | 'ready'
  | 'attempting'
  | 'held'
  | 'awaiting_owner'
  | 'confirmed'
  | 'failed'
  | 'cancelled'
  | 'closed';

/** Legal transitions. Anything not listed throws — the assistant never
 * wanders. */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  drafting: ['awaiting_approval', 'ready', 'cancelled'],
  awaiting_approval: ['ready', 'cancelled'],
  ready: ['attempting', 'cancelled'],
  attempting: ['held', 'awaiting_owner', 'confirmed', 'ready', 'failed', 'cancelled'],
  held: ['attempting', 'awaiting_owner', 'confirmed', 'failed', 'cancelled'],
  awaiting_owner: ['ready', 'attempting', 'confirmed', 'cancelled', 'failed'],
  confirmed: ['closed'],
  failed: ['closed', 'ready'], // ready = the owner retries
  cancelled: ['closed'],
  closed: [],
};

/** States in which a task is finished and no longer waiting on anything. */
export const TERMINAL_STATES: readonly TaskState[] = ['confirmed', 'failed', 'cancelled', 'closed'];

export function legalTransitions(from: TaskState): readonly TaskState[] {
  return TRANSITIONS[from];
}

export interface TemplateContract {
  slots: { required: string[]; optional?: string[] };
  urgency_ceiling: 'push' | 'text' | 'call';
  confirm?: Record<string, boolean>;
  max_attempts?: number;
}

export interface Task {
  id: string;
  owner_user_id: string;
  template_key: string;
  state: TaskState;
  slots: Record<string, unknown>;
  contact_id: string | null;
  thread_id: string | null;
  urgency_ceiling: string;
  attempt_count: number;
  next_wake_at: string | null;
  fail_reason: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export class TaskError extends Error {}

export interface TemplateInfo {
  key: string;
  name: string;
  contract: TemplateContract;
  /** What must exist before this can be attempted. Null = nothing. */
  requiresCapability: string | null;
}

export async function getTemplate(db: Db, templateKey: string): Promise<TemplateInfo> {
  const rows = await db.query<{
    key: string; name: string; contract: TemplateContract; enabled: boolean; requires_capability: string | null;
  }>(
    `select key, name, contract, enabled, requires_capability from task_templates where key = $1`,
    [templateKey],
  );
  if (!rows.length) throw new TaskError(`unknown template ${templateKey}`);
  if (!rows[0].enabled) throw new TaskError(`template ${templateKey} is disabled on this installation`);
  return {
    key: rows[0].key,
    name: rows[0].name,
    contract: rows[0].contract,
    requiresCapability: rows[0].requires_capability,
  };
}

export async function getTemplateContract(db: Db, templateKey: string): Promise<TemplateContract> {
  return (await getTemplate(db, templateKey)).contract;
}

export async function listTemplates(db: Db): Promise<TemplateInfo[]> {
  const rows = await db.query<{
    key: string; name: string; contract: TemplateContract; requires_capability: string | null;
  }>(`select key, name, contract, requires_capability from task_templates where enabled order by key`);
  return rows.map((r) => ({
    key: r.key, name: r.name, contract: r.contract, requiresCapability: r.requires_capability,
  }));
}

/** Required slots with no value yet. An empty slot is a question for the owner,
 * never an attempt with a hole in it. */
export function missingSlots(contract: TemplateContract, slots: Record<string, unknown>): string[] {
  return contract.slots.required.filter(
    (k) => slots[k] === undefined || slots[k] === null || slots[k] === '',
  );
}

export async function createTask(
  db: Db,
  args: {
    ownerUserId: string;
    templateKey: string;
    slots?: Record<string, unknown>;
    contactId?: string | null;
    threadId?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<Task> {
  const template = await getTemplate(db, args.templateKey);
  const slots = args.slots ?? {};
  const rows = await db.query<Task>(
    `insert into tasks (owner_user_id, template_key, slots, contact_id, thread_id, urgency_ceiling, meta)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [
      args.ownerUserId,
      args.templateKey,
      json(slots),
      args.contactId ?? null,
      args.threadId ?? null,
      template.contract.urgency_ceiling,
      json(args.meta),
    ],
  );
  const task = rows[0];
  // Slot VALUES are content — a phone number, what someone wants. The audit
  // trail gets the shape of the task and the names of what is missing, which is
  // what an administrator needs, and nothing a colleague could read.
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'task.created',
    subjectType: 'task',
    subjectId: task.id,
    payload: { template: args.templateKey, missing: missingSlots(template.contract, slots) },
  });
  return task;
}

export async function getTask(db: Db, taskId: string): Promise<Task> {
  const rows = await db.query<Task>(`select * from tasks where id = $1`, [taskId]);
  if (!rows.length) throw new TaskError(`no task ${taskId}`);
  return rows[0];
}

export async function transition(
  db: Db,
  taskId: string,
  to: TaskState,
  opts: {
    actor?: 'system' | 'agent' | 'user';
    actorUserId?: string | null;
    reason?: string;
    wakeAt?: Date | null;
  } = {},
): Promise<Task> {
  const task = await getTask(db, taskId);
  if (!TRANSITIONS[task.state].includes(to)) {
    throw new TaskError(`illegal transition ${task.state} -> ${to} (task ${taskId})`);
  }
  const rows = await db.query<Task>(
    `update tasks set state = $2, next_wake_at = $3, fail_reason = coalesce($4, fail_reason)
     where id = $1 returning *`,
    [taskId, to, opts.wakeAt ?? null, to === 'failed' ? (opts.reason ?? 'unspecified') : null],
  );
  await appendEvent(db, {
    actorUserId: opts.actorUserId ?? null,
    actor: opts.actor ?? 'system',
    kind: 'task.transition',
    subjectType: 'task',
    subjectId: taskId,
    payload: { from: task.state, to, reason: opts.reason ?? null },
  });
  return rows[0];
}

export async function setSlots(
  db: Db,
  taskId: string,
  patch: Record<string, unknown>,
  opts: { actor?: 'agent' | 'user' | 'system'; actorUserId?: string | null; removeKeys?: string[] } = {},
): Promise<Task> {
  const task = await getTask(db, taskId);
  const merged = { ...task.slots };
  for (const key of opts.removeKeys ?? []) delete merged[key];
  Object.assign(merged, patch);
  const rows = await db.query<Task>(
    `update tasks set slots = $2 where id = $1 returning *`,
    [taskId, json(merged)],
  );
  // Key names, never values.
  await appendEvent(db, {
    actorUserId: opts.actorUserId ?? null,
    actor: opts.actor ?? 'agent',
    kind: 'task.slots_updated',
    subjectType: 'task',
    subjectId: taskId,
    payload: { keys: [...new Set([...Object.keys(patch), ...(opts.removeKeys ?? [])])] },
  });
  return rows[0];
}

export async function recordAttempt(
  db: Db,
  args: { taskId: string; kind: string; outcome: string; detail?: Record<string, unknown> },
): Promise<void> {
  await db.query(
    `insert into task_attempts (task_id, kind, ended_at, outcome, detail)
     values ($1, $2, now(), $3, $4)`,
    [args.taskId, args.kind, args.outcome, json(args.detail)],
  );
  await db.query(`update tasks set attempt_count = attempt_count + 1 where id = $1`, [args.taskId]);
  await appendEvent(db, {
    actor: 'system',
    kind: 'task.attempt',
    subjectType: 'task',
    subjectId: args.taskId,
    payload: { kind: args.kind, outcome: args.outcome },
  });
}

/** Tasks this person may act on. Owner-scoped, so a list endpoint and a
 * single-item guard cannot disagree about what is visible. */
export async function listTasksFor(
  db: Db,
  args: { ownerUserId: string; includeClosed?: boolean; limit?: number },
): Promise<Task[]> {
  return db.query<Task>(
    `select * from tasks
     where owner_user_id = $1
       and ($2::boolean or state not in ('closed', 'confirmed', 'cancelled', 'failed'))
     order by created_at desc limit $3`,
    [args.ownerUserId, args.includeClosed ?? false, Math.min(200, args.limit ?? 50)],
  );
}
