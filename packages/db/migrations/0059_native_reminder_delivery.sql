-- Revision-fenced, server-authoritative reminder delivery.
alter table mobile_devices add column owner_binding text;
alter table push_deliveries add column route_thread_id uuid;

alter table reminders
  add column timezone text not null default 'UTC',
  add column revision bigint not null default 1 check (revision > 0),
  add column updated_at timestamptz not null default now();

create trigger reminders_touch before update on reminders
  for each row execute function touch_updated_at();

-- A queued revision is infrastructure, not content. It prevents an old queue
-- row from delivering an edited reminder at its former due instant.
update job_queue q set payload = q.payload || jsonb_build_object('revision', r.revision)
from reminders r
where q.kind = 'reminder.deliver'
  and q.payload->>'reminderId' = r.id::text
  and not (q.payload ? 'revision');
