-- The administrator's launch checklist.
--
-- Setup ends and the person who ran it lands on the ordinary user dashboard,
-- which is the same thing every member sees. Everything they still have to do
-- to run this installation — invite people, verify the master-key backup, set
-- the approval ceiling, take a first backup, look at the items setup skipped —
-- is invisible unless they go hunting for it. So they do not do it.
--
-- Two pieces of state, and only two: whether the checklist has been seen at
-- all, and which optional items have been deliberately put aside. Everything
-- else on the checklist is DERIVED from what the installation actually
-- contains, so an item cannot be ticked by anything other than the work being
-- done.

create table if not exists admin_checklist_state (
  id boolean primary key default true check (id),
  -- Until this is set, sign-in routes the super admin here rather than to the
  -- dashboard. Set the first time they actually look at it.
  seen_at timestamptz,
  -- Backing up the master key is the one thing nobody else can do for them and
  -- the one thing that cannot be recovered from. It is not derivable — the
  -- file is copied off the server, where Josi cannot see it — so it is the one
  -- item that is a confirmation rather than a measurement.
  master_key_backup_confirmed_at timestamptz,
  master_key_backup_confirmed_by uuid references users(id) on delete set null
);

insert into admin_checklist_state (id) values (true) on conflict (id) do nothing;

-- Optional work an administrator has decided against. Recorded per item, with
-- who and when, so "I dismissed that" is answerable later.
--
-- Items whose severity is `critical` are refused here by the application: a
-- dismissal that silences a material risk is how the risk stops being visible
-- without ever being addressed.
create table if not exists admin_checklist_dismissals (
  item text primary key,
  dismissed_at timestamptz not null default now(),
  dismissed_by uuid references users(id) on delete set null
);
