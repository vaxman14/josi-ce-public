-- Native Sign in with Apple identities. Tokens and authorization codes are
-- deliberately never persisted; only Apple's stable subject and verified email
-- metadata are retained for account restore and revocation-safe linking.
create table if not exists auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('apple')),
  provider_subject text not null,
  verified_email text,
  private_relay boolean not null default false,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  unique(provider, provider_subject),
  unique(user_id, provider)
);

create index if not exists auth_identities_user on auth_identities(user_id);
alter table auth_identities enable row level security;

create table if not exists auth_apple_challenges (
  challenge_hash text primary key,
  purpose text not null check (purpose in ('link', 'mfa_login')),
  provider_subject text not null,
  verified_email text,
  private_relay boolean not null default false,
  user_id uuid references users(id) on delete cascade,
  attempts integer not null default 0 check (attempts between 0 and 5),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check ((purpose='link' and user_id is null) or (purpose='mfa_login' and user_id is not null))
);
create index if not exists auth_apple_challenges_live on auth_apple_challenges(expires_at) where used_at is null;
alter table auth_apple_challenges enable row level security;
