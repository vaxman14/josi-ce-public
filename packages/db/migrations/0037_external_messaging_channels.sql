-- Shared storage for WhatsApp and Slack.
create table if not exists external_channel_configs (
  provider text primary key check (provider in ('whatsapp', 'slack')),
  enabled boolean not null default false,
  credentials_enc text,
  webhook_secret_enc text,
  risk_acknowledged_at timestamptz,
  configured_at timestamptz,
  probed_at timestamptz,
  probe_ok boolean,
  probe_error_category text,
  updated_at timestamptz not null default now(),
  constraint enabled_channel_needs_credentials check (not enabled or credentials_enc is not null)
);
insert into external_channel_configs (provider) values ('whatsapp'), ('slack') on conflict do nothing;

create table if not exists external_channel_links (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('whatsapp', 'slack')),
  user_id uuid not null references users(id) on delete cascade,
  external_identity text not null,
  conversation_id text not null,
  thread_id uuid references threads(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  constraint external_link_revoked_shape check ((status = 'active' and revoked_at is null) or (status = 'revoked' and revoked_at is not null))
);
create unique index if not exists external_channel_one_active_identity on external_channel_links(provider, external_identity) where status = 'active';
create index if not exists external_channel_links_user on external_channel_links(user_id, provider, status);

create table if not exists external_channel_events (
  provider text not null check (provider in ('whatsapp', 'slack')),
  event_id text not null,
  conversation_id text,
  outcome text not null default 'received' check (outcome in ('received','accepted','unlinked','refused','ignored','failed')),
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table if not exists external_channel_outbound (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('whatsapp', 'slack')),
  user_id uuid references users(id) on delete set null,
  conversation_id text not null,
  state text not null default 'pending' check (state in ('pending','sent','failed')),
  attempts integer not null default 0,
  provider_message_id text,
  error_category text,
  body_chars integer not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists external_channel_outbound_state on external_channel_outbound(state, created_at);

alter table external_channel_configs enable row level security;
alter table external_channel_links enable row level security;
alter table external_channel_events enable row level security;
alter table external_channel_outbound enable row level security;
