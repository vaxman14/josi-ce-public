-- Cloud storage sync on a schedule.
--
-- Item 14 of Roman's second test round: Google Drive and OneDrive stop being a
-- "planned" placeholder. The tables were already here — folder_mappings has
-- carried google_drive/onedrive since 0007, sync_state since 0010 — what was
-- missing was anything that ever ran. This is the fan-out schedule, the same
-- shape as 0021's contact sync for the same reasons:
--
--   * Pacing is PER MAPPING, held in sync_state.next_sync_after and stamped
--     BEFORE a run so a crash costs one turn, not a crash loop.
--   * The schedule FANS OUT: it enqueues one job per due mapping and syncs
--     nothing itself, so one rate-limited account delays only its own folder.
--
-- The interval between fan-out checks is two minutes; how often each folder
-- actually syncs is storage_policy.cloud_sync_minutes (M76), which the
-- administrator already controls.
--
-- `now() + interval`, not `now()`: a schedule due the instant the migration
-- lands fires on the first worker tick of a brand-new installation, which
-- changes job counts in unrelated tests (0021 learned this the hard way).
insert into schedules (kind, payload, interval_seconds, next_run_at, enabled)
select 'storage.sync_due', '{}'::jsonb, 120, now() + make_interval(secs => 120), true
where not exists (select 1 from schedules where kind = 'storage.sync_due');
