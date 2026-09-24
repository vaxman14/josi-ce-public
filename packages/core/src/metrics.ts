// Is this thing actually working?
//
// Ported from the engine, whose reasoning is kept in full because it is the
// point of the file:
//
//   **Interrupt rate** — of the tasks it took on, how many did it have to bring
//   back to the owner? That is the cost of running it.
//
//   **Correction rate** — of the tasks the owner LOOKED AT, how many did they
//   have to fix? That is whether it can be trusted when it does act.
//
//   They are published together and the correction denominator is deliberately
//   "reviewed", not "all tasks". Score corrections over every task and an agent
//   that never asks anything looks flawless; score interrupts alone and an agent
//   that silently does the wrong thing looks efficient. Each number covers the
//   other's blind spot, so neither is quotable on its own.
//
// Both are derived from the event log rather than a side table: there is no way
// to make the metric say something the log does not.
//
// CE change: scoped per owner instead of per tenant. A member sees how Josi is
// doing for THEM. The super admin can see installation-wide totals — which is
// aggregate metadata, counts of state transitions, and contains nothing about
// what any task was about.
import type { Db } from './db.js';

export interface TemplateMetrics {
  template_key: string;
  tasks: number;
  interrupted: number;
  interrupt_rate: number;
  reviewed: number;
  corrected: number;
  correction_rate: number;
}

export interface TaskMetrics extends Omit<TemplateMetrics, 'template_key'> {
  window_days: number;
  by_template: TemplateMetrics[];
}

interface Row {
  template_key: string;
  tasks: string;
  interrupted: string;
  reviewed: string;
  corrected: string;
}

const rate = (n: number, d: number): number => (d === 0 ? 0 : Number((n / d).toFixed(4)));

/** A task "interrupted" its owner if it ever entered a state that waits on
 * them. Read off transition events rather than the task's current state,
 * because a task that bounced to the owner and then completed still cost them
 * an interruption.
 *
 * `ownerUserId` omitted = installation-wide, for the admin's health view. */
export async function taskMetrics(
  db: Db,
  args: { ownerUserId?: string | null; days?: number } = {},
): Promise<TaskMetrics> {
  const days = args.days ?? 30;
  const owner = args.ownerUserId ?? null;
  const rows = await db.query<Row>(
    `with scoped as (
       select k.id, k.template_key
       from tasks k
       where ($1::uuid is null or k.owner_user_id = $1)
         and k.created_at > now() - make_interval(days => $2)
     ),
     interrupted as (
       select distinct e.subject_id from events e
       where e.kind = 'task.transition' and e.subject_type = 'task'
         and e.payload->>'to' in ('awaiting_approval', 'awaiting_owner')
     ),
     reviewed as (
       -- "Reviewed" means the owner came back to the task, not that they
       -- created it. The engine got this free because its create event had no
       -- actor; CE records who created a task (that is worth auditing), so the
       -- creation kind is excluded here instead. Leaving it in made every task
       -- count as reviewed and quietly turned the correction rate into
       -- corrections-over-all-tasks — the exact denominator this file exists to
       -- avoid.
       select distinct e.subject_id from events e
       where e.actor = 'user' and e.subject_type = 'task'
         and e.kind <> 'task.created'
     ),
     corrected as (
       select distinct e.subject_id from events e
       where e.actor = 'user' and e.subject_type = 'task'
         and (e.kind = 'approval.denied'
              or e.kind = 'task.slots_updated'
              or (e.kind = 'task.transition' and e.payload->>'to' in ('cancelled', 'failed')))
     )
     select s.template_key,
            count(*) as tasks,
            count(*) filter (where s.id::text in (select subject_id from interrupted)) as interrupted,
            count(*) filter (where s.id::text in (select subject_id from reviewed)) as reviewed,
            count(*) filter (where s.id::text in (select subject_id from corrected)) as corrected
     from scoped s
     group by s.template_key
     order by s.template_key`,
    [owner, days],
  );

  const by_template = rows.map((r) => {
    const tasks = Number(r.tasks);
    const interrupted = Number(r.interrupted);
    const reviewed = Number(r.reviewed);
    const corrected = Number(r.corrected);
    return {
      template_key: r.template_key,
      tasks,
      interrupted,
      interrupt_rate: rate(interrupted, tasks),
      reviewed,
      corrected,
      correction_rate: rate(corrected, reviewed),
    };
  });

  const sum = (pick: (t: TemplateMetrics) => number) => by_template.reduce((a, t) => a + pick(t), 0);
  const tasks = sum((t) => t.tasks);
  const interrupted = sum((t) => t.interrupted);
  const reviewed = sum((t) => t.reviewed);
  const corrected = sum((t) => t.corrected);

  return {
    window_days: days,
    tasks,
    interrupted,
    interrupt_rate: rate(interrupted, tasks),
    reviewed,
    corrected,
    correction_rate: rate(corrected, reviewed),
    by_template,
  };
}
