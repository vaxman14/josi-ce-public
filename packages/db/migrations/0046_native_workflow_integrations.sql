-- Native workflow automation providers. These are intentionally separate from
-- custom_api_connections: selecting a provider opts into its fixed protocol,
-- not an administrator-authored HTTP allowlist wearing a provider name.
create table workflow_integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('zapier','n8n','make')),
  name text not null,
  base_url text not null,
  credentials_enc text not null,
  callback_secret_enc text not null,
  allow_private_network boolean not null default false,
  account_identity text,
  workspace_identity text,
  status text not null default 'active' check (status in ('active','error','disconnected')),
  enabled boolean not null default false,
  created_by uuid references users(id) on delete set null,
  last_check_at timestamptz,
  last_check_ok boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, name)
);
create trigger workflow_integrations_touch before update on workflow_integrations
  for each row execute function touch_updated_at();

create table workflow_definitions (
  integration_id uuid not null references workflow_integrations(id) on delete cascade,
  external_id text not null,
  name text not null,
  description text,
  input_schema jsonb not null default '{"type":"object","properties":{}}',
  execution_ref text not null,
  active boolean not null default true,
  exposed boolean not null default false,
  discovered_at timestamptz not null default now(),
  primary key(integration_id, external_id)
);

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid not null references workflow_integrations(id) on delete cascade,
  external_workflow_id text not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid references threads(id) on delete set null,
  status text not null check (status in ('pending','approved','running','succeeded','failed','denied','expired')),
  input_enc text not null,
  input_hash text not null,
  external_run_id text,
  result_summary text,
  error_category text,
  expires_at timestamptz not null,
  decided_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index workflow_runs_owner_history on workflow_runs(owner_user_id, created_at desc);
create index workflow_runs_external on workflow_runs(integration_id, external_run_id);
create index workflow_runs_expiry on workflow_runs(expires_at) where status = 'pending';

create table workflow_callback_events (
  integration_id uuid not null references workflow_integrations(id) on delete cascade,
  event_id text not null,
  received_at timestamptz not null default now(),
  primary key(integration_id,event_id)
);

alter table workflow_integrations enable row level security;
alter table workflow_definitions enable row level security;
alter table workflow_runs enable row level security;
alter table workflow_callback_events enable row level security;
