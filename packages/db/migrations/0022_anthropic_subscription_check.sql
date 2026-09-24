-- The Claude subscription path, admitted to the constraints that guard it.
--
-- 0015 widened `llm_providers_provider_check` for `openai_subscription` and
-- said, correctly, that a new provider kind needs a migration. Then the Claude
-- path was added in code and this migration was never written — so the first
-- attempt to switch the primary slot to `anthropic_subscription` died on the
-- CHECK with a raw 23514, which the UI relayed as "something broke on our
-- side". Three identical failed inserts in a row on a live installation found
-- it; this is the migration that should have shipped with the feature.
alter table llm_providers drop constraint if exists llm_providers_provider_check;
alter table llm_providers add constraint llm_providers_provider_check check (
  provider in (
    'openai', 'anthropic', 'xai', 'openai_compatible',
    'openai_subscription', 'anthropic_subscription'
  )
);

-- The no-key rule applies to EVERY subscription kind, for the same reason it
-- exists at all: "use my subscription" that quietly charges an API key is the
-- misrepresentation the whole feature must avoid. 0015 pinned it to the one
-- kind that existed then.
alter table llm_providers drop constraint if exists llm_subscription_has_no_key;
alter table llm_providers add constraint llm_subscription_has_no_key check (
  provider not in ('openai_subscription', 'anthropic_subscription') or api_key_enc is null
);
