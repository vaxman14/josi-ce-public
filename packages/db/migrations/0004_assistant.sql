-- Josi CE 0004: the assistant itself.
--
-- Ported from the commercial engine's schema, with one change that touches
-- almost every table here and is the reason this migration needed thinking
-- about rather than translating.
--
-- THE ISOLATION DECISION
--
-- The engine's tables hang off `tenant_id`. Inside one tenant, everyone sees
-- everything: staff share the business's contacts, conversations and tasks,
-- because they ARE the business. `docs/EXTRACTION_MAP.md` carried that forward
-- and said contacts, tasks and threads would be workspace-shared in CE too.
--
-- That is wrong here, and the canonical decision map says so repeatedly in
-- every neighbouring feature:
--
--   * "Operational email threads and inbound replies are visible only to the
--      user who initiated the conversation by default... neither workspace
--      membership nor super-admin status automatically grants content access."
--   * "Every mapped local/cloud folder and its derived index are private to the
--      owning user by default."
--   * "the admin panel must not let them browse that user's email or calendar
--      content."
--
-- A CE workspace is not one business speaking with one voice; it is several
-- people who happen to share an installation. Alice's conversation with Josi is
-- Alice's — it carries whatever she told it, which is exactly the material the
-- map protects everywhere else. Shipping it workspace-readable by default would
-- make the one table nobody thought about the leak.
--
-- So: `contacts`, `threads` and `tasks` are owner-scoped and shareable through
-- the Phase 1 spine, like `folder_mappings` and `email_threads` before them.
-- `messages` inherit their thread's ownership rather than carrying their own,
-- so a share can never be half-applied.
--
-- The deviation from the extraction map is deliberate and recorded in
-- PHASE_5_EVIDENCE.md.

-- ---------- contacts ----------
-- A person Josi might contact on the owner's behalf. Private: a contact record
-- is as revealing as the conversation that produced it.
create table contacts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text,
  phone text,
  email text,
  notes jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contacts_owner on contacts (owner_user_id, created_at desc);
create trigger contacts_touch before update on contacts
  for each row execute function touch_updated_at();

-- ---------- conversation ----------
-- A thread is one person's running conversation with Josi. `contact_id` marks
-- a thread about a third party; a thread with no contact is the owner talking
-- to their assistant.
create table threads (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  title text,
  status text not null default 'open' check (status in ('open', 'closed')),
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index threads_owner on threads (owner_user_id, last_activity_at desc);

-- Message bodies are content. There is deliberately no owner column: a message
-- is reachable only through its thread, so the thread's share decides who may
-- read it and there is no second place for that answer to drift.
create table messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references threads(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  channel text not null default 'web',
  body text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index messages_thread on messages (thread_id, created_at);

-- ---------- task templates ----------
-- The catalogue is a definition, not content, so it is installation-wide and
-- has no owner. The engine had a second per-tenant table to enable/disable
-- templates; CE has one workspace, so `enabled` lives on the row.
create table task_templates (
  key text primary key,
  name text not null,
  version int not null default 1,
  -- Required/optional slots, urgency ceiling, attempt limits.
  contract jsonb not null,
  enabled boolean not null default true,
  -- What has to exist before a task of this kind can actually be attempted.
  -- Phase 5 ships the state machine; the things that DO the work arrive in
  -- Phase 7 (calendar) and Phase 8 (mail). A task whose requirement is missing
  -- stops at `ready` and says so, rather than failing in a way that reads like
  -- the assistant tried and could not.
  requires_capability text
);

-- ---------- tasks ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  template_key text not null references task_templates(key),
  state text not null default 'drafting' check (state in (
    'drafting', 'awaiting_approval', 'ready', 'attempting', 'held',
    'awaiting_owner', 'confirmed', 'failed', 'cancelled', 'closed'
  )),
  slots jsonb not null default '{}',
  thread_id uuid references threads(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  urgency_ceiling text not null default 'push',
  attempt_count int not null default 0,
  next_wake_at timestamptz,
  due_at timestamptz,
  fail_reason text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_owner on tasks (owner_user_id, state);
create index tasks_due on tasks (next_wake_at)
  where state not in ('confirmed', 'failed', 'cancelled', 'closed');
create trigger tasks_touch before update on tasks
  for each row execute function touch_updated_at();

create table task_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  kind text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index task_attempts_task on task_attempts (task_id, created_at);

-- ---------- approval gates ----------
-- M31-33. Per action class, a user chooses how much Josi may do without
-- asking; the super admin sets a ceiling that can only tighten.
--
-- The two columns are deliberately different shapes. A user's preference is
-- their consent. The admin's is a maximum. `effectiveApprovalLevel` in
-- core/approvals.ts takes the stricter of the two, and there is a truth table
-- asserting that admin "automatic" cannot loosen a user's "always ask".
create table user_approval_prefs (
  user_id uuid not null references users(id) on delete cascade,
  action_class text not null,
  level text not null check (level in ('always_ask', 'risky_only', 'automatic')),
  updated_at timestamptz not null default now(),
  primary key (user_id, action_class)
);
create trigger user_approval_prefs_touch before update on user_approval_prefs
  for each row execute function touch_updated_at();

create table admin_approval_policy (
  action_class text primary key,
  -- The LOOSEST the admin permits. Never a grant.
  max_level text not null check (max_level in ('always_ask', 'risky_only', 'automatic')),
  updated_at timestamptz not null default now()
);
create trigger admin_approval_policy_touch before update on admin_approval_policy
  for each row execute function touch_updated_at();

-- One pending decision. The summary is what the owner is shown before they
-- agree; it is content, and it is theirs, which is why this table is reachable
-- only through the task it belongs to.
create table approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  action_class text not null,
  action text not null,
  -- What will happen if this is approved, in the owner's words. Shown, then
  -- hashed: an approval that does not pin the exact action is a rubber stamp.
  summary text not null,
  payload_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired')),
  decided_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_owner on approvals (owner_user_id, status, created_at desc);
create index approvals_task on approvals (task_id);
-- One live request per task+action. A second "shall I?" for the same thing is
-- a bug that trains people to click yes.
create unique index approvals_one_pending
  on approvals (task_id, action, payload_hash)
  where status = 'pending';

-- ---------- holds and locks ----------
create table holds (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  resource_key text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  external_ref text,
  status text not null default 'active' check (status in ('active', 'converted', 'released', 'expired')),
  -- TTL, so a crashed task can never leave a phantom block on a calendar.
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index holds_status on holds (status);
create index holds_expiry on holds (expires_at) where status = 'active';

-- Exclusive per-resource lock. Two tasks reaching for the same Thursday 3pm is
-- the default failure mode; this makes it impossible.
create table resource_locks (
  resource_key text primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------- scheduler ----------
-- Infrastructure, not content: no owner. Payloads carry ids, never bodies.
create table job_queue (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now()
);
create index job_queue_due on job_queue (run_at) where status = 'queued';

create table schedules (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}',
  interval_seconds int,
  next_run_at timestamptz not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index schedules_due on schedules (next_run_at) where enabled;

-- ---------- step-up verification ----------
-- The engine gated destructive actions behind a spoken PIN word because caller
-- ID is spoofable and a phone call is all the identity a voice line has.
--
-- CE has no phone line. A request arrives with a session cookie issued after a
-- password login, so the threat is different: a session someone else is
-- holding — a borrowed laptop, a stolen cookie, an open tab. The answer to that
-- is re-authentication, not a second secret to remember.
--
-- Named honestly: this is step-up RE-AUTH. It proves the person at the keyboard
-- knows the account password. It does not defend against a stolen password, and
-- calling it a second factor would imply that it does. A real second factor
-- (TOTP) is not built; see PHASE_5_EVIDENCE.md.
create table step_up_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  -- What this unlock covers: a thread, a session, one API client.
  session_key text not null,
  method text not null check (method in ('password')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index step_up_lookup on step_up_verifications (user_id, session_key, expires_at desc);

alter table contacts enable row level security;
alter table threads enable row level security;
alter table messages enable row level security;
alter table tasks enable row level security;
alter table task_attempts enable row level security;
alter table approvals enable row level security;
alter table holds enable row level security;
alter table step_up_verifications enable row level security;

-- ---------- seed templates ----------
-- Deliberately few. Each one names the capability that has to exist before it
-- can be attempted, and Phase 5 ships none of those capabilities — so these
-- reach `ready` and wait, which is the honest state for work nothing can do
-- yet.
insert into task_templates (key, name, contract, requires_capability) values
  ('schedule_appointment', 'Schedule an appointment',
   '{"slots":{"required":["contact_name","service","time_options"],"optional":["contact_phone","contact_email","notes"]},"urgency_ceiling":"text","max_attempts":3}',
   'calendar_write'),
  ('send_message', 'Send a message on my behalf',
   '{"slots":{"required":["recipient","subject","body_brief"],"optional":["cc"]},"urgency_ceiling":"text","max_attempts":2}',
   'email_send'),
  ('follow_up', 'Follow up on something',
   '{"slots":{"required":["what","when"],"optional":["contact_name","notes"]},"urgency_ceiling":"push","max_attempts":3}',
   null);
