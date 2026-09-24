-- Josi CE 0015: noncommercial subscription authentication (CE only).
--
-- WHAT THIS IS, IN ONE PARAGRAPH
--
-- OpenAI documents `codex exec`, a non-interactive mode of its own first-party
-- Codex CLI, and documents that the CLI may be signed in with a ChatGPT plan.
-- On a Community Edition installation — one person's own machine, their own
-- subscription, their own productivity — Josi may run that binary as a
-- subprocess instead of holding an API key. Josi does not implement "Sign in
-- with ChatGPT", does not read `~/.codex/auth.json`, does not copy, store,
-- forward or refresh any token, and makes no HTTP request to OpenAI on this
-- path at all. It runs the operator's own signed-in binary, which is what the
-- operator would otherwise type into their own terminal.
--
-- WHY THERE IS NO ANTHROPIC EQUIVALENT
--
-- Anthropic's authentication and credential-use policy restricts Claude
-- Free/Pro/Max OAuth to Claude Code and Claude.ai, states that using those
-- tokens in any other product, tool or service — including the Agent SDK — is
-- not permitted, and was enforced against third-party harnesses on 4 April
-- 2026. There is no supported path, so CE does not have one and the UI says why
-- rather than saying "coming soon".
--
-- WHY THE COLUMNS BELOW ARE ALMOST EMPTY
--
-- Because there is no credential to store. That is the point. A subscription
-- provider row records WHICH binary to run and WHICH model to ask for, and
-- nothing else — there is no `api_key_enc` for it, no token, no refresh, no
-- expiry. The capability that permits it is stamped into the build
-- (`packages/core/src/edition.ts`), not stored here, so a hosted build reading
-- this same schema still cannot use these rows.

-- ---------- the charge basis ----------
--
-- A subscription call has no per-call price and never will. Recording it as
-- `estimated` would put a made-up number next to a flat monthly fee; recording
-- it as `none` would file it with self-hosted calls and make the "no provider
-- charge" note wrong in a subtle way — a subscription IS a provider charge,
-- just not a per-call one. So it gets its own value.
alter table llm_usage drop constraint if exists llm_usage_cost_source_check;
alter table llm_usage add constraint llm_usage_cost_source_check
  check (cost_source in ('reported', 'estimated', 'none', 'subscription'));

alter table llm_usage drop constraint if exists llm_usage_cost_shape;
alter table llm_usage add constraint llm_usage_cost_shape check (
  (cost_source in ('none', 'subscription') and coalesce(cost_usd, 0) = 0)
  or (cost_source in ('reported', 'estimated') and cost_usd is not null)
);

-- ---------- the provider kind ----------
--
-- `llm_providers.provider` has been an enumerated CHECK since 0002, which is
-- the right shape and is also why a new kind needs a migration rather than a
-- constant. Widening it here rather than dropping the check: an unbounded
-- column would let a typo become a provider nobody can call and nobody can
-- explain.
alter table llm_providers drop constraint if exists llm_providers_provider_check;
alter table llm_providers add constraint llm_providers_provider_check check (
  provider in ('openai', 'anthropic', 'xai', 'openai_compatible', 'openai_subscription')
);

-- ---------- the local binary ----------
--
-- Which command to run, recorded so an operator whose Codex lives somewhere
-- unusual can say so, and so the admin screen can show what will actually be
-- executed rather than an assumption.
alter table llm_providers add column if not exists subscription_command text;

-- The last time the binary was found and reported a version. Same discipline as
-- Phase 4's probe: what was OBSERVED, not what was assumed. A row whose binary
-- has since been uninstalled shows a stale timestamp rather than pretending.
alter table llm_providers add column if not exists subscription_checked_at timestamptz;
alter table llm_providers add column if not exists subscription_version text;

-- A subscription provider must never carry an API key.
--
-- Not a policy in code — a constraint. "Use my subscription" that quietly
-- charges an API key is the exact misrepresentation this whole feature has to
-- avoid, and it is the kind of thing a later refactor does by accident when it
-- reuses the ordinary provider save path.
alter table llm_providers drop constraint if exists llm_subscription_has_no_key;
alter table llm_providers add constraint llm_subscription_has_no_key check (
  provider <> 'openai_subscription' or api_key_enc is null
);
