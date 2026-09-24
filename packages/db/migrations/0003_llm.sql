-- Josi CE 0003: model capabilities, usage accounting, and spending caps.
--
-- Two ideas do the work here:
--
--   * A capability is something that was OBSERVED, never inferred. Columns are
--     null until a probe ran, and null means "unknown", which CE treats as "off"
--     rather than "probably fine".
--   * A cost is either something the provider told us or something we worked
--     out ourselves, and the two are never allowed to look alike.

-- ---------- what the probe found ----------
alter table llm_providers add column probed_at timestamptz;
alter table llm_providers add column cap_chat boolean;
alter table llm_providers add column cap_structured_output boolean;
alter table llm_providers add column cap_tool_calling boolean;
alter table llm_providers add column cap_context_tokens integer;
-- The individual probe steps, so an operator can see WHICH question failed
-- rather than just that something did. Metadata only: no prompts, no replies.
alter table llm_providers add column probe_steps jsonb not null default '[]';
-- Set by a probe that succeeded at basic chat. `activated_at` is what the rest
-- of CE reads to decide whether a provider may be used at all.
-- (declared in 0002; only ever set from here)

-- A provider may not be marked active without a probe behind it. This is the
-- database half of "never pretend the model is fully compatible".
alter table llm_providers add constraint llm_active_requires_probe check (
  activated_at is null or (probed_at is not null and cap_chat = true)
);

-- ---------- local-only mode ----------
-- M90. Lives on security_policy because it is a privacy posture, not a model
-- setting: it forbids anything that would send content off this server.
alter table security_policy add column local_only boolean not null default false;

-- ---------- usage ----------
-- One row per model call. `cost_source` is the column that keeps M88 honest:
--
--   reported   the provider told us what it charged
--   estimated  we multiplied tokens by a price we hold locally, which can drift
--   none       self-hosted; there is no provider charge, and hardware and
--              electricity are explicitly not counted
create table llm_usage (
  id bigint generated always as identity primary key,
  user_id uuid references users(id) on delete set null,
  provider text not null,
  model text not null,
  role text not null check (role in ('primary', 'fallback')),
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6),
  cost_source text not null check (cost_source in ('reported', 'estimated', 'none')),
  latency_ms integer,
  -- Why a call happened, for aggregate reporting. Never the content of it.
  purpose text,
  created_at timestamptz not null default now()
);
create index llm_usage_month on llm_usage (created_at desc);
create index llm_usage_user on llm_usage (user_id, created_at desc);

-- An estimate must carry a number, and a self-hosted call must not pretend to
-- have cost money.
alter table llm_usage add constraint llm_usage_cost_shape check (
  (cost_source = 'none' and coalesce(cost_usd, 0) = 0)
  or (cost_source in ('reported', 'estimated') and cost_usd is not null)
);

-- ---------- caps ----------
-- One installation-wide cap, plus optional per-user caps. Both are monthly and
-- both are measured in whichever unit the operator chose.
create table llm_caps (
  id boolean primary key default true check (id),
  -- null = no cap. A cap of 0 would mean "nothing at all", which is different.
  monthly_cost_usd numeric(12, 2),
  monthly_tokens bigint,
  updated_at timestamptz not null default now()
);
insert into llm_caps (id) values (true);
create trigger llm_caps_touch before update on llm_caps
  for each row execute function touch_updated_at();

create table llm_user_caps (
  user_id uuid primary key references users(id) on delete cascade,
  monthly_cost_usd numeric(12, 2),
  monthly_tokens bigint,
  updated_at timestamptz not null default now()
);
create trigger llm_user_caps_touch before update on llm_user_caps
  for each row execute function touch_updated_at();

alter table llm_caps add constraint llm_caps_positive check (
  (monthly_cost_usd is null or monthly_cost_usd > 0)
  and (monthly_tokens is null or monthly_tokens > 0)
);
alter table llm_user_caps add constraint llm_user_caps_positive check (
  (monthly_cost_usd is null or monthly_cost_usd > 0)
  and (monthly_tokens is null or monthly_tokens > 0)
);

-- ---------- price table ----------
-- Local, editable, and the reason estimates are labelled as estimates: these
-- numbers go stale the moment a provider changes its pricing page, and CE has
-- no way to know that it happened.
create table llm_prices (
  id bigint generated always as identity primary key,
  provider text not null,
  model text not null,
  input_usd_per_mtok numeric(12, 4) not null,
  output_usd_per_mtok numeric(12, 4) not null,
  updated_at timestamptz not null default now()
);
create unique index llm_prices_key on llm_prices (provider, model);

alter table llm_usage enable row level security;
alter table llm_caps enable row level security;
alter table llm_user_caps enable row level security;
alter table llm_prices enable row level security;
