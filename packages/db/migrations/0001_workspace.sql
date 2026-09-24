-- Josi CE 0001: one workspace, several people inside it.
--
-- The commercial engine isolates by tenant: a fleet of businesses, an operator
-- above them, and everyone inside a tenant sharing everything. CE inverts that.
-- There is exactly ONE workspace, the administrator lives INSIDE it, and the
-- private things — a person's connected accounts, their mapped folders, their
-- operational email — belong to a user, not to the workspace.
--
-- That second sentence is the whole security model. `owner_user_id` is not
-- decoration; it is the column the authorization layer reads.

-- ---------- the workspace itself ----------
-- Singleton by constraint, not by convention. `check (id)` on a boolean primary
-- key means a second row is a database error rather than a subtle bug that only
-- shows up when two workspaces disagree about a setting.
create table workspace (
  id boolean primary key default true check (id),
  name text not null default 'My workspace',
  timezone text not null default 'UTC',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger workspace_touch before update on workspace
  for each row execute function touch_updated_at();

-- ---------- installation identity ----------
-- One random UUID, generated locally, used only to correlate support tickets
-- and rate-limit the support gateway. Deliberately NOT derived from hardware
-- fingerprints, serial numbers or MAC addresses, and not tied to telemetry:
-- an installation that never opts into telemetry still needs a support id.
create table install_identity (
  id boolean primary key default true check (id),
  install_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now()
);
insert into install_identity (id) values (true);

-- ---------- setup wizard state ----------
-- The wizard is the ONLY path that creates the first super admin, so its
-- completion is a latch: once true, the wizard routes stop existing. Storing
-- this in the database rather than a file means a restarted container cannot
-- reopen the door.
create table setup_state (
  id boolean primary key default true check (id),
  completed boolean not null default false,
  current_step text not null default 'welcome',
  -- Non-secret answers accumulated across steps. Secrets go to encrypted
  -- storage as each step completes, never here.
  progress jsonb not null default '{}',
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into setup_state (id) values (true);
create trigger setup_state_touch before update on setup_state
  for each row execute function touch_updated_at();

-- ---------- people ----------
-- Two roles and no more. `super_admin` sets policy for the installation;
-- `member` uses the product. There is no operator above the workspace, because
-- in CE the workspace is the whole world.
create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  username text not null,
  password_hash text,                 -- null until an invite is redeemed
  role text not null check (role in ('super_admin', 'member')),
  display_name text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));
create unique index users_username_key on users (lower(username));
-- Exactly one super admin per installation. A partial unique index makes a
-- second one impossible rather than merely discouraged.
create unique index users_one_super_admin on users ((role)) where role = 'super_admin';
create trigger users_touch before update on users
  for each row execute function touch_updated_at();

-- ---------- sessions ----------
-- Server-side and revocable. Only sha256(token) is stored, so a dump of this
-- table is not a set of working logins.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user on sessions (user_id);
create index sessions_live on sessions (expires_at) where revoked_at is null;

-- ---------- one-time email tokens ----------
create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null check (purpose in ('invite', 'reset')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_tokens_user on auth_tokens (user_id);

-- ---------- login attempts (rate limiting) ----------
create table login_attempts (
  id bigint generated always as identity primary key,
  identifier text not null,
  ip text,
  success boolean not null default false,
  created_at timestamptz not null default now()
);
create index login_attempts_recent on login_attempts (identifier, created_at desc);
create index login_attempts_ip on login_attempts (ip, created_at desc);

-- ---------- audit / event log ----------
-- Append-only. This is the super admin's window into what happened, and it is
-- deliberately a window onto METADATA: who did what to which resource, never
-- the contents of the thing they did it to.
create table events (
  id bigint generated always as identity primary key,
  actor_user_id uuid references users(id) on delete set null,
  -- Free-text actor for system/agent activity that has no user behind it.
  actor text not null default 'system',
  kind text not null,
  subject_type text,
  subject_id text,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_kind on events (kind, created_at desc);
create index events_actor on events (actor_user_id, created_at desc);

-- An append-only log that can be edited is just a table. The trigger is what
-- makes the audit trail worth reading.
create or replace function events_no_mutation() returns trigger as $$
begin
  raise exception 'events is append-only';
end;
$$ language plpgsql;
create trigger events_no_update before update or delete on events
  for each row execute function events_no_mutation();

-- ---------- per-user private resources ----------
-- Connected provider accounts. In the engine these hung off the tenant and
-- everyone in the business shared them. Here each person connects their own
-- Google/Microsoft account and nobody else — including the super admin — may
-- read what it can see.
--
-- `secrets_enc` is sealed with the installation master key, which lives OUTSIDE
-- this database. A database backup on its own cannot decrypt these rows, and
-- that is the intended property.
create table connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  account_email text,
  -- Scopes the provider actually GRANTED, so capability is derived from truth
  -- rather than from what was requested.
  granted_scopes text not null default '',
  secrets_enc text,
  meta jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'needs_reconnect', 'revoked')),
  last_check_at timestamptz,
  last_check_ok boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, provider)
);
create index connections_owner on connections (owner_user_id);
create trigger connections_touch before update on connections
  for each row execute function touch_updated_at();

-- ---------- explicit sharing ----------
-- Private by default; shared only when the owner says so. Membership of the
-- workspace grants nothing, and neither does being the super admin.
--
-- Generic on purpose: folder mappings and email threads land here in later
-- phases without another sharing mechanism being invented alongside this one.
create table resource_shares (
  id uuid primary key default gen_random_uuid(),
  resource_type text not null,
  resource_id uuid not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- Exactly one of these: a named user, or the whole workspace.
  shared_with_user_id uuid references users(id) on delete cascade,
  shared_with_workspace boolean not null default false,
  can_write boolean not null default false,
  created_at timestamptz not null default now(),
  constraint resource_shares_target check (
    (shared_with_user_id is not null and shared_with_workspace = false)
    or (shared_with_user_id is null and shared_with_workspace = true)
  )
);
create index resource_shares_lookup on resource_shares (resource_type, resource_id);
create index resource_shares_grantee on resource_shares (shared_with_user_id);
create unique index resource_shares_unique_user
  on resource_shares (resource_type, resource_id, shared_with_user_id)
  where shared_with_user_id is not null;
create unique index resource_shares_unique_workspace
  on resource_shares (resource_type, resource_id)
  where shared_with_workspace = true;
