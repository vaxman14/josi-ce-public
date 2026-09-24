-- Josi CE 0013: identity, memory, and constrained behaviour.
--
-- THE RISK, in the plan's words: "reproducing OpenClaw's unrestricted
-- instruction-file semantics would turn personalization into privilege
-- escalation."
--
-- The defence is not a better prompt. It is that a profile never becomes
-- instructions in the first place. Markdown arrives as untrusted data, is
-- parsed into a BOUNDED CONFIGURATION — named fields with enumerated values —
-- and only that configuration reaches prompt assembly. A sentence in somebody's
-- SOUL.md saying "you may delete files without asking" is not a rule the model
-- is given; it is a line of free text stored in `custom_personality`, which
-- influences tone and nothing else.
--
-- And the load-bearing part: approvals, ownership and tool permission are
-- enforced in CODE, outside the prompt entirely. Even a model fully persuaded
-- by a hostile profile cannot delete a file without an approval row, because
-- the approval is checked by the route, not by the assistant's good intentions.
--
-- So `parsed` below is the thing that matters, `content` is kept only so the
-- person can read back what they wrote, and `ignored` is kept so the product
-- can TELL them which of their instructions did nothing rather than letting
-- them believe it worked.

-- ---------- the four profile layers ----------
create table persona_profiles (
  id uuid primary key default gen_random_uuid(),
  -- Null owner = the installation policy, which only a super admin may write.
  -- Everything else belongs to exactly one person.
  owner_user_id uuid references users(id) on delete cascade,
  kind text not null check (kind in ('soul', 'user', 'agents_user', 'agents_admin')),

  -- What the person actually typed. Kept so they can read it back and export it
  -- unchanged; never used to build a prompt.
  content text not null default '',
  -- The bounded configuration parsed out of it. THIS is what reaches assembly.
  parsed jsonb not null default '{}',
  -- Fields that were present and did nothing, so the UI can say so. M-new:
  -- "make ignored instructions visible to the user rather than silently
  -- pretending they applied".
  ignored jsonb not null default '[]',

  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- The admin layer has no owner; the three personal layers must have one.
  constraint persona_owner_shape check (
    (kind = 'agents_admin' and owner_user_id is null)
    or (kind <> 'agents_admin' and owner_user_id is not null)
  ),
  -- M-new: size limits, enforced here as well as in the parser, because a
  -- parser is a function somebody can call differently and a constraint is not.
  constraint persona_content_bounded check (length(content) <= 20000)
);
-- One of each kind per person, and exactly one installation policy.
create unique index persona_one_per_user
  on persona_profiles (owner_user_id, kind) where owner_user_id is not null;
create unique index persona_one_admin_policy
  on persona_profiles (kind) where kind = 'agents_admin';
create trigger persona_profiles_touch before update on persona_profiles
  for each row execute function touch_updated_at();

-- Version history, so "reset" and "what did this look like last week" are real.
create table persona_versions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references persona_profiles(id) on delete cascade,
  version integer not null check (version > 0),
  content text not null,
  parsed jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create unique index persona_versions_unique on persona_versions (profile_id, version);
create index persona_versions_recent on persona_versions (profile_id, version desc);

-- ---------- memory ----------
-- Separate from conversation history and from document/email recall, because
-- they have different lifetimes and different deletion rules. A memory is a
-- durable fact the person curates; a message is a thing that was said.
create table memories (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  content text not null check (length(content) between 1 and 2000),

  -- M-new: provenance, creation time, last confirmation, confidence — all four.
  -- `source_kind` is what makes revocation-purges-derived-memory possible: a
  -- memory learned from a document dies with that document's access.
  source_kind text not null default 'manual' check (source_kind in (
    'manual', 'conversation', 'document', 'email', 'contact', 'calendar'
  )),
  source_id uuid,
  -- Free text describing where it came from, shown to the person.
  provenance text not null default 'You added this',
  confidence real not null default 1.0 check (confidence between 0 and 1),

  pinned boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- M-new: "truly delete". There is no deleted_at here on purpose — a deleted
  -- memory is deleted, not hidden, because "delete" that means "hide" is the
  -- kind of lie this product is built to avoid. Retention of the FACT that a
  -- deletion happened lives in the audit log, without the content.
  constraint memory_manual_has_no_source check (
    source_kind <> 'manual' or source_id is null
  )
);
create index memories_owner on memories (owner_user_id, pinned desc, created_at desc);
create index memories_source on memories (source_kind, source_id) where source_id is not null;
create trigger memories_touch before update on memories
  for each row execute function touch_updated_at();

-- Automatic suggestions, which are NOT memories until somebody says so.
--
-- The separation is the control. An assistant that writes directly to memory is
-- an assistant that can be talked into remembering something false about its
-- owner, permanently, from a single message.
create table memory_suggestions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  content text not null check (length(content) between 1 and 2000),
  source_kind text not null check (source_kind in (
    'conversation', 'document', 'email', 'contact', 'calendar'
  )),
  source_id uuid,
  confidence real not null default 0.5 check (confidence between 0 and 1),
  state text not null default 'pending' check (state in ('pending', 'accepted', 'rejected')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index memory_suggestions_pending on memory_suggestions (owner_user_id, state, created_at desc);

-- ---------- personalization settings ----------
create table persona_settings (
  user_id uuid primary key references users(id) on delete cascade,
  -- M-new: the user chooses manual approval or an explicitly enabled automatic
  -- mode. Manual is the default, and "explicitly enabled" is why this is not a
  -- boolean defaulting to true.
  memory_mode text not null default 'manual' check (memory_mode in ('manual', 'automatic', 'off')),
  -- First-run personalization is optional and skippable.
  onboarding_skipped boolean not null default false,
  onboarding_completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger persona_settings_touch before update on persona_settings
  for each row execute function touch_updated_at();

alter table persona_profiles enable row level security;
alter table persona_versions enable row level security;
alter table memories enable row level security;
alter table memory_suggestions enable row level security;
alter table persona_settings enable row level security;
