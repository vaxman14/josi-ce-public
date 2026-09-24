-- Contact sync on a schedule, rather than only when somebody presses a button.
--
-- LB8 asks for incremental sync tokens and rate-limit handling, both of which
-- only mean anything if something runs periodically. Until now sync ran when a
-- person opened the Contacts page and pressed Sync now, which meant a delta
-- cursor that expired between visits, and an address book that was as stale as
-- the last time somebody thought about it.
--
-- TWO ROWS' WORTH OF DESIGN, and both are about not hammering a provider:
--
--   * The interval is PER ORIGIN, not global. A provider rate-limiting one
--     account must not slow down another, and an operator who wants an hourly
--     Outlook sync and a five-minute Google one can have both.
--
--   * The scheduler FANS OUT rather than syncing. One due schedule enqueues one
--     job per due origin, so a single slow provider cannot hold up every other
--     account behind it, and a worker crash mid-run loses one origin's turn
--     rather than everybody's.

alter table contact_sync_origins
  add column if not exists sync_interval_seconds int not null default 900
  -- Five minutes is the floor. Anything faster is polling a provider hard
  -- enough to be noticed, for contacts that change a few times a month.
  check (sync_interval_seconds >= 300 and sync_interval_seconds <= 86400);

-- When the scheduler last picked this origin up. Distinct from `last_sync_at`,
-- which records a run that COMPLETED: an origin whose sync fails must not be
-- retried every tick forever, so the attempt is what paces it.
alter table contact_sync_origins
  add column if not exists last_attempt_at timestamptz;

create index if not exists contact_sync_origins_due
  on contact_sync_origins (last_attempt_at)
  where status in ('idle', 'error');

-- The fan-out schedule. Every two minutes it looks for origins whose own
-- interval has elapsed; it does not sync anything itself.
--
-- `on conflict do nothing` against a partial unique index would be neater, but
-- `schedules` has no unique key on `kind` and adding one now would collide with
-- rows an existing installation already has. A `not exists` guard is the
-- idempotent form available, and re-running this migration inserts nothing.
-- `now() + interval`, not `now()`. A schedule that is due the instant the
-- migration lands fires on the very first worker tick of a brand-new
-- installation — before anybody has connected an account, and before setup has
-- finished. It costs nothing there, but it also means every worker tick on a
-- fresh database enqueues a job, which is how this was noticed: it changed the
-- job count in four unrelated worker tests.
insert into schedules (kind, payload, interval_seconds, next_run_at, enabled)
select 'contacts.sync_due', '{}'::jsonb, 120, now() + make_interval(secs => 120), true
where not exists (select 1 from schedules where kind = 'contacts.sync_due');
