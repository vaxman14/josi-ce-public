-- V2.4: the rest of the model providers, admitted to the constraints.
--
-- 0022 exists because `anthropic_subscription` shipped in code before anyone
-- widened this CHECK, and the first attempt to store it died on a raw 23514
-- that the UI relayed as "something broke on our side". Fourteen providers land
-- here at once, so the same mistake would have been fourteen times louder.
--
-- The list below is not maintained by hand against the TypeScript union. A test
-- parses this constraint and asserts it matches `PROVIDERS` in
-- packages/llm/src/catalog.ts exactly, in both directions: a provider added to
-- the catalogue without a migration fails CI, and so does a value left here
-- after a provider is removed.
alter table llm_providers drop constraint if exists llm_providers_provider_check;
alter table llm_providers add constraint llm_providers_provider_check check (
  provider in (
    'openai_compatible',
    'openai', 'anthropic', 'xai',
    -- Vendors reached over the OpenAI chat-completions contract. Separate kinds
    -- rather than `openai_compatible` rows with a different base URL, because
    -- `openai_compatible` is classified as NON-external: it is exempt from the
    -- data-leaves-this-server acknowledgement and permitted under Local-only
    -- mode. Storing a hosted vendor as one would send user data to a third
    -- party while the installation still claimed nothing left the server.
    'deepseek', 'qwen', 'mistral', 'moonshot', 'zhipu', 'openrouter', 'minimax',
    -- Vendors with their own adapter, because their contract genuinely differs.
    'gemini', 'cohere', 'bedrock', 'azure_ai', 'vertex_ai', 'ernie', 'hunyuan',
    -- The CLI subscription paths.
    'openai_subscription', 'anthropic_subscription'
  )
);

-- The non-secret half of a provider's configuration.
--
-- An AWS region, a Google Cloud project and location, an Azure API version.
-- These are ordinary settings and are deliberately NOT in the sealed envelope:
-- an operator has to be able to see which region their model calls go to, and a
-- write-only region is a support conversation waiting to happen. Everything
-- that is genuinely a credential stays in `api_key_enc`, which is sealed with
-- the installation master key and never read back to a screen.
--
-- Which field belongs on which side is declared once, per provider, in
-- catalog.ts, so the save route and the admin form cannot disagree about it.
alter table llm_providers add column if not exists provider_config jsonb not null default '{}';

-- `{}` and not null, so every read gets an object rather than having to guess
-- whether a missing key means "unset" or "this row predates the column".
comment on column llm_providers.provider_config is
  'Non-secret provider settings (region, project, api version). Never credentials.';

-- The no-key rule is unchanged and re-stated rather than assumed: it applies to
-- the subscription kinds only, and every provider added above legitimately has
-- a credential. Restating it here means this migration alone describes the
-- constraint's final shape, instead of it having to be reconstructed from 0015,
-- 0022 and this file in order.
alter table llm_providers drop constraint if exists llm_subscription_has_no_key;
alter table llm_providers add constraint llm_subscription_has_no_key check (
  provider not in ('openai_subscription', 'anthropic_subscription') or api_key_enc is null
);

-- Prices are per provider and model, and the new providers have none shipped:
-- `priceCall` already reports tokens with a zero cost and an explicit note when
-- a model has no price, which is the honest answer. No rows are invented here —
-- a made-up price is worse than a visible gap, because it looks like a bill.
