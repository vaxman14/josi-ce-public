-- Josi CE 0011: backup, export, update, diagnostics, telemetry.
--
-- THE RISK THIS PHASE IS SHAPED AROUND
--
-- The plan states it in one line: "a backup that cannot actually be restored →
-- the restore test is the acceptance criterion, not the backup test." Every
-- schema decision below follows from that. A backup is not a file that was
-- produced; it is a file that has been proven to come back.
--
-- And the second property, from M100: the master key lives OUTSIDE the database
-- and is NOT in the backup. A stolen backup must be useless for credentials.
-- That is a feature, and it is also the most dangerous thing about this phase —
-- an operator who backs up the database and not the key has a backup that
-- restores their data and silently loses every provider key, OAuth token and
-- SMTP password. So the record below tracks whether the key was separately
-- confirmed, and the restore path says plainly what will not come back.

-- ---------- backups ----------
create table backups (
  id uuid primary key default gen_random_uuid(),
  -- `full` is restorable and includes recovery copies (M63). `portable` is the
  -- human-readable export and deliberately excludes them.
  kind text not null check (kind in ('full', 'portable')),
  -- Inside Josi's own volume. Never in a user's mapped folder, and never
  -- somewhere a bind mount could expose it.
  stored_path text not null,
  byte_size bigint not null default 0 check (byte_size >= 0),
  sha256 text,

  -- M63: what is actually inside, recorded rather than inferred, so a restore
  -- can tell an operator what they are about to get back.
  includes_recovery_copies boolean not null default false,
  includes_documents boolean not null default false,
  -- Never true. The master key is not in any backup, and this column exists so
  -- the constraint below can say so permanently.
  includes_master_key boolean not null default false,

  -- M100: whether the operator confirmed they have the key stored separately.
  -- A backup taken without that confirmation is still a backup; it is just one
  -- whose credentials will not survive, and the restore path says so.
  master_key_confirmed boolean not null default false,

  state text not null default 'running' check (state in ('running', 'complete', 'failed')),
  error_category text check (error_category in (
    'disk_full', 'permission_denied', 'database_unavailable', 'timeout', 'unknown'
  )),
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,

  -- The one thing a backup may never contain.
  constraint backup_never_holds_the_key check (includes_master_key = false),
  constraint backup_inside_josi check (stored_path like '/data/backups/%'),
  constraint backup_no_traversal check (position('..' in stored_path) = 0),
  -- M63: a portable export carries no recovery copies, by construction.
  constraint portable_excludes_recovery check (
    kind = 'full' or includes_recovery_copies = false
  )
);
create index backups_recent on backups (created_at desc);

-- Every restore that was attempted, including the ones that failed.
--
-- The failures are the point. "Restored without the master key" is a specific,
-- expected outcome that an operator needs to see named rather than discovering
-- later that their SMTP password no longer works.
create table restore_attempts (
  id uuid primary key default gen_random_uuid(),
  backup_id uuid references backups(id) on delete set null,
  state text not null check (state in ('running', 'complete', 'failed')),
  -- What came back, and what did not.
  credentials_recovered boolean not null default false,
  master_key_present boolean not null default false,
  rows_restored bigint not null default 0,
  error_category text check (error_category in (
    'archive_corrupt', 'wrong_installation', 'version_too_new',
    'database_unavailable', 'no_master_key', 'unknown'
  )),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index restore_attempts_recent on restore_attempts (started_at desc);

-- ---------- updates ----------
-- "Never automatic" is the whole design. There is deliberately NO column here
-- that could enable automatic updating — not one defaulting to false, because a
-- setting that exists is a setting somebody can flip, and a test can only prove
-- the absence of a column, not the permanent falseness of one.
create table update_state (
  id boolean primary key default true check (id),
  channel text not null default 'stable' check (channel in ('stable')),
  current_version text not null default '0.1.0',
  available_version text,
  last_check_at timestamptz,
  last_check_ok boolean,
  updated_at timestamptz not null default now()
);
insert into update_state (id) values (true);
create trigger update_state_touch before update on update_state
  for each row execute function touch_updated_at();

-- M63/M100 again, from the other direction: an update takes a backup FIRST, and
-- the backup id is not nullable once the run has started. An update that could
-- not take a backup does not proceed.
create table update_runs (
  id uuid primary key default gen_random_uuid(),
  from_version text not null,
  to_version text not null,
  backup_id uuid references backups(id) on delete set null,
  state text not null default 'pending' check (state in (
    'pending', 'backing_up', 'applying', 'health_check', 'complete',
    'rolling_back', 'rolled_back', 'failed'
  )),
  -- A category, never a container's stderr: an update failure quotes logs, and
  -- logs quote configuration.
  failure_category text check (failure_category in (
    'backup_failed', 'download_failed', 'migration_failed',
    'health_check_failed', 'rollback_failed', 'unknown'
  )),
  approved_by uuid references users(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index update_runs_recent on update_runs (started_at desc);

-- ---------- diagnostics ----------
-- M113: bundles ALWAYS exclude prompts, chats, email/calendar/contact/task
-- content, uploaded documents and database rows, and users cannot toggle these
-- in. So there is no column here describing what a bundle contains — the answer
-- is fixed by the builder, and a per-bundle content setting would be the toggle
-- M113 forbids.
create table diagnostic_bundles (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references users(id) on delete set null,
  -- M112: 1 hour, 24 hours, 7 days, defaulting to 24.
  log_window text not null default '24h' check (log_window in ('1h', '24h', '7d')),
  stored_path text not null,
  byte_size bigint not null default 0 check (byte_size >= 0),
  -- M109: 25 MB compressed.
  constraint bundle_size_cap check (byte_size <= 26214400),
  sha256 text,

  -- M102: the user inspects the bundle, then consents. Two separate timestamps
  -- because they are two separate acts, and a bundle submitted without the
  -- first one had its consent collected on something nobody looked at.
  inspected_at timestamptz,
  approved_at timestamptz,
  -- The final scan, run after approval and before submission.
  secret_scan_passed_at timestamptz,
  submitted_at timestamptz,
  -- M102: deleted 30 days after ticket closure.
  purge_after timestamptz,

  created_at timestamptz not null default now(),
  constraint bundle_inside_josi check (stored_path like '/data/diagnostics/%'),
  constraint bundle_no_traversal check (position('..' in stored_path) = 0),
  -- Cannot be submitted without having been looked at, approved, and scanned.
  constraint bundle_submission_requires_consent check (
    submitted_at is null
    or (inspected_at is not null and approved_at is not null and secret_scan_passed_at is not null)
  )
);
create index diagnostic_bundles_purge on diagnostic_bundles (purge_after)
  where purge_after is not null;

-- ---------- support ----------
-- M115: CE ships the CLIENT CONTRACT only. There is no Zammad host, no
-- credential, and no default gateway URL — an unset gateway means the support
-- page explains how to file an issue manually rather than silently posting
-- somewhere.
create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  created_by uuid references users(id) on delete set null,
  -- M104: routed and prioritised separately.
  category text not null check (category in (
    'bug_report', 'feature_request', 'paid_support', 'security_privacy'
  )),
  description text not null,
  bundle_id uuid references diagnostic_bundles(id) on delete set null,
  -- M107: the submitter acknowledged there is no guaranteed response or fix,
  -- and that paid support is a request to be contacted rather than a purchase.
  acknowledged_no_guarantee boolean not null default false,
  state text not null default 'draft' check (state in ('draft', 'submitted', 'closed')),
  submitted_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),

  -- M105: diagnostics are mandatory for bug reports and paid support.
  constraint ticket_requires_diagnostics check (
    state <> 'submitted'
    or category in ('feature_request', 'security_privacy')
    or bundle_id is not null
  ),
  -- M107.
  constraint ticket_requires_acknowledgement check (
    state <> 'submitted' or acknowledged_no_guarantee = true
  )
);
create index support_tickets_recent on support_tickets (created_at desc);

-- ---------- telemetry ----------
-- M98: opt-in only, off unless affirmatively enabled, and never content.
--
-- Phase 3 created this table and captured the CHOICE at setup, with a check
-- constraint saying enabled implies opted_in_at. This adds the TRANSMISSION
-- side; the Phase 3 constraint still governs, so enabling telemetry without
-- recording when somebody agreed remains impossible.
--
-- The important addition is `last_payload`: what was actually sent, kept so a
-- suspicious operator can read it rather than taking our word for it.
alter table telemetry_state add column endpoint text;
alter table telemetry_state add column last_sent_at timestamptz;
alter table telemetry_state add column last_status text
  check (last_status in ('ok', 'failed', 'never'));
alter table telemetry_state add column last_payload jsonb;
alter table telemetry_state add column consecutive_failures integer not null default 0
  check (consecutive_failures >= 0);

alter table backups enable row level security;
alter table restore_attempts enable row level security;
alter table diagnostic_bundles enable row level security;
alter table support_tickets enable row level security;
