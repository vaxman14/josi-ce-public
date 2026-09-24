-- Josi CE 0038: Parental Controls — a paid module, and a second authority.
--
-- Everything before this migration answers the same question about a private
-- row: IS IT YOURS. `resolveAccess` says ownership or an explicit share, and
-- says that neither workspace membership nor super-admin status grants
-- anything. That is still true after this migration, and nothing here changes
-- it: `resolveAccess` is not touched, there is no new resource type in it, and
-- no share row is written by anything in this feature.
--
-- What this adds is a SECOND, NARROWER authority that lives beside it:
--
--   ONE NAMED ADULT MAY SEE ONE NAMED CHILD'S CONVERSATIONS WITH JOSI,
--   BECAUSE A ROW HERE SAYS SO, AND FOR NO OTHER REASON.
--
-- Four decisions follow from that sentence, and each one is a table below.
--
--  1. IT IS OFF UNLESS SOMEBODY BOUGHT IT. `module_entitlements` is empty on
--     every fresh installation and on every upgrade. With no row, the routes
--     answer 404, the schedule enforces nothing, the parent surface does not
--     exist and a managed child is an ordinary member. The schema exists
--     because migrations must be the same everywhere; the FEATURE does not.
--
--  2. AUTHORITY IS A RELATIONSHIP, NEVER A ROLE. `parental_links` is the only
--     thing that grants it. There is no column anywhere that says "this person
--     may see children", no role that implies it, and no administrator path to
--     it. The super admin who activated the module has exactly the same access
--     to a family's conversations as a stranger: none.
--
--  3. THE RELATIONSHIP IS THE CROWN JEWEL, SO CHANGING IT COSTS MORE THAN A
--     SESSION. `parental_authority_grants` is what a create or a removal is
--     spent against, and a grant is only issued for a password AND a TOTP code
--     together. A held session is not enough, and neither is a stolen password.
--     Single use, five minutes, scoped to one session.
--
--  4. WHAT IS ENFORCED IS WHAT THIS STACK CAN ACTUALLY SEE. `child_controls`,
--     `child_schedule_windows` and `child_activity_minutes` govern TIME SPENT
--     TALKING TO JOSI HERE — every channel, because every channel goes through
--     one turn function. They do not lock a phone, block an app, or filter the
--     web, and nothing in this schema pretends otherwise. A minute is recorded
--     when a turn happens; there is no column for a device, because there is
--     no device to be honest about.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No conversation text lives here. Parental visibility is a read of the child's
-- own `threads` and `messages` rows, decided by `parental_links` at the moment
-- of the read, so ending the relationship ends the visibility with nothing to
-- delete. No copy is made, because a copy would outlive the authority.

-- ---------- the paid module ----------
--
-- ONE ROW PER MODULE, WRITTEN ONLY BY THE SUPER ADMIN, AND ONLY AGAINST A
-- LICENCE THAT VERIFIED. The signature is checked by the activation route
-- against the publisher key stamped into the build; what is stored is the
-- token and the facts read out of it, so support can answer "what is this
-- installation entitled to" without anybody holding a private key.
--
-- Buying is installation administration — billing, plumbing, the same category
-- as SMTP. It is NOT parental authority, and the routes are separate so that
-- the two can never be confused: nothing an administrator can reach returns a
-- child, a schedule, a limit, a minute or a message.
create table if not exists module_entitlements (
  module text primary key check (module in ('parental_controls')),

  -- The licence exactly as it was pasted. Kept so that an operator can be told
  -- what they activated and so a support question does not need the private
  -- key. Not a credential for anything: it opens no account and reaches no
  -- service. It is only ever shown back to the super admin who holds it.
  license_token text not null,

  -- Read out of the verified payload, so the admin screen is not re-parsing a
  -- token on every page load.
  license_id text not null check (length(trim(license_id)) between 1 and 120),
  issued_to text not null check (length(trim(issued_to)) between 1 and 200),

  -- Which installation the licence names, when it names one. Compared against
  -- `install_identity.install_id` on every read, so a database copied to a
  -- second machine does not carry the entitlement with it. Null means the
  -- licence is not bound to an installation and says so on screen.
  bound_install_id uuid,

  issued_at timestamptz not null,
  -- Null means perpetual. A past date means the module is inert again, which
  -- is arithmetic rather than a job that has to run.
  expires_at timestamptz,

  activated_by uuid references users(id) on delete set null,
  activated_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null
);

-- ---------- who may look after whom ----------
--
-- The whole authority, in one table. A row is created only by somebody who has
-- just proved a password AND a second factor, and ending it is the same price.
create table if not exists parental_links (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references users(id) on delete cascade,
  child_user_id uuid not null references users(id) on delete cascade,

  created_by_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Ended rather than deleted: the audit trail records that a relationship
  -- existed, and a row that vanishes takes that with it. An ended row grants
  -- nothing — every query that decides access filters on `ended_at is null`.
  ended_at timestamptz,
  ended_by_user_id uuid references users(id) on delete set null,

  -- Nobody is their own guardian.
  constraint parental_links_not_self check (parent_user_id <> child_user_id)
);

-- ONE LIVE CONTROLLER PER CHILD. Two adults with authority over one account is
-- a feature request; two adults with authority over one account and no rule
-- about who wins is an ambiguity in an access-control decision, and this is
-- not the table to be ambiguous in.
create unique index if not exists parental_links_one_live_controller
  on parental_links (child_user_id) where ended_at is null;
create index if not exists parental_links_by_parent on parental_links (parent_user_id) where ended_at is null;

-- ---------- what a managed child's day looks like ----------
--
-- One row per managed child, created with the link. Everything is permissive by
-- default and NOT because default-deny was forgotten: the boundary that is
-- default-denied in this feature is AUTHORITY AND VISIBILITY, and it is. A new
-- child account that could not talk to Josi until an adult had drawn a
-- timetable would be a broken account, not a safe one.
create table if not exists child_controls (
  child_user_id uuid primary key references users(id) on delete cascade,

  -- Whose day it is. A limit measured in the parent's timezone would end a
  -- child's evening at the wrong hour.
  timezone text not null default 'UTC' check (length(trim(timezone)) between 1 and 60),

  -- Null means no limit. Counted in whole minutes in which the child sent
  -- something to Josi — see `child_activity_minutes` for why that is the only
  -- honest unit available here.
  daily_limit_minutes integer check (daily_limit_minutes is null or daily_limit_minutes between 5 and 1440),

  -- When false the timetable below is ignored entirely. When true, a weekday
  -- with no window is a weekday with no access, which is the only reading of
  -- "these are the allowed hours" that is not a surprise.
  schedule_enabled boolean not null default false,

  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references users(id) on delete set null
);

create table if not exists child_schedule_windows (
  id uuid primary key default gen_random_uuid(),
  child_user_id uuid not null references users(id) on delete cascade,
  -- 0 = Sunday, matching JavaScript's getDay() and PostgreSQL's `dow`, so no
  -- layer has to remember an off-by-one.
  weekday smallint not null check (weekday between 0 and 6),
  -- Minutes from local midnight. 1440 is a legal END and means "until
  -- midnight"; a window may not start there.
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute integer not null check (end_minute between 1 and 1440),
  constraint child_schedule_windows_ordered check (end_minute > start_minute),
  unique (child_user_id, weekday, start_minute)
);
create index if not exists child_schedule_windows_by_child on child_schedule_windows (child_user_id, weekday);

-- ---------- how much of the day has been used ----------
--
-- ONE ROW PER MINUTE IN WHICH THE CHILD SPOKE TO JOSI. Not a session, not a
-- device sample, not an estimate — the coarsest unit this stack can actually
-- observe, recorded when a turn runs and never inferred between turns.
--
-- This is the whole reason the limit can be described honestly. "45 minutes a
-- day" here means "45 minutes in which you said something to Josi", and the
-- screens say exactly that. A stack that cannot see a screen being looked at
-- must not sell a screen-time limit.
create table if not exists child_activity_minutes (
  child_user_id uuid not null references users(id) on delete cascade,
  -- Truncated to the minute, in UTC. Days are cut in the child's own timezone
  -- at read time, so moving a child between timezones cannot rewrite history.
  minute timestamptz not null,
  -- Where the turn came in. Recorded because a parent asking "when is this
  -- happening" deserves the answer, and because the number would otherwise
  -- look like it was only about the web app.
  channel text not null check (channel in ('web', 'telegram', 'external')),
  primary key (child_user_id, minute)
);

-- ---------- proving it is really the adult ----------
--
-- Creating, changing or ending a relationship is spent against one of these.
-- A grant requires a password AND a TOTP code in the same request, is good for
-- five minutes, is bound to one session, and is consumed by the first
-- relationship change that uses it.
--
-- Why not `step_up_verifications`: that table is honest about being password
-- re-authentication and its CHECK says so. Re-authentication defends against a
-- held session; it does not defend against a stolen password, and handing over
-- authority to see a child's conversations is exactly the act that must cost
-- more than one secret. A second row type would have quietly widened what that
-- table's name promises.
create table if not exists parental_authority_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_key text not null,
  -- One value, and the CHECK is the point: a future edit that wants to issue a
  -- grant for a password alone has to change the schema to do it.
  factors text not null default 'password_totp' check (factors = 'password_totp'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_for text,
  created_at timestamptz not null default now()
);
create index if not exists parental_authority_grants_live
  on parental_authority_grants (user_id, session_key, expires_at) where used_at is null;

alter table module_entitlements enable row level security;
alter table parental_links enable row level security;
alter table child_controls enable row level security;
alter table child_schedule_windows enable row level security;
alter table child_activity_minutes enable row level security;
alter table parental_authority_grants enable row level security;
