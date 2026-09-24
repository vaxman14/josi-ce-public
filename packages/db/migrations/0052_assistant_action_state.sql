-- Durable conversational action state. A prepared write is not chat context:
-- it is an owner/thread/domain/operation-scoped object pinned to one task and
-- one exact approval. This prevents a later "yes" from selecting a name or
-- target out of unrelated model history.
create table assistant_action_states (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  domain text not null check (domain in ('email','calendar','contacts')),
  operation text not null check (operation in ('send','create','update')),
  status text not null default 'collecting' check (status in (
    'collecting','prepared','approved','executing','succeeded','failed','denied','expired','superseded'
  )),
  task_id uuid not null unique references tasks(id) on delete cascade,
  approval_id uuid unique references approvals(id) on delete set null,
  source_turn_id uuid references messages(id) on delete set null,
  presented_turn_id uuid references messages(id) on delete set null,
  payload_hash text,
  expires_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_action_owner_thread
  on assistant_action_states(owner_user_id,thread_id,created_at desc);
create unique index assistant_action_one_collecting
  on assistant_action_states(owner_user_id,thread_id,domain,operation)
  where status='collecting';
create trigger assistant_action_states_touch before update on assistant_action_states
  for each row execute function touch_updated_at();
alter table assistant_action_states enable row level security;
