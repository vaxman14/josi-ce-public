-- One person may connect several accounts from the same provider. Provider
-- identity, not provider name, is the durable account key.
alter table connections drop constraint if exists connections_owner_user_id_provider_key;
create unique index connections_owner_provider_account
  on connections (owner_user_id, provider, provider_account_id)
  where provider_account_id is not null;
create unique index connections_owner_provider_email_fallback
  on connections (owner_user_id, provider, lower(account_email))
  where provider_account_id is null and account_email is not null;
create unique index connections_owner_nextcloud
  on connections (owner_user_id, provider)
  where provider = 'nextcloud';

-- Incremental consent must return to the account whose switch initiated it.
alter table oauth_states add column target_connection_id uuid
  references connections(id) on delete cascade;

-- Discovered calendars are metadata only. Event contents remain remote. Each
-- person's selection is independent and defaults to included on discovery.
create table calendar_sources (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  provider_calendar_id text not null,
  name text not null,
  color text,
  is_primary boolean not null default false,
  selected boolean not null default true,
  writable boolean not null default false,
  last_discovered_at timestamptz not null default now(),
  unique (connection_id, provider_calendar_id)
);
create index calendar_sources_owner on calendar_sources (owner_user_id, selected);
alter table calendar_sources enable row level security;
