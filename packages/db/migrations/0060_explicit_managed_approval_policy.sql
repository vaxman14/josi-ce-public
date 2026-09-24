-- A managed ceiling must be an explicit, auditable administrator decision.
-- Persist that fact on the policy row: runtime enforcement must not depend on
-- retaining and repeatedly scanning an event payload. Historical seed rows are
-- retained as provenance but remain inert unless their administrator action is
-- evidenced by the existing audit trail.

alter table admin_approval_policy
  add column if not exists managed_explicitly boolean not null default false;

update admin_approval_policy p
set managed_explicitly = true
where not p.managed_explicitly
  and exists (
    select 1 from events e
    where e.kind in ('approval.ceiling_set','approval.ceiling_relaxed')
      and e.payload->>'actionClass' = p.action_class
      and e.payload->>'maxLevel' = p.max_level
  );

-- The old migration notice described the seeded ceiling we just removed.
update approval_policy_migration
set acknowledged_at = coalesce(acknowledged_at, now())
where acknowledged_at is null;

alter table assistant_action_states
  add column if not exists authorization_kind text not null default 'approval'
  check (authorization_kind in ('approval','user_policy'));
