-- Internal calendar: the assistant talks only to these rows. Provider I/O is
-- asynchronous through an outbox and incremental pull origins.
create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  timezone text not null default 'UTC',
  color text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists calendars_owner on calendars(owner_user_id);
create unique index if not exists calendars_one_default
  on calendars(owner_user_id) where is_default;
create or replace trigger calendars_touch before update on calendars
  for each row execute function touch_updated_at();

create table if not exists calendar_sync_origins (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google','microsoft')),
  provider_account_id text,
  provider_calendar_id text not null,
  sync_mode text not null default 'two_way' check (sync_mode in ('import_only','two_way')),
  sync_cursor text,
  status text not null default 'idle' check (status in ('idle','syncing','error','paused','disconnected')),
  last_attempt_at timestamptz,
  last_sync_at timestamptz,
  last_error_category text,
  sync_interval_seconds int not null default 300 check (sync_interval_seconds between 60 and 86400),
  webhook_channel_id text,
  webhook_resource_id text,
  webhook_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id, provider_calendar_id)
);
create index if not exists calendar_sync_origins_owner on calendar_sync_origins(owner_user_id);
create index if not exists calendar_sync_origins_due on calendar_sync_origins(last_attempt_at)
  where status in ('idle','error');
create or replace trigger calendar_sync_origins_touch before update on calendar_sync_origins
  for each row execute function touch_updated_at();

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  calendar_id uuid not null references calendars(id) on delete cascade,
  title text,
  description text,
  location text,
  starts_at timestamptz,
  ends_at timestamptz,
  start_date date,
  end_date date,
  all_day boolean not null default false,
  timezone text not null default 'UTC',
  status text not null default 'confirmed',
  organizer text,
  attendees jsonb not null default '[]'::jsonb,
  recurrence jsonb not null default '[]'::jsonb,
  recurring_event_id uuid references calendar_events(id) on delete set null,
  original_start timestamptz,
  conflict_state text check (conflict_state is null or conflict_state in ('local_remote_changed')),
  sync_state text not null default 'pending' check (sync_state in ('synced','pending','failed','conflict')),
  sync_error text,
  local_revision bigint not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((all_day and start_date is not null and end_date is not null) or
         (not all_day and starts_at is not null and ends_at is not null))
);
create index if not exists calendar_events_window on calendar_events(owner_user_id, starts_at, ends_at)
  where deleted_at is null;
create index if not exists calendar_events_all_day on calendar_events(owner_user_id, start_date, end_date)
  where deleted_at is null and all_day;
create or replace trigger calendar_events_touch before update on calendar_events
  for each row execute function touch_updated_at();

create table if not exists calendar_event_links (
  id uuid primary key default gen_random_uuid(),
  origin_id uuid not null references calendar_sync_origins(id) on delete cascade,
  event_id uuid not null references calendar_events(id) on delete cascade,
  provider_event_id text not null,
  ical_uid text,
  remote_etag text,
  remote_revision text,
  remote_updated_at timestamptz,
  remote_fingerprint text,
  local_fingerprint text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(origin_id, provider_event_id),
  unique(origin_id, event_id)
);
create index if not exists calendar_event_links_event on calendar_event_links(event_id);
create or replace trigger calendar_event_links_touch before update on calendar_event_links
  for each row execute function touch_updated_at();

create table if not exists calendar_tombstones (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  origin_id uuid references calendar_sync_origins(id) on delete set null,
  event_id uuid,
  provider_event_id text,
  deleted_side text not null check (deleted_side in ('local','remote')),
  deleted_at timestamptz not null default now()
);
create unique index if not exists calendar_tombstones_remote
  on calendar_tombstones(origin_id, provider_event_id) where provider_event_id is not null;

create table if not exists calendar_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  origin_id uuid not null references calendar_sync_origins(id) on delete cascade,
  event_id uuid not null references calendar_events(id) on delete cascade,
  operation text not null check (operation in ('create','update','delete')),
  idempotency_key text not null unique,
  expected_remote_etag text,
  status text not null default 'queued' check (status in ('queued','running','done','failed','conflict')),
  attempts int not null default 0,
  run_at timestamptz not null default now(),
  last_error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists calendar_outbox_due on calendar_outbox(run_at) where status in ('queued','failed');
create unique index if not exists calendar_outbox_one_pending
  on calendar_outbox(origin_id,event_id) where status in ('queued','running','failed');
create or replace trigger calendar_outbox_touch before update on calendar_outbox
  for each row execute function touch_updated_at();

insert into schedules(kind,payload,interval_seconds,next_run_at,enabled)
select 'calendar.sync_due','{}'::jsonb,60,now()+interval '60 seconds',true
where not exists(select 1 from schedules where kind='calendar.sync_due');
insert into schedules(kind,payload,interval_seconds,next_run_at,enabled)
select 'calendar.outbox_due','{}'::jsonb,30,now()+interval '30 seconds',true
where not exists(select 1 from schedules where kind='calendar.outbox_due');

update task_templates set contract =
  '{"slots":{"required":["title","start","end"],"optional":["event_id","calendar_source","description","location","attendees"]},"urgency_ceiling":"text","max_attempts":3}'::jsonb
where key='schedule_appointment';
