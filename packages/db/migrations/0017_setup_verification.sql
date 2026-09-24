-- What setup actually TESTED, as opposed to what it merely saved.
--
-- The defect this closes: the wizard collected a provider key, SMTP
-- credentials and OAuth client secrets, wrote them all to the database, and
-- told the operator each one was "configured". Nothing had contacted anything.
-- The review screen then reported a fully configured installation whose model,
-- mail and connectors had never been shown to work — and the first evidence to
-- the contrary arrived when a real user tried to do something.
--
-- Saving a field and reaching a service are different events, so they get
-- different records. `llm_providers.activated_at`, `smtp_profiles.verified_at`
-- and the like say WHETHER; this says WHAT HAPPENED, including when it failed,
-- which is the half that was impossible to represent before.

create table if not exists setup_verifications (
  -- 'llm' | 'smtp' | 'connector_google' | 'connector_microsoft'. Not an enum:
  -- a check constraint here would need a migration every time a step is added,
  -- and the set of testable things is a product decision that lives in code.
  item text primary key,

  -- Three outcomes, and `skipped` is one of them. An operator who declined to
  -- configure mail has not failed and has not passed; recording that as either
  -- is how a review screen ends up lying in one direction or the other.
  status text not null check (status in ('passed', 'failed', 'skipped')),

  -- The failure category from packages/llm — authentication, authorization,
  -- rate_limit, billing, network and so on. Null when it passed or was skipped.
  category text,

  -- Operator-facing, safe to display, and never a credential. Enforced in code
  -- by only ever writing text the product composed.
  detail text,

  -- Safe metadata about what was tested: the address a test message was sent
  -- to, the model identifier that answered, the redirect URI that handshook.
  -- Never a secret, and shown on the review screen so "tested" is checkable.
  target text,

  checked_at timestamptz not null default now()
);

create index if not exists setup_verifications_status on setup_verifications (status);
