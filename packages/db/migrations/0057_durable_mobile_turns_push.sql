-- Durable native turns and owner-scoped Expo push delivery.
-- 0056 is intentionally reserved for the assistant migration landing in parallel.

alter table child_activity_minutes drop constraint child_activity_minutes_channel_check;
alter table child_activity_minutes add constraint child_activity_minutes_channel_check
  check(channel in ('web','native','telegram','external'));

create table assistant_turn_capacity (
  owner_user_id uuid primary key references users(id) on delete cascade,
  active_count int not null default 0 check(active_count between 0 and 50)
);

create function reserve_assistant_turn_capacity() returns trigger language plpgsql as $$
begin
  insert into assistant_turn_capacity(owner_user_id,active_count) values(new.owner_user_id,1)
    on conflict(owner_user_id) do update set active_count=assistant_turn_capacity.active_count+1
      where assistant_turn_capacity.active_count<50;
  if not found then raise exception 'assistant_turn_capacity'; end if;
  return new;
end $$;

create function release_assistant_turn_capacity() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or (old.status in('queued','running') and new.status in('completed','failed')) then
    update assistant_turn_capacity set active_count=greatest(0,active_count-1) where owner_user_id=old.owner_user_id;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create table assistant_turns (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  accepted_session_id uuid not null references sessions(id),
  thread_id uuid not null references threads(id) on delete cascade,
  client_message_id text not null,
  request_hash text not null,
  attempt_of uuid references assistant_turns(id) on delete restrict,
  inbound_message_id uuid not null unique references messages(id) on delete cascade,
  reply_to_message_id uuid references messages(id) on delete set null,
  attachment_ids uuid[] not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  assistant_message_id uuid unique references messages(id) on delete set null,
  tool_receipts jsonb not null default '[]',
  error_code text,
  error_retryable boolean,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id, thread_id, client_message_id)
);
create index assistant_turns_owner_thread on assistant_turns(owner_user_id,thread_id,created_at desc);
-- A retry is a chain, not a fan-out: only one new attempt may consume a
-- failed predecessor, so duplicate taps with different client ids cannot run
-- the same requested retry twice.
create unique index assistant_turns_one_retry on assistant_turns(attempt_of) where attempt_of is not null;
create index assistant_turns_claim on assistant_turns(status,lease_expires_at,created_at)
  where status in ('queued','running');
create trigger assistant_turns_touch before update on assistant_turns
  for each row execute function touch_updated_at();
create trigger assistant_turns_reserve before insert on assistant_turns
  for each row execute function reserve_assistant_turn_capacity();
create trigger assistant_turns_release after update or delete on assistant_turns
  for each row execute function release_assistant_turn_capacity();

-- Durable tool-effect fence. A started row is intentionally ambiguous after a
-- crash: a linked retry may not execute it again. Completed rows retain the
-- exact receipt so repeated model calls inside one turn are harmless.
create table assistant_turn_effects (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references assistant_turns(id) on delete cascade,
  effect_key text not null,
  tool_name text not null,
  state text not null default 'started' check(state in ('started','completed')),
  receipt jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(turn_id,effect_key)
);
create index assistant_turn_effects_turn on assistant_turn_effects(turn_id);

-- One queue row per durable turn. Its payload has only an opaque id.
create unique index job_queue_one_assistant_turn
  on job_queue ((payload->>'turnId')) where kind='assistant.turn';

create table mobile_devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  device_identity text not null,
  platform text not null check(platform in ('ios','android')),
  expo_token_enc text not null,
  token_fingerprint text not null,
  app_state text not null default 'background' check(app_state in ('foreground','background','inactive')),
  privacy_locked boolean not null default false,
  categories jsonb not null default '{"assistant":true,"approval":true,"reminder":true,"calendar":true}',
  quiet_start time,
  quiet_end time,
  timezone text not null default 'UTC',
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id,device_identity)
);
create unique index mobile_devices_active_token on mobile_devices(token_fingerprint) where revoked_at is null;
create unique index mobile_devices_active_identity on mobile_devices(device_identity) where revoked_at is null;
create index mobile_devices_owner on mobile_devices(owner_user_id,last_seen_at desc);
create trigger mobile_devices_touch before update on mobile_devices
  for each row execute function touch_updated_at();

create table push_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references mobile_devices(id) on delete cascade,
  event_key text not null,
  category text not null check(category in ('assistant','approval','reminder','calendar')),
  route_type text not null check(route_type in ('turn','approval','task','calendar','reminder')),
  route_id uuid not null,
  title text not null,
  body text not null,
  explicit_reminder boolean not null default false,
  status text not null default 'queued' check(status in ('queued','sending','ticketed','checking','provider_accepted','retry','failed','suppressed')),
  lease_token uuid,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  ticket_id text,
  sent_token_fingerprint text,
  receipt_attempts int not null default 0,
  receipt_checked_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id,event_key)
);
create index push_deliveries_due on push_deliveries(status,next_attempt_at)
  where status in ('queued','retry','sending','ticketed','checking');
create trigger push_deliveries_touch before update on push_deliveries
  for each row execute function touch_updated_at();

-- Task completion/failure notifications are a transactional outbox: rows are
-- created in the same commit as the authoritative task state transition.
create function task_push_outbox() returns trigger language plpgsql as $$
declare push_category text;
begin
  if new.state not in ('confirmed','failed') or new.state=old.state then return new; end if;
  push_category:=case when new.template_key='schedule_appointment' then 'calendar' else 'assistant' end;
  insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body)
    select new.owner_user_id,d.id,'task:'||new.id||':'||new.state,push_category,'task',new.id,'Josi',
      case when new.state='confirmed' then 'Your task completed.' else 'Your task needs attention.' end
    from mobile_devices d where d.owner_user_id=new.owner_user_id and d.revoked_at is null and d.app_state<>'foreground'
      and coalesce((d.categories->>push_category)::boolean,true)
    on conflict(device_id,event_key) do nothing;
  return new;
end $$;
create trigger tasks_push_outbox after update of state on tasks
  for each row execute function task_push_outbox();

-- Approval-needed means "presented to the owner", not merely drafted by a
-- model. This trigger shares the transaction that pins the presented message.
create function approval_push_outbox() returns trigger language plpgsql as $$
begin
  if new.status<>'prepared' or new.approval_id is null or new.presented_turn_id is null
     or new.presented_turn_id is not distinct from old.presented_turn_id then return new; end if;
  insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body)
    select new.owner_user_id,d.id,'approval:'||new.approval_id,'approval','approval',new.approval_id,
      'Josi','Your approval is needed.' from mobile_devices d
    where d.owner_user_id=new.owner_user_id and d.revoked_at is null and d.app_state<>'foreground'
      and coalesce((d.categories->>'approval')::boolean,true)
    on conflict(device_id,event_key) do nothing;
  return new;
end $$;
create trigger assistant_action_push_outbox after update of presented_turn_id on assistant_action_states
  for each row execute function approval_push_outbox();

-- A function gives PostgreSQL sequential statements for account switching.
-- Data-modifying CTEs share one snapshot and cannot reliably retire a partial
-- unique-index entry before inserting its replacement on every supported
-- PostgreSQL implementation.
create function register_mobile_device(
  p_owner uuid,p_identity text,p_platform text,p_token_enc text,p_fingerprint text,
  p_app_state text,p_privacy boolean,p_categories jsonb,p_quiet_start time,
  p_quiet_end time,p_timezone text
) returns uuid language plpgsql as $$
declare target uuid; old_ids uuid[];
begin
  -- Registration is infrequent; one installation-wide lock avoids partial-
  -- unique-index races and lock-order deadlocks across identity/token swaps.
  perform pg_advisory_xact_lock(hashtext('josi_mobile_device_registration'));
  select array_agg(id) into old_ids from mobile_devices
    where revoked_at is null and (device_identity=p_identity or token_fingerprint=p_fingerprint)
      and not(owner_user_id=p_owner and device_identity=p_identity);
  if old_ids is not null then
    -- Suppress only work that has not crossed the Expo HTTP boundary. A
    -- sending/ticketed/checking row may already have been accepted externally;
    -- preserve its lease/state so receipts remain truthful rather than claiming
    -- a concurrent account switch unsent an in-flight notification.
    update push_deliveries set status='suppressed',lease_token=null,last_error_code='account_switched'
      where device_id=any(old_ids) and status in('queued','retry');
    update mobile_devices set revoked_at=now() where id=any(old_ids);
  end if;
  select id into target from mobile_devices where owner_user_id=p_owner and device_identity=p_identity for update;
  if target is null then
    insert into mobile_devices(owner_user_id,device_identity,platform,expo_token_enc,token_fingerprint,app_state,privacy_locked,categories,quiet_start,quiet_end,timezone)
      values(p_owner,p_identity,p_platform,p_token_enc,p_fingerprint,p_app_state,p_privacy,p_categories,p_quiet_start,p_quiet_end,p_timezone) returning id into target;
  else
    update mobile_devices set platform=p_platform,expo_token_enc=p_token_enc,token_fingerprint=p_fingerprint,
      app_state=p_app_state,privacy_locked=p_privacy,categories=p_categories,quiet_start=p_quiet_start,
      quiet_end=p_quiet_end,timezone=p_timezone,revoked_at=null,last_seen_at=now() where id=target;
  end if;
  return target;
end $$;

alter table assistant_turns enable row level security;
alter table assistant_turn_effects enable row level security;
alter table mobile_devices enable row level security;
alter table push_deliveries enable row level security;
