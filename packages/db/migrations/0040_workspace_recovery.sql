-- Repair completed installations whose setup latch was closed before the
-- singleton workspace row was created. Existing workspace data wins.
insert into workspace (id, name, timezone, settings)
select true,
       coalesce(nullif(u.display_name, ''), nullif(u.username, ''), 'My workspace'),
       'UTC',
       case when d.domain is null or d.domain = '' then '{}'::jsonb
            else jsonb_build_object('publicAddress', d.domain) end
from (select 1) seed
left join lateral (
  select username, display_name from users where role = 'super_admin' limit 1
) u on true
left join deployment_config d on d.id = true
where exists (select 1 from setup_state where id = true and completed = true)
on conflict (id) do nothing;
