-- Developer services, and who is allowed to connect one.
--
-- GitHub, Netlify, Vercel and Supabase are each person's own account, so the
-- connection belongs in their Workspace and the credential is theirs. What an
-- administrator governs is not the credential but the PERMISSION: whether
-- anyone here may connect that service at all, and if so, who.
--
-- Those two facts are deliberately in two tables, because conflating them is
-- the mistake this replaces. "Allowed" and "connected" answer different
-- questions — one is a policy an administrator sets, the other is a state a
-- person creates — and a screen that shows one where the other belongs tells an
-- administrator that nobody uses a service when in fact nobody may.

-- ---------- the policy: who MAY connect ----------
create table if not exists developer_service_policy (
  service text primary key check (service in ('github', 'netlify', 'vercel', 'supabase')),

  -- Three states, not a boolean. "Allowed for specific users" is the whole
  -- point of the item, and a boolean plus a side table would let a row say
  -- `allowed = false` while an allow-list sat beside it saying otherwise.
  mode text not null default 'not_allowed'
    check (mode in ('not_allowed', 'everyone', 'specific_users')),

  -- Shown to anyone refused, so a person who cannot connect is told why by the
  -- administrator who decided it rather than by a generic refusal.
  note text,

  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

-- Early CE builds shipped a boolean version of this policy table before the
-- three-state model landed in the public migration chain. Upgrade that real
-- deployed shape in place instead of assuming every installation is fresh.
alter table developer_service_policy
  add column if not exists mode text,
  add column if not exists updated_by uuid references users(id) on delete set null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'developer_service_policy'
      and column_name = 'allowed'
  ) then
    execute $sql$
      update developer_service_policy
      set mode = case when allowed then 'everyone' else 'not_allowed' end
      where mode is null
    $sql$;
  end if;
end $$;

update developer_service_policy set mode = 'not_allowed' where mode is null;
alter table developer_service_policy
  alter column mode set default 'not_allowed',
  alter column mode set not null,
  drop column if exists allowed;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'developer_service_policy'::regclass
      and conname = 'developer_service_policy_mode_check'
  ) then
    alter table developer_service_policy
      add constraint developer_service_policy_mode_check
      check (mode in ('not_allowed', 'everyone', 'specific_users'));
  end if;
end $$;

-- Named people, only meaningful while mode = 'specific_users'. The rows are
-- kept when the mode changes rather than deleted: an administrator who switches
-- to "everyone" and back has not lost the list they built.
create table if not exists developer_service_allowed_users (
  service text not null references developer_service_policy(service) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (service, user_id)
);
create index if not exists developer_service_allowed_users_user on developer_service_allowed_users (user_id);

-- ---------- the connection: who HAS connected ----------
create table if not exists developer_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  service text not null check (service in ('github', 'netlify', 'vercel', 'supabase')),

  -- The person's own token, sealed with the installation master key. An
  -- administrator never sees it and never enters it: there is no
  -- installation-wide credential for these services, and the admin screen has
  -- nowhere to type one.
  credentials_enc text,

  -- What the service said this token belongs to, so the owner can tell which
  -- of their accounts they connected. Never anything from inside the account.
  account_label text,

  status text not null default 'active'
    check (status in ('active', 'needs_reconnect', 'revoked')),
  last_check_at timestamptz,
  last_check_ok boolean,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One account per service per person. Connecting again replaces the token
  -- rather than accumulating rows nobody can tell apart.
  unique (owner_user_id, service)
);
create index if not exists developer_connections_owner on developer_connections (owner_user_id);
create index if not exists developer_connections_service on developer_connections (service);
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'developer_connections'::regclass
      and tgname = 'developer_connections_touch'
      and not tgisinternal
  ) then
    create trigger developer_connections_touch before update on developer_connections
      for each row execute function touch_updated_at();
  end if;
end $$;

-- Every service starts refused. A developer service reaches a third party with
-- a person's own credential, and defaulting to permitted would switch that on
-- for every installation that upgrades without anybody choosing it.
insert into developer_service_policy (service, mode) values
  ('github', 'not_allowed'),
  ('netlify', 'not_allowed'),
  ('vercel', 'not_allowed'),
  ('supabase', 'not_allowed')
on conflict (service) do nothing;
