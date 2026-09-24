alter table auth_oauth_states
  add column if not exists native_return_uri text;

create table if not exists auth_native_codes (
  code_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_native_codes_live
  on auth_native_codes (expires_at)
  where used_at is null;

alter table auth_native_codes enable row level security;
