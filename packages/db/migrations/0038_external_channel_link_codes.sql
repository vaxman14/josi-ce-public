-- One-time, user-minted codes prove control of the Josi account before an
-- external identity can be linked. Only hashes are stored; plaintext is
-- returned once to the signed-in user.
create table if not exists external_channel_link_codes (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('whatsapp', 'slack')),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists external_channel_link_codes_lookup
  on external_channel_link_codes(provider, code_hash, expires_at)
  where used_at is null;

alter table external_channel_link_codes enable row level security;
