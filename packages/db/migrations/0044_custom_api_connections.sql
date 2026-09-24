-- Josi CE 0035: custom API connections.
--
-- An administrator points Josi at an external HTTP API the product has never
-- heard of — a CRM, a booking system, an in-house service — and says, endpoint
-- by endpoint, exactly what Josi may ask it. Everything else about that API
-- stays unreachable.
--
-- WHAT MAKES THIS DIFFERENT FROM EVERYTHING ELSE IN THIS SCHEMA
--
-- `llm_providers` is a base URL too, and `developer_service_connections` holds
-- a pasted credential too, so it is worth being precise about why this is a
-- third thing rather than a column on either:
--
--   * A MODEL ENDPOINT is asked one question, by one caller, with one shape.
--     Nothing chooses its path. Here the assistant chooses, from a list, which
--     is the entire risk and the entire reason for `custom_api_endpoints`.
--   * A DEVELOPER SERVICE has ONE PINNED HOST compiled into CE
--     (`SERVICES[...].apiHost`) and four hand-written probes. Nothing about it
--     is operator-supplied, so there is no allowlist to keep. Here the host
--     comes from a form, so the host IS the allowlist and it is a column.
--   * AN MCP SERVER is not implemented in CE at all, and this is not a step
--     towards one: nothing here speaks a protocol, and nothing here lets the
--     model name a URL, a method or a header.
--
-- THE OWNERSHIP DECISION, recorded here because the schema is what enforces it
--
-- These are INSTALLATION-SCOPED and administrator-owned, which is the opposite
-- of the call made for `developer_service_connections` in 0034 — and the reason
-- is the same one, applied to a different fact.
--
-- A GitHub personal access token ACTS AS the person who minted it: commits
-- carry their name. A custom API credential is a service credential the
-- operator holds on behalf of the installation, exactly like an SMTP profile,
-- an OAuth *client* registration or the LLM provider key. It acts as the
-- product, not as a person. So it lives in an installation-wide table that only
-- a super admin may write, and there is no `owner_user_id` on it — because a
-- column that let one member own a connection would let one member's
-- credential be spent by another member's conversation.
--
-- Per-person isolation is still absolute, and it lives one table down: every
-- request Josi actually makes is made for one person, and a write or delete
-- becomes a `custom_api_pending_calls` row that only its owner can see or
-- decide. An administrator configures the pipe; they do not get to see what
-- somebody sent through it.
--
-- WHAT IS NOT IN THESE TABLES
--
-- The credential, in any readable form. `credentials_enc` is sealed with the
-- installation master key (packages/core/src/sealing.ts) before it reaches a
-- query. No column holds a prefix, a suffix, a length or a hash of it: the
-- admin page shows a fixed mask, because four characters of a credential are
-- still four characters of a credential.

-- ---------- the connection ----------

create table custom_api_connections (
  id uuid primary key default gen_random_uuid(),

  -- What a person sees. Free text, because "our booking system" is a better
  -- label than any identifier, and it is never interpolated into a request.
  name text not null check (length(trim(name)) between 1 and 80),

  -- What the MODEL sees, and the first half of every tool argument it can
  -- form. Constrained to an identifier so a name can never carry a path, a
  -- host, a quote or a newline into a prompt or a URL.
  slug text not null unique check (slug ~ '^[a-z][a-z0-9_]{0,38}[a-z0-9]$'),

  -- HTTPS ONLY, at the database level as well as in the validator. A plain
  -- http:// base URL would put an API key on the wire in clear text on every
  -- call, and "the operator typed it, so they meant it" is not a defence for a
  -- credential this installation holds on everybody's behalf.
  base_url text not null check (base_url ~ '^https://'),

  -- THE HOST ALLOWLIST, denormalised deliberately.
  --
  -- It is derivable from `base_url`, and it is stored anyway, because it is not
  -- a convenience — it is the invariant. Every request re-parses the URL it is
  -- about to make and refuses unless the host matches this column exactly. A
  -- path template with a scheme in it, a parameter substitution that escapes
  -- the path, a base URL edited between save and use: all three end at this
  -- comparison. Lower-cased on the way in so the comparison is not a locale
  -- question.
  host text not null check (host = lower(host) and host not like '%/%'),

  -- API key in a header, bearer token, or HTTP basic. Deliberately three.
  --
  -- There is no 'none': an API worth connecting is an API that authenticates,
  -- and an unauthenticated entry would make this table a general outbound HTTP
  -- capability with extra steps.
  --
  -- There is no 'oauth' either, and that is a refusal rather than an omission.
  -- CE's OAuth machinery (packages/connectors/src/connections.ts) is built
  -- around a registered client, a provider consent screen and a refresh cycle,
  -- none of which an arbitrary API supplies. A column that said 'oauth' while
  -- the code pasted a long-lived token into a header would be a lie told in
  -- schema, so it is not offered.
  auth_kind text not null check (auth_kind in ('api_key', 'bearer', 'basic')),

  -- `api_key` only: which header carries it. A header NAME, checked against the
  -- RFC 7230 token grammar, so nothing here can inject a second header or a
  -- request line. Null for bearer and basic, which both use `Authorization`.
  --
  -- There is no query-string variant. A key in a URL is a key in the access
  -- log of every proxy between here and there.
  auth_header text check (auth_header is null or auth_header ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'),

  -- Sealed. `{ secret }` for api_key and bearer, `{ username, password }` for
  -- basic. Nothing reads this except the request builder, at the moment of use.
  credentials_enc text not null,

  -- What "test this connection" asks for. A path on this same host, GET, and
  -- nothing else — so testing can never be the way an unlisted endpoint gets
  -- called.
  test_path text not null default '/' check (test_path ~ '^/' and test_path !~ '\.\.'),

  -- LEAST PRIVILEGE, TWICE.
  --
  -- `enabled` starts false and the route that sets it true refuses unless the
  -- last test succeeded. So a connection cannot reach the assistant on the
  -- strength of a form somebody filled in — only on the strength of the API
  -- having answered. Every endpoint under it starts disabled too, separately.
  enabled boolean not null default false,

  status text not null default 'unverified' check (status in ('unverified', 'active', 'needs_attention')),
  last_check_at timestamptz,
  last_check_ok boolean,
  -- A CATEGORY, never the API's words. An arbitrary API's error body is
  -- attacker-influenced text that may quote the request — and a request here
  -- carries an Authorization header. The values are exactly `ErrorCategory` in
  -- packages/connectors/src/providers.ts.
  last_error_category text check (last_error_category is null or last_error_category in (
    'revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'
  )),

  -- Who configured it. `set null` rather than cascade: the connection is
  -- installation plumbing and must not vanish because the administrator who
  -- added it left, but the audit trail should stop naming a user who is gone.
  created_by_user_id uuid references users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index custom_api_connections_enabled on custom_api_connections (enabled, slug);
create trigger custom_api_connections_touch before update on custom_api_connections
  for each row execute function touch_updated_at();

-- ---------- the allowlist ----------
--
-- The whole point of this migration. There is no row anywhere that means "any
-- path on this host", and no code path that composes one: a request Josi makes
-- corresponds to exactly one row here, chosen by `operation_id`.
create table custom_api_endpoints (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references custom_api_connections(id) on delete cascade,

  -- What the model names when it asks for this action. Identifier-shaped for
  -- the same reason `slug` is.
  operation_id text not null check (operation_id ~ '^[a-z][a-z0-9_]{0,62}$'),

  -- What this action does, in the words a person reviewing it will read and the
  -- words the model is given. An imported specification supplies a first draft;
  -- an administrator has to look at it before the row can be enabled.
  summary text not null check (length(trim(summary)) between 1 and 400),

  method text not null check (method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),

  -- A path on the connection's host, with `{name}` placeholders. Never a URL:
  -- the check refuses a scheme, a protocol-relative prefix and dot-segments, so
  -- the only thing this column can express is "somewhere under the base URL".
  path_template text not null check (
    path_template ~ '^/' and path_template !~ '^//' and path_template !~ '\.\.' and path_template !~ '://'
  ),

  -- READ IS SEPARATED FROM WRITE AND DELETE HERE, AND THE METHOD DECIDES.
  --
  -- The constraint below refuses any other pairing, and that refusal is the
  -- point: if `capability` were free, an administrator could label a POST that
  -- creates an invoice as a read, and Josi would then call it without asking
  -- anybody. A search endpoint that genuinely needs POST is therefore treated
  -- as a write and asks for approval. That is the safe side of a trade-off, and
  -- it is a deliberate one.
  capability text not null check (capability in ('read', 'write', 'delete')),
  constraint custom_api_endpoints_capability_matches_method check (
    (method in ('GET', 'HEAD') and capability = 'read')
    or (method in ('POST', 'PUT', 'PATCH') and capability = 'write')
    or (method = 'DELETE' and capability = 'delete')
  ),

  -- `[{ name, in: 'path' | 'query', required, description }]`. The complete set
  -- of inputs this action accepts: an argument the model supplies that is not
  -- named here is dropped, so a new query parameter is a decision somebody
  -- makes rather than one the model discovers.
  parameters jsonb not null default '[]',

  -- Whether a JSON body may be sent. False for every read by construction —
  -- there is nothing to put in a GET body that this feature needs, and allowing
  -- one would be an unreviewed channel into the API.
  accepts_body boolean not null default false,
  constraint custom_api_endpoints_no_body_on_read check (not (accepts_body and capability = 'read')),

  -- OFF. Importing a specification proposes rows; it does not grant them.
  enabled boolean not null default false,

  source text not null default 'manual' check (source in ('manual', 'openapi')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One meaning per name per connection. Two rows called `list_customers` would
  -- make "which one did Josi call?" a question with no answer.
  unique (connection_id, operation_id)
);
create index custom_api_endpoints_enabled on custom_api_endpoints (connection_id, enabled);
create trigger custom_api_endpoints_touch before update on custom_api_endpoints
  for each row execute function touch_updated_at();

-- ---------- the approval gate ----------
--
-- A write or a delete never happens because a model decided to. It becomes a
-- row here, its owner is shown exactly what would be sent, and the request is
-- made only after they say so — once, for that exact request.
--
-- This is the same mechanism `approvals` uses (a pinned payload hash) and
-- deliberately NOT the same table. `approvals` is keyed to a task, a thread, a
-- folder mapping or a document, and its decision route only records a verdict:
-- something else executes afterwards. An approved outbound HTTP call that sits
-- unexecuted, or is executed twice by two surfaces, is the failure mode worth
-- designing out — so here the decision and the request are one transaction on
-- one route, and this table is what makes that possible.
create table custom_api_pending_calls (
  id uuid primary key default gen_random_uuid(),

  -- WHOSE. Every request is made for exactly one person, and only that person
  -- can see or decide it. `cascade` because an approval that outlives its owner
  -- is a request nobody is answerable for.
  owner_user_id uuid not null references users(id) on delete cascade,

  -- Which allowlisted action. `cascade`: removing an action from the allowlist
  -- must take its pending calls with it, or disabling an endpoint would leave
  -- an approved way to call it anyway.
  endpoint_id uuid not null references custom_api_endpoints(id) on delete cascade,

  -- The conversation it came from, when there is one. `cascade` for the same
  -- reason: deleting a conversation must not leave a live action behind it.
  thread_id uuid references threads(id) on delete cascade,

  -- What will happen, in the owner's words, shown before they agree. This is
  -- CONTENT — it may quote what is about to be sent — so it is theirs, and it
  -- is never copied into an audit payload.
  summary text not null check (length(trim(summary)) between 1 and 2000),

  -- The exact arguments, SEALED. Not a jsonb column: a request body on the way
  -- to a CRM is somebody's data, and it has no business being readable in a
  -- database dump while it waits for an answer.
  request_enc text not null,

  -- Pins the approval to this exact request (packages/core/src/approvals.ts,
  -- `approvalHash`). An approval that does not pin the payload is a rubber
  -- stamp: approve "update the record", change the record, send it anyway.
  payload_hash text not null,

  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  decided_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  executed_at timestamptz,
  -- The HTTP status the API answered with. A number, never its body.
  result_status int,

  -- An unanswered request expires. A pending write from last month is not
  -- consent, and offering it as one is how somebody approves something they no
  -- longer remember being asked.
  expires_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index custom_api_pending_calls_owner
  on custom_api_pending_calls (owner_user_id, status, created_at desc);
-- One live request per person per action per payload. A second identical "shall
-- I?" is a bug that trains people to click yes.
create unique index custom_api_pending_calls_one_pending
  on custom_api_pending_calls (owner_user_id, endpoint_id, payload_hash)
  where status = 'pending';
create trigger custom_api_pending_calls_touch before update on custom_api_pending_calls
  for each row execute function touch_updated_at();

-- Defence in depth, matching every other credential-bearing table in this
-- schema. CE connects as the owning role so these do not gate the application;
-- they mean that a second, less-privileged role added later starts from deny.
alter table custom_api_connections enable row level security;
alter table custom_api_endpoints enable row level security;
alter table custom_api_pending_calls enable row level security;
