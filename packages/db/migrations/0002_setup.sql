-- Josi CE 0002: what the setup wizard captures.
--
-- Every table here stores a CONFIGURATION CONTRACT, not a working integration.
-- The wizard collects and validates; later phases activate. A row in
-- `llm_providers` means "the operator told us this"; it does not mean anyone has
-- ever successfully called that provider, and nothing in this schema implies
-- otherwise.
--
-- Secrets are sealed with the installation master key before they arrive
-- (core/sealing.ts). The `*_enc` columns hold ciphertext; there is no plaintext
-- column to fall back to, deliberately.

-- ---------- setup progress ----------
-- 0001 gave setup_state a free-form `progress` blob and a `current_step` string.
-- The state machine needs to know which steps are DONE, not merely where the
-- browser last was, so that a resume after a restart lands on the first
-- incomplete step rather than trusting a client.
alter table setup_state add column completed_steps text[] not null default '{}';

-- The install identity this setup run is bound to. Recorded so a completed
-- setup can be shown to belong to this installation rather than a copied
-- database. Never supplied by a client.
alter table setup_state add column install_id uuid;

-- ---------- host checks ----------
-- The result of the environment checks the wizard ran, kept so an operator can
-- see later what the machine looked like at install time. Metadata only: pass
-- or fail and a short actionable label, never a path, version or size.
create table setup_host_checks (
  id bigint generated always as identity primary key,
  check_id text not null,
  status text not null check (status in ('pass', 'warn', 'fail')),
  label text not null,
  mandatory boolean not null default false,
  checked_at timestamptz not null default now()
);

-- ---------- LLM configuration ----------
-- One primary, optionally one fallback. The unique index makes "one of each"
-- a database fact rather than something route code has to remember.
create table llm_providers (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('primary', 'fallback')),
  provider text not null check (provider in ('openai', 'anthropic', 'xai', 'openai_compatible')),
  model text not null,
  -- Only meaningful for openai_compatible. Ollama, vLLM, LM Studio, LocalAI.
  base_url text,
  -- Sealed. Optional for a self-hosted endpoint that needs no key.
  api_key_enc text,
  -- M89: choosing a provider that sends data off this server requires the
  -- operator to say, in as many words, that they understand that. Stored, not
  -- merely displayed, so it can be shown later and cannot be quietly lost.
  external_acknowledged boolean not null default false,
  external_acknowledged_at timestamptz,
  -- Set once a later phase has actually talked to the provider. The wizard
  -- never sets this: it has not called anything.
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index llm_providers_one_per_role on llm_providers (role);
create trigger llm_providers_touch before update on llm_providers
  for each row execute function touch_updated_at();

-- An external provider without a recorded acknowledgment must not be
-- representable at all. Route validation can be forgotten; a check constraint
-- cannot.
alter table llm_providers add constraint llm_external_requires_ack check (
  provider = 'openai_compatible' or external_acknowledged = true
);

-- ---------- SMTP profiles ----------
-- Two, and exactly two roles: `system` for invites, resets and security mail;
-- `communications` for mail Josi sends on a user's behalf.
--
-- `copy_from_system` is why credentials are not duplicated: a communications
-- profile that borrows the system server stores its own sender identity and NO
-- credentials of its own, so there is one copy of that password in the
-- database, not two.
create table smtp_profiles (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('system', 'communications')),
  copy_from_system boolean not null default false,
  host text,
  port integer check (port is null or (port > 0 and port <= 65535)),
  security text check (security is null or security in ('none', 'starttls', 'tls')),
  username text,
  password_enc text,
  from_name text,
  from_address text,
  -- Set by Phase 8 once a message has actually been delivered through it.
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index smtp_profiles_one_per_kind on smtp_profiles (kind);
create trigger smtp_profiles_touch before update on smtp_profiles
  for each row execute function touch_updated_at();

-- A profile either borrows the system server or specifies its own. The system
-- profile can never borrow from itself.
alter table smtp_profiles add constraint smtp_profile_shape check (
  (kind = 'system' and copy_from_system = false and host is not null)
  or (kind = 'communications' and (copy_from_system = true or host is not null))
);

-- ---------- connector configuration ----------
-- The operator's OWN OAuth application per provider (M28). No credential
-- belonging to anyone else ships with CE, and none is stored here by default:
-- the connector step is skippable and a skipped step writes no row.
create table connector_configs (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google', 'microsoft')),
  client_id text not null,
  client_secret_enc text not null,
  -- common | organizations | consumers | a directory id. Microsoft only.
  ms_tenant text,
  redirect_uri text,
  -- Whether tenants may run the consent flow themselves. Off until the operator
  -- has registered the redirect URI with the provider.
  self_serve boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index connector_configs_one_per_provider on connector_configs (provider);
create trigger connector_configs_touch before update on connector_configs
  for each row execute function touch_updated_at();

-- ---------- security and privacy policy ----------
-- Singleton. Deny-by-default is expressed in the column defaults, so a row that
-- is created and never touched is the restrictive one.
create table security_policy (
  id boolean primary key default true check (id),
  -- M45: Josi reaches no local path unless the operator has both mounted it and
  -- allowlisted it. There is no "grant home directory" option to get wrong.
  local_file_access_enabled boolean not null default false,
  -- M47: the super admin's half of the dual gate for folder mapping.
  folder_mapping_enabled boolean not null default false,
  -- M69
  folder_sharing_enabled boolean not null default true,
  workspace_wide_sharing_enabled boolean not null default false,
  -- M52/M56: bundled but off until deliberately switched on.
  ocr_enabled boolean not null default false,
  clamav_enabled boolean not null default false,
  -- M73: 30 | 90 | 365 | 0 (forever)
  audit_retention_days integer not null default 365,
  updated_at timestamptz not null default now()
);
insert into security_policy (id) values (true);
create trigger security_policy_touch before update on security_policy
  for each row execute function touch_updated_at();

-- ---------- telemetry ----------
-- M98. Singleton, and `enabled` defaults to FALSE. The row exists from the
-- start so that "no row" can never be mistaken for "not yet decided, assume on".
create table telemetry_state (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- Only set when someone affirmatively ticked the box. A null here alongside
  -- enabled = true would mean something went wrong.
  opted_in_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into telemetry_state (id) values (true);
create trigger telemetry_state_touch before update on telemetry_state
  for each row execute function touch_updated_at();

alter table telemetry_state add constraint telemetry_optin_recorded check (
  enabled = false or opted_in_at is not null
);

-- ---------- deployment / domain ----------
create table deployment_config (
  id boolean primary key default true check (id),
  domain text,
  -- bundled_caddy | external_proxy
  tls_mode text not null default 'bundled_caddy'
    check (tls_mode in ('bundled_caddy', 'external_proxy')),
  acme_email text,
  -- Set only when a certificate has actually been obtained. The wizard cannot
  -- set this: it has performed no ACME challenge.
  certificate_verified_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into deployment_config (id) values (true);
create trigger deployment_config_touch before update on deployment_config
  for each row execute function touch_updated_at();

-- ---------- RLS (deny-all; the service role bypasses) ----------
alter table setup_host_checks enable row level security;
alter table llm_providers enable row level security;
alter table smtp_profiles enable row level security;
alter table connector_configs enable row level security;
alter table security_policy enable row level security;
alter table telemetry_state enable row level security;
alter table deployment_config enable row level security;
