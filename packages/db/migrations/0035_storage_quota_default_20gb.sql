-- Josi CE 0035: raise the workspace storage-quota default from 2GiB to 20GiB.
--
-- 0007 set `max_total_bytes_per_user` to 2147483648 (2GiB) as a conservative,
-- Pi-class-hardware placeholder. Real multi-provider use (item 40h) showed it
-- is far too small for ordinary multi-provider use, causing files after the
-- first couple of gigabytes to be skipped with `quota_exceeded`. The revised
-- policy is 20GiB by default, adjustable per person by an administrator (this
-- change also ships that per-user override path — see
-- storage_capabilities.max_bytes, already present since 0007, now actually
-- exposed and enforced as a real override rather than only a tighter ceiling).
--
-- Two separate things change here, and only one of them touches data:
--
--   1. The COLUMN DEFAULT changes, so any *future* row (there is only ever one,
--      `id = true`, but the schema doesn't forbid recreating it) starts at
--      20GiB rather than 2GiB.
--   2. The EXISTING row is updated to 20GiB *only if it is still sitting at the
--      exact literal old default*. There is no UI path that lets an
--      administrator edit the global `storage_policy.max_total_bytes_per_user`
--      value today (grep confirms no route writes it) — the only way this
--      value could differ from the 0007 default is a manual database edit. A
--      row that has already been manually changed away from 2147483648 is
--      left completely alone: it is somebody's deliberate customization, and
--      this migration's job is to move the DEFAULT forward, not to overwrite
--      a decision a person already made.
--
-- storage_capabilities.max_bytes (the PER-USER override) is never touched by
-- this migration, for the same reason: any row already carrying a value there
-- was set by an administrator through the existing PUT
-- /storage/admin/capabilities/:userId route, and is a deliberate per-person
-- decision this migration must not second-guess.

alter table storage_policy
  alter column max_total_bytes_per_user set default 21474836480;

update storage_policy
set max_total_bytes_per_user = 21474836480
where id = true
  and max_total_bytes_per_user = 2147483648;
