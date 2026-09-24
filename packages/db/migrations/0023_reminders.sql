-- Reminders: the assistant's first scheduled capability.
--
-- A person says "remind me in five minutes" and something must actually happen
-- five minutes later. The machinery already exists — job_queue carries a
-- run_at and the worker drains it — so a reminder is a row of content plus a
-- queued delivery job that names it by id.
--
-- Content lives HERE, owned, and never in the job payload: a queue row is
-- infrastructure, readable by anything that can reach the database, and the
-- text of a reminder is the owner's business (same rule as messages).
create table reminders (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  -- The conversation it was asked in, so delivery lands where the request was
  -- made. Nullable: the thread may be deleted out from under it, and a
  -- reminder that survives its thread is still owed to its owner.
  thread_id uuid references threads(id) on delete set null,
  body text not null,
  due_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'delivered', 'cancelled', 'failed')),
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index reminders_owner on reminders (owner_user_id, status);
create index reminders_due on reminders (due_at) where status = 'scheduled';
