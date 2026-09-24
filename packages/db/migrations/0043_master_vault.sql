-- Master Vault: one installation-wide control plane, one independently keyed
-- safe-deposit box per user, and session-bound five-minute UI unlocks.
create table vault_state (
  id boolean primary key default true check (id),
  initialized_at timestamptz,
  initialized_by uuid references users(id) on delete set null,
  locked boolean not null default true,
  key_version integer not null default 1 check (key_version > 0),
  master_key_enc text,
  recovery_master_enc text,
  recovery_key_hash text,
  recovery_key_fingerprint text,
  recovery_confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into vault_state (id) values (true) on conflict do nothing;

create table vault_boxes (
  owner_user_id uuid primary key references users(id) on delete cascade,
  wrapped_key_enc text not null,
  key_version integer not null default 1 check (key_version > 0),
  locked boolean not null default false,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table vault_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('api_key','oauth_token','password','secure_note','recovery_code','certificate','private_key','other')),
  service text not null check (length(trim(service)) between 1 and 80),
  slot text not null check (length(trim(slot)) between 1 and 120),
  label text not null check (length(trim(label)) between 1 and 160),
  value_enc text not null,
  last_four text,
  metadata jsonb not null default '{}',
  status text not null default 'active' check (status in ('active','revoked')),
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (owner_user_id, service, slot)
);
create index vault_items_owner on vault_items (owner_user_id, service, status);

create table vault_unlocks (
  user_id uuid not null references users(id) on delete cascade,
  target_user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  authority text not null check (authority in ('owner','guardian')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, target_user_id, session_id)
);
create index vault_unlocks_expiry on vault_unlocks (expires_at);

create table vault_job_failures (
  id bigint generated always as identity primary key,
  job_kind text not null,
  reason text not null check (reason in ('master_locked','box_locked','key_unavailable')),
  created_at timestamptz not null default now()
);
create index vault_job_failures_recent on vault_job_failures (created_at desc);

alter table vault_state enable row level security;
alter table vault_boxes enable row level security;
alter table vault_items enable row level security;
alter table vault_unlocks enable row level security;
alter table vault_job_failures enable row level security;
