-- Contact synchronisation with Google and Microsoft.
--
-- Four tables and some columns, and the shape of each is an answer to a way
-- this goes wrong.
--
--   contact_sync_origins   ONE connected account, syncing one way or two. The
--                          delta cursor lives here, because a cursor is a fact
--                          about a conversation with one provider account and
--                          not about a contact.
--   contact_links          which local contact IS which remote record. Keyed by
--                          the provider's own stable id, so a rename is not a
--                          new person.
--   contact_tombstones     what was deleted, and where. Without this a delete
--                          is undone by the next full resync, which is the
--                          single most common contact-sync bug there is.
--   contact_merge_decisions  "these two are NOT the same person". Without it a
--                          rejected merge is re-proposed on every sync and
--                          people learn to click through the dialog.

-- ---------- provenance on the contact itself ----------
--
-- LB8.7: source account, provider, sync mode, last sync, status and conflict
-- state have to be visible ON a contact. A synced contact that looks
-- identical to one somebody typed is a contact nobody can reason about when
-- it changes on its own.
alter table contacts add column if not exists emails jsonb not null default '[]';
alter table contacts add column if not exists phones jsonb not null default '[]';
-- 'josi' for one somebody typed here. Never null: "unknown origin" and "typed
-- here" are different facts and only one of them is true.
alter table contacts add column if not exists source text not null default 'josi'
  check (source in ('josi', 'google', 'microsoft', 'device'));
alter table contacts add column if not exists source_account text;
alter table contacts add column if not exists conflict_state text
  check (conflict_state is null or conflict_state in ('none', 'both_changed'));
-- What the remote looked like when we last agreed with it. A conflict is
-- "both sides moved since this", and without it every remote change looks
-- like a conflict.
alter table contacts add column if not exists synced_at timestamptz;

create index if not exists contacts_source on contacts (owner_user_id, source);

-- ---------- one connected account, syncing ----------
create table if not exists contact_sync_origins (
  id uuid primary key default gen_random_uuid(),
  -- Deleting the connection deletes the origin. It does NOT delete contacts:
  -- see the note on the tombstone table. Disconnecting a source is not consent
  -- to lose what it brought.
  connection_id uuid not null references connections(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  -- Which account, denormalised from the connection so a contact can show it
  -- without a join and so it survives for display after a disconnect.
  source_account text not null,

  -- LB8.2. `import_only` is the default and the only mode offered at first
  -- connect; `two_way` requires the write scope AND a fresh consent.
  sync_mode text not null default 'import_only' check (sync_mode in ('import_only', 'two_way')),

  -- The provider's own incremental cursor. Google calls it a syncToken,
  -- Microsoft a deltaLink. Null means the next run is a full read.
  delta_cursor text,
  -- A page cursor held between pages of ONE run. A run that dies halfway
  -- resumes rather than starting again, and the delta cursor is not advanced
  -- until the last page, so a crash cannot skip records.
  page_cursor text,

  status text not null default 'idle'
    check (status in ('idle', 'syncing', 'error', 'paused', 'disconnected')),
  -- The connector error category, when the last run failed.
  last_error_category text,
  last_sync_at timestamptz,
  last_sync_counts jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One origin per connection. Two would race each other over the same cursor.
create unique index if not exists contact_sync_origins_one_per_connection
  on contact_sync_origins (connection_id);
create index if not exists contact_sync_origins_owner
  on contact_sync_origins (owner_user_id);
create or replace trigger contact_sync_origins_touch before update on contact_sync_origins
  for each row execute function touch_updated_at();

-- ---------- which local contact is which remote record ----------
create table if not exists contact_links (
  id uuid primary key default gen_random_uuid(),
  origin_id uuid not null references contact_sync_origins(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- `resourceName` on Google People, `id` on Microsoft Graph. The provider's,
  -- never ours, and stable across a rename.
  source_id text not null,
  -- Google's etag / Microsoft's @odata.etag. Sent back on a write so the
  -- provider itself refuses a lost update.
  remote_etag text,
  remote_updated_at timestamptz,
  -- A hash of the remote record as we last saw it. Comparing hashes is how
  -- "the remote changed" is answered without storing a second copy of
  -- somebody's contact list.
  remote_fingerprint text,
  -- And of the local record at the same moment. Both are needed: a conflict is
  -- BOTH having moved, and one fingerprint cannot tell you which side did.
  local_fingerprint text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One link per remote record per origin, and one per contact per origin. A
-- contact may be linked to a Google account AND a Microsoft one; it may not be
-- linked twice to the same account.
create unique index if not exists contact_links_remote
  on contact_links (origin_id, source_id);
create unique index if not exists contact_links_local
  on contact_links (origin_id, contact_id);
create index if not exists contact_links_contact on contact_links (contact_id);
create or replace trigger contact_links_touch before update on contact_links
  for each row execute function touch_updated_at();

-- ---------- deletion safety ----------
--
-- The bug this prevents: a contact is deleted at the provider, the delete is
-- applied here, and the NEXT full resync — after a cursor expiry, which
-- providers do routinely — has no memory of it and creates it again. The user
-- deletes it a second time and starts to distrust the product.
--
-- It also records deletions in the other direction, so a contact deleted in
-- Josi is not re-imported.
create table if not exists contact_tombstones (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  -- Nullable: the origin may be gone by the time the tombstone is consulted,
  -- and a tombstone that disappears with its origin is a tombstone that fails
  -- exactly when a reconnect makes it matter.
  origin_id uuid references contact_sync_origins(id) on delete set null,
  provider text not null check (provider in ('google', 'microsoft', 'device', 'josi')),
  source_account text,
  source_id text not null,
  -- Where the deletion happened, which decides whether it propagates.
  deleted_side text not null check (deleted_side in ('remote', 'local')),
  deleted_at timestamptz not null default now()
);
create unique index if not exists contact_tombstones_unique
  on contact_tombstones (owner_user_id, provider, coalesce(source_account, ''), source_id);
create index if not exists contact_tombstones_owner on contact_tombstones (owner_user_id);

-- ---------- "these two are not the same person" ----------
--
-- A rejected merge has to be remembered or it is re-proposed forever. Stored
-- as an unordered pair so the suggestion cannot come back with the two sides
-- swapped.
create table if not exists contact_merge_decisions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  contact_a uuid not null references contacts(id) on delete cascade,
  contact_b uuid not null references contacts(id) on delete cascade,
  decision text not null check (decision in ('keep_separate', 'merged')),
  decided_at timestamptz not null default now(),
  -- Enforced by the application, which orders the pair before writing.
  constraint contact_merge_decisions_ordered check (contact_a < contact_b)
);
create unique index if not exists contact_merge_decisions_pair
  on contact_merge_decisions (contact_a, contact_b);
create index if not exists contact_merge_decisions_owner
  on contact_merge_decisions (owner_user_id);
