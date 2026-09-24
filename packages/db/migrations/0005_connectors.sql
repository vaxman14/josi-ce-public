-- Josi CE 0005: connected accounts.
--
-- THE THING THIS SCHEMA HAS TO GET RIGHT
--
-- Three separate facts decide whether Josi may do something with someone's
-- Google or Microsoft account, and they are stored separately on purpose
-- because collapsing them is how a connector quietly does more than anyone
-- agreed to:
--
--   1. What the PROVIDER actually granted. Scopes on the connection, read back
--      from the token response — what was granted, never what was asked for.
--   2. What the USER enabled. Their consent, per capability. A connection that
--      has write scopes still does not write until its owner turns it on.
--   3. What the ADMIN permits. A ceiling that can only ever deny.
--
-- `effectiveCapability` in packages/connectors/src/capabilities.ts is the one
-- place those three meet, and the truth table asserting an admin cannot GRANT
-- is the test the phase plan asks for by name.

-- ---------- the operator's own OAuth application ----------
-- M28. CE ships with no client of its own: each installation registers its own
-- Google/Microsoft application, exactly as other self-hosted products require.
-- The secret is sealed with the installation master key before it is stored,
-- and there is no plaintext column to fall back to.
create table oauth_clients (
  provider text primary key check (provider in ('google', 'microsoft')),
  client_id text not null,
  client_secret_enc text not null,
  -- Where the provider sends the browser back. Stored rather than derived, so
  -- an operator whose deployment sits behind a proxy can make it match what
  -- they registered — a mismatch here is the single most common connector
  -- failure and produces a provider error page, not ours.
  redirect_uri text not null,
  configured_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create trigger oauth_clients_touch before update on oauth_clients
  for each row execute function touch_updated_at();

-- ---------- the handshake ----------
-- Ported from the engine. The reasoning there is worth keeping verbatim: an
-- unguessable state that is merely SIGNED is replayable, so the handshake is
-- stored and consumed. What the callback is allowed to believe comes from this
-- row and never from the query string.
--
-- CE difference: one hostname, so the session cookie IS present on the callback
-- and the session binding below is enforced rather than best-effort.
create table oauth_states (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Which capabilities this consent is being collected for. Incremental
  -- authorization means a second handshake asks for more than the first.
  capabilities text[] not null default '{}',
  scopes text not null,
  -- PKCE verifier, sealed. A secret for the length of the handshake is still a
  -- secret.
  verifier_enc text,
  return_path text not null default '/app/connections',
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_states_expiry on oauth_states (expires_at);

-- ---------- what each connection may do ----------
-- The user's consent, per capability, per connection. Absent = off: a
-- capability nobody switched on is not on, which is why this table has no
-- default row and no "enabled by default" column.
create table connection_capabilities (
  connection_id uuid not null references connections(id) on delete cascade,
  capability text not null,
  enabled boolean not null default false,
  -- When the provider granted the scopes this capability needs. Null means the
  -- connection cannot do it yet whatever the user chose, and the UI has to send
  -- them back through consent. M32: read first, re-consent for write.
  scopes_granted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (connection_id, capability)
);
create trigger connection_capabilities_touch before update on connection_capabilities
  for each row execute function touch_updated_at();

-- ---------- the admin ceiling ----------
-- M33/M30, deny-only. A row here can forbid a capability installation-wide. It
-- can NEVER enable one: there is deliberately no "granted" column, because a
-- column that could grant is a column somebody will eventually set.
create table admin_capability_policy (
  capability text primary key,
  allowed boolean not null default true,
  -- Shown to users whose capability this switches off, so the refusal has a
  -- reason attached rather than appearing as a bug.
  note text,
  updated_at timestamptz not null default now()
);
create trigger admin_capability_policy_touch before update on admin_capability_policy
  for each row execute function touch_updated_at();

-- ---------- connection housekeeping ----------
-- Why a connection stopped working, in a form the owner can act on. Never the
-- provider's raw error body: those quote the request, and a request to a mail
-- API quotes mail.
alter table connections add column last_error_category text
  check (last_error_category in (
    'revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'
  ));
alter table connections add column token_expires_at timestamptz;
-- The account the tokens belong to, as the provider reports it. Shown to its
-- owner so they can tell two accounts apart; never shown to an administrator,
-- because which mailbox someone connected is content about them.
alter table connections add column provider_account_id text;

alter table oauth_clients enable row level security;
alter table oauth_states enable row level security;
alter table connection_capabilities enable row level security;
