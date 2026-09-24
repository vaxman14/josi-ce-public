alter table users add column if not exists totp_secret_enc text;
alter table users add column if not exists mfa_enabled_at timestamptz;

create table if not exists mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);
create index if not exists mfa_recovery_codes_user on mfa_recovery_codes(user_id) where used_at is null;
alter table mfa_recovery_codes enable row level security;

create table if not exists auth_mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  remember_me boolean not null default false,
  ip inet,
  user_agent text,
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table auth_mfa_challenges add column if not exists attempts integer not null default 0 check (attempts between 0 and 5);
create index if not exists auth_mfa_challenges_live on auth_mfa_challenges(token_hash, expires_at) where used_at is null;
alter table auth_mfa_challenges enable row level security;

create table if not exists auth_oauth_states (
  state_hash text primary key,
  verifier text not null,
  return_path text not null default '/app',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table auth_oauth_states enable row level security;
