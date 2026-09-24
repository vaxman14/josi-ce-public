-- Fail-closed approval defaults.
--
-- Until now, an installation with no rows in `admin_approval_policy` had NO
-- ceiling: `getApprovalLevel` read a missing row as `automatic`. The user
-- default of `always_ask` made that look safe, and it was not — a user who set
-- themselves to `automatic` for a class nobody had configured got exactly that,
-- and Josi could send mail on their behalf without anyone having decided it
-- was allowed.
--
-- Two things change here:
--
--   1. Every known action class gets an explicit `always_ask` ceiling if it has
--      none. `on conflict do nothing` means an administrator's existing,
--      deliberate choice is never overwritten — this seeds the gaps, it does
--      not reset the policy.
--
--   2. Every gap it fills is RECORDED. Seeding a ceiling where there was none
--      is a narrowing, and a narrowing an administrator cannot see is how a
--      product starts refusing to do things for reasons nobody can explain.
--      The rows below are shown on the policy page and on the launch checklist
--      until they are acknowledged.
--
-- Idempotent: re-running inserts nothing, because every class already conflicts,
-- and therefore logs nothing.

create table if not exists approval_policy_migration (
  id bigserial primary key,
  action_class text not null,
  -- Null means there was no administrator policy for this class at all, which
  -- is the case this migration exists for.
  previous_max_level text,
  new_max_level text not null,
  reason text not null,
  migrated_at timestamptz not null default now(),
  acknowledged_at timestamptz
);

create index if not exists approval_policy_migration_unack
  on approval_policy_migration (acknowledged_at) where acknowledged_at is null;

-- The factory ceilings. Every one is `always_ask`; see ACTION_CLASSES in
-- packages/core/src/approvals.ts, which is the source this list mirrors and
-- which a test asserts against so the two cannot drift.
with factory (action_class, max_level) as (
  values
    ('email_send',        'always_ask'),
    ('calendar_write',    'always_ask'),
    ('contacts_write',    'always_ask'),
    ('task_management',   'always_ask'),
    ('delete_data',       'always_ask'),
    ('cancel_commitment', 'always_ask'),
    ('invite_external',   'always_ask'),
    ('publish_public',    'always_ask'),
    ('spend_money',       'always_ask'),
    ('sign_agreement',    'always_ask'),
    ('change_access',     'always_ask')
),
seeded as (
  insert into admin_approval_policy (action_class, max_level)
  select action_class, max_level from factory
  on conflict (action_class) do nothing
  returning action_class, max_level
)
insert into approval_policy_migration (action_class, previous_max_level, new_max_level, reason)
select
  s.action_class,
  null,
  s.max_level,
  'No administrator had set a ceiling for this action, which previously meant no ceiling at all. '
  || 'It now asks for approval. Loosen it deliberately if that is not what you want.'
from seeded s;
