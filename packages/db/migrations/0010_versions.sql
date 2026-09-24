-- Josi CE 0010: documents and storage, part four — history, sync, audit.
--
-- M60–M62 are the part of Phase 9 most likely to surprise someone, so the
-- schema is written to make the surprise impossible instead:
--
--   * History is OFF by default. Keeping copies of people's documents is not
--     something to switch on by accident.
--   * "Snapshot" and "recovery copy" are different products. A snapshot is
--     metadata about a version; a recovery copy is the FILE, kept on the
--     server, downloadable. Only the second one has storage and privacy
--     consequences, and M62 requires saying so plainly.
--   * M62: there is no application-level encryption for recovery copies. They
--     inherit whatever the Docker volume and host give them. Pretending
--     otherwise would be worse than saying it.

-- ---------- versions ----------
create table document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- 1 is the oldest kept version. The current file is not a version.
  ordinal integer not null check (ordinal > 0),
  content_hash text not null,
  byte_size bigint not null default 0 check (byte_size >= 0),
  source_modified_at timestamptz,

  -- M60. A snapshot records that a version existed; a recovery copy holds the
  -- bytes. The distinction is the whole of M60/M62, so it is a column rather
  -- than an inference from whether `stored_path` happens to be null.
  kind text not null check (kind in ('snapshot', 'recovery_copy')),
  -- Where the bytes live, for recovery copies only. Inside Josi's own volume,
  -- never in the user's mapped folder.
  stored_path text,

  -- M79: when the source is deleted while the mapping remains authorised, a
  -- recovery copy survives in the recycle bin for an admin-selected window.
  source_deleted_at timestamptz,
  purge_after timestamptz,

  created_at timestamptz not null default now(),

  constraint version_bytes_only_for_copies check (
    (kind = 'recovery_copy' and stored_path is not null)
    or (kind = 'snapshot' and stored_path is null)
  ),
  constraint version_stored_inside_josi check (
    stored_path is null or stored_path like '/data/versions/%'
  ),
  constraint version_no_traversal check (
    stored_path is null or position('..' in stored_path) = 0
  )
);
create unique index document_versions_ordinal on document_versions (document_id, ordinal);
create index document_versions_owner on document_versions (owner_user_id);
create index document_versions_purge on document_versions (purge_after)
  where purge_after is not null;

-- ---------- cloud sync ----------
-- M76/M77. Per-mapping state so a rate limit is per user's own folder rather
-- than global, and so one person hammering Sync now cannot starve another.
create table sync_state (
  mapping_id uuid primary key references folder_mappings(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  last_sync_at timestamptz,
  last_manual_sync_at timestamptz,
  next_sync_after timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  -- A category, never a provider's error body: provider errors quote requests,
  -- and a request to a documents API contains folder and file names.
  last_error_category text check (last_error_category in (
    'token_expired', 'rate_limited', 'unreachable', 'permission_denied', 'unknown'
  )),
  updated_at timestamptz not null default now()
);
create trigger sync_state_touch before update on sync_state
  for each row execute function touch_updated_at();

-- ---------- audit retention ----------
-- M73: 30d / 90d / 1y / forever, default one year, with a storage warning on
-- "forever". The setting lives in `storage_policy` (0007); this is the record
-- of the sweep, so an administrator can tell the difference between "nothing
-- was deleted" and "the sweep never ran".
create table audit_retention_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  policy text not null,
  events_removed integer not null default 0 check (events_removed >= 0)
);
create index audit_retention_runs_recent on audit_retention_runs (ran_at desc);

alter table document_versions enable row level security;
alter table sync_state enable row level security;

-- ---------- the one thing allowed to delete an event ----------
-- Phase 1 made `events` append-only with a trigger, and that trigger has been
-- doing its job — it refused this phase's retention sweep, which is how the
-- conflict surfaced.
--
-- M73 requires retention to actually delete. The wrong fix is a bypass flag or
-- a privileged role, because either becomes a way to erase an audit trail. The
-- right one is to let the DATABASE decide: a row may be deleted only once it is
-- already older than the configured window. Everything current stays exactly as
-- append-only as it was, and the sweep needs no special powers.
--
-- Under `forever` nothing qualifies, so nothing can be deleted at all.
create or replace function events_no_mutation() returns trigger as $$
declare
  keep_days integer;
begin
  if tg_op = 'DELETE' then
    select case audit_retention
             when '30d' then 30
             when '90d' then 90
             when 'one_year' then 365
             else null
           end
      into keep_days
      from storage_policy where id = true;

    if keep_days is not null and old.created_at < now() - make_interval(days => keep_days) then
      return old;
    end if;

    raise exception 'events is append-only (only entries past the retention window may be removed)';
  end if;
  raise exception 'events is append-only';
end;
$$ language plpgsql;
