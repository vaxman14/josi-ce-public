-- Josi CE 0007: documents and storage, part one — the mapping spine.
--
-- THE RISK THIS PHASE IS SHAPED AROUND
--
-- The plan calls Phase 9 the highest-risk phase, and names why: extraction, OCR
-- and watching all touch untrusted bytes. But the first risk is simpler and
-- worse. A document mapping is a standing grant of read access to a folder that
-- may hold contracts, medical records, or a lawyer's privileged files. Getting
-- the *grant* wrong matters more than getting the parser wrong, because a bad
-- parser crashes and a bad grant quietly works.
--
-- So: deny by default, one folder at a time, read-only until told otherwise,
-- and every derived byte destroyed the moment the grant ends.

-- ---------- approvals grow a third kind of subject ----------
-- Phase 5 keyed approvals on a task. Phase 8 added threads as an alternative,
-- with a two-way XOR and a second partial unique index. Phase 9 needs document
-- deletes (M47) — a third subject — and a three-way XOR with three indexes is
-- a shape that gets worse every time it is extended.
--
-- One polymorphic subject instead. The mechanism is unchanged: the payload hash
-- still pins an approval to exactly one action, still one live request per
-- subject+action. Only the naming of the subject is generalised.
alter table approvals add column subject_type text;
alter table approvals add column subject_id uuid;

update approvals set
  subject_type = case when task_id is not null then 'task' else 'email_thread' end,
  subject_id = coalesce(task_id, thread_id);

alter table approvals drop constraint approvals_one_subject;
drop index approvals_one_pending;
drop index approvals_one_pending_thread;
drop index approvals_task;
drop index approvals_thread;
alter table approvals drop column task_id;
alter table approvals drop column thread_id;

alter table approvals alter column subject_type set not null;
alter table approvals alter column subject_id set not null;
alter table approvals add constraint approvals_subject_known check (
  subject_type in ('task', 'email_thread', 'folder_mapping', 'document')
);
create index approvals_subject on approvals (subject_type, subject_id);
-- One live request per subject+action+payload. A second "shall I?" for the same
-- thing is a bug that trains people to click yes.
create unique index approvals_one_pending
  on approvals (subject_type, subject_id, action, payload_hash)
  where status = 'pending';

-- ---------- what the operator has allowed to exist at all ----------
-- M45: local access is deny-by-default and limited to preapproved folders.
--
-- Two independent gates, and the reason they are independent is the whole
-- control. The bind mount decides what the CONTAINER can see; this table
-- decides what the APPLICATION will touch. A bind mount added by hand, or a
-- volume inherited from another compose file, grants nothing on its own.
--
-- There is deliberately no way to add a root through the API. It is compose
-- plus an explicit super-admin registration, so widening the blast radius takes
-- a deployment change and cannot be done by anyone who merely gets a session.
create table storage_roots (
  id uuid primary key default gen_random_uuid(),
  -- The path INSIDE the container. `registerRoot` requires it to be under the
  -- bind-mount base; the constraints below cover the shape.
  container_path text not null unique,
  -- What this is for, in the operator's words. Shown to users choosing a folder.
  label text not null,
  purpose text not null default '',
  -- M45 again: a root may be declared read-only here regardless of how the bind
  -- mount was made, so an operator who forgets `:ro` still gets read-only.
  writable boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- No traversal in the declaration itself. The rest of the rule — that a root
  -- must sit under the bind-mount base — lives in `registerRoot`, because the
  -- base is deployment configuration and a hardcoded literal here would be a
  -- constraint no test could ever exercise against a real directory.
  constraint storage_root_absolute check (container_path like '/%'),
  constraint storage_root_no_dotdot check (position('..' in container_path) = 0)
);

-- ---------- the capability half of the dual gate ----------
-- M47: mapping is dual-gated — the admin approves the CAPABILITY and the user
-- consents to the specific folder. The admin may tighten, never grant.
--
-- This is the same deny-only shape as the Phase 7 connector capabilities, and
-- for the same reason: an administrator who can grant on a user's behalf is an
-- administrator who can read their files by filling in a form.
create table storage_capabilities (
  user_id uuid primary key references users(id) on delete cascade,
  may_map_local boolean not null default false,
  may_map_cloud boolean not null default false,
  may_index boolean not null default false,
  -- M55: per-user ceilings. Null means "the workspace default applies".
  max_files integer check (max_files is null or max_files >= 0),
  max_bytes bigint check (max_bytes is null or max_bytes >= 0),
  granted_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------- the mapping ----------
-- One folder, one owner. `folder_mapping` was already a resource type in the
-- Phase 1 ownership spine and `OWNED_TABLES` already named this table; this is
-- the table it was waiting for.
create table folder_mappings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('local', 'google_drive', 'onedrive')),

  -- Local mappings: the root they live under, and the path relative to it.
  -- Storing the relative part separately is what makes containment checkable by
  -- the database rather than only by the code that writes it.
  root_id uuid references storage_roots(id) on delete restrict,
  relative_path text not null default '',

  -- Cloud mappings: the provider's own folder id. M46 — a FOLDER, never an
  -- account. There is no "map my whole Drive".
  connection_id uuid references connections(id) on delete cascade,
  remote_folder_id text,
  display_path text not null,

  -- M49/M50: recursion is a property of the grant, and it covers subfolders
  -- created later. The consent text has to say so; this column is what makes
  -- that statement true.
  recursive boolean not null default false,

  -- M47: every mapping starts read-only. The other three are granted
  -- separately and deliberately, and `may_delete` grants the ability to ASK —
  -- a delete still raises an approval every single time.
  may_create boolean not null default false,
  may_edit boolean not null default false,
  may_move boolean not null default false,
  may_delete boolean not null default false,

  -- M49: mapping is not indexing. A folder Josi can open on request is a
  -- different grant from a folder Josi has read in full and kept text from.
  indexing_enabled boolean not null default false,
  indexing_consented_at timestamptz,

  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  -- M78: why it is paused, so the owner can be told something useful.
  paused_reason text check (paused_reason in (
    'token_expired', 'admin_paused', 'global_pause', 'quota_exceeded', 'source_missing'
  )),
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A local mapping needs a root; a cloud mapping needs a connection. Neither
  -- may borrow the other's fields.
  constraint mapping_shape check (
    (provider = 'local'
      and root_id is not null and connection_id is null and remote_folder_id is null)
    or (provider <> 'local'
      and root_id is null and connection_id is not null and remote_folder_id is not null)
  ),
  -- Containment, enforced by the database and not only by the resolver.
  constraint mapping_no_dotdot check (position('..' in relative_path) = 0),
  constraint mapping_no_absolute check (relative_path not like '/%')
);
create index folder_mappings_owner on folder_mappings (owner_user_id, created_at desc);
-- The same person cannot map the same local folder twice, which would double
-- every derived artefact and make purge-on-unmap ambiguous.
create unique index folder_mappings_local_once
  on folder_mappings (owner_user_id, root_id, relative_path)
  where provider = 'local' and status <> 'revoked';
create unique index folder_mappings_cloud_once
  on folder_mappings (owner_user_id, connection_id, remote_folder_id)
  where provider <> 'local' and status <> 'revoked';
create trigger folder_mappings_touch before update on folder_mappings
  for each row execute function touch_updated_at();

-- ---------- what has been seen inside a mapping ----------
-- Rows here are DERIVED DATA. Every one of them is destroyed when the mapping
-- is unmapped or revoked (M54), which is why the foreign key cascades and why
-- the purge test counts rows per artefact type rather than trusting the cascade.
create table documents (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references folder_mappings(id) on delete cascade,
  -- Denormalised from the mapping so that ownership questions never need a
  -- join, and so a purge can be verified per user.
  owner_user_id uuid not null references users(id) on delete cascade,
  -- Relative to the mapping. Never an absolute path, never traversal.
  relative_path text not null,
  filename text not null,
  extension text not null default '',
  byte_size bigint not null default 0 check (byte_size >= 0),
  content_hash text,
  modified_at timestamptz,

  state text not null default 'discovered' check (state in (
    'discovered', 'extracted', 'indexed', 'skipped', 'blocked', 'failed'
  )),
  -- M64/M65/M74: why a file was passed over, so the owner sees a reason per
  -- file instead of a silent gap. Not an error string from a parser — a fixed
  -- vocabulary, because these are shown in a list.
  skip_reason text check (skip_reason in (
    'encrypted', 'password_protected', 'too_large', 'extension_not_allowed',
    'archive_excluded', 'archive_limits_exceeded', 'unreadable', 'malware_found',
    'quota_exceeded', 'unsupported_type'
  )),
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_no_dotdot check (position('..' in relative_path) = 0),
  constraint document_no_absolute check (relative_path not like '/%')
);
create index documents_mapping on documents (mapping_id, state);
create index documents_owner on documents (owner_user_id);
create unique index documents_path_once on documents (mapping_id, relative_path);
create trigger documents_touch before update on documents
  for each row execute function touch_updated_at();

-- ---------- the audit trail ----------
-- M72: metadata only. Not a filename, not a path, not a preview, not a line of
-- extracted text. The `events` table already refuses content through
-- `assertMetadataOnly`; this view of it exists so an administrator can answer
-- "what happened to storage access" without being handed the contents.
--
-- M73: retention is configurable, default one year. Stored in policy below.
create table storage_policy (
  id boolean primary key default true check (id),

  -- M75: the global stop. It halts NEW work; it deletes nothing, and search
  -- over what is already built keeps working.
  processing_paused boolean not null default false,

  -- M55: hardware-aware ceilings. These defaults are deliberately small — the
  -- plan targets Pi-class hardware, and an operator raising a limit is a
  -- decision, while an operator discovering their box is thrashing is an
  -- incident.
  max_file_bytes bigint not null default 26214400 check (max_file_bytes > 0),
  max_total_bytes_per_user bigint not null default 2147483648 check (max_total_bytes_per_user > 0),
  max_files_per_user integer not null default 20000 check (max_files_per_user > 0),
  allowed_extensions text[] not null default array[
    'txt','md','csv','tsv','json','xml','html','htm',
    'pdf','doc','docx','rtf','odt',
    'xls','xlsx','ods','ppt','pptx','odp'
  ],

  -- M65: archives are excluded by default. Every bound below only applies when
  -- an administrator has turned them on.
  archives_enabled boolean not null default false,
  archive_max_entries integer not null default 1000 check (archive_max_entries > 0),
  archive_max_total_bytes bigint not null default 104857600 check (archive_max_total_bytes > 0),
  archive_max_depth integer not null default 1 check (archive_max_depth between 1 and 3),
  archive_max_seconds integer not null default 30 check (archive_max_seconds > 0),

  -- M52/M53: OCR is bundled but off, super-admin only, and throttled.
  ocr_enabled boolean not null default false,
  ocr_max_concurrency integer not null default 1 check (ocr_max_concurrency between 1 and 8),
  ocr_hours_start integer check (ocr_hours_start between 0 and 23),
  ocr_hours_end integer check (ocr_hours_end between 0 and 23),

  -- M51: full-text search always; semantic is opt-in and carries a disclosure
  -- that text leaves the server. Local-only mode forbids it outright — enforced
  -- in code against the Phase 4 provider mode, not merely by this flag.
  semantic_enabled boolean not null default false,

  -- M56–M59: ClamAV. Off unless the operator deploys the container.
  clamav_enabled boolean not null default false,
  clamav_scan_mode text not null default 'on_index' check (clamav_scan_mode in ('on_index', 'on_change')),
  clamav_auto_update boolean not null default false,

  -- M60–M62: version history.
  history_mode text not null default 'disabled' check (history_mode in ('disabled', 'one', 'two')),
  history_kind text not null default 'snapshot' check (history_kind in ('snapshot', 'recovery_copy')),
  -- M79: how long a recovery copy survives its source being deleted.
  recycle_bin_days integer not null default 30 check (recycle_bin_days in (7, 30, 90)),

  -- M69: sharing controls. The admin may switch sharing off entirely, and may
  -- separately forbid workspace-wide shares while allowing person-to-person.
  sharing_enabled boolean not null default true,
  workspace_sharing_enabled boolean not null default true,

  -- M76/M77: sync cadence and whether people may press the button.
  cloud_sync_minutes integer not null default 15 check (cloud_sync_minutes in (5, 15, 30, 60)),
  manual_sync_enabled boolean not null default true,

  -- M73.
  audit_retention text not null default 'one_year'
    check (audit_retention in ('30d', '90d', 'one_year', 'forever')),

  updated_at timestamptz not null default now(),
  -- M53: an hour restriction is either fully set or not set at all. A half-set
  -- window is the kind of thing that runs OCR at 3am on a Pi forever.
  constraint ocr_hours_paired check (
    (ocr_hours_start is null and ocr_hours_end is null)
    or (ocr_hours_start is not null and ocr_hours_end is not null)
  )
);
insert into storage_policy (id) values (true);
create trigger storage_policy_touch before update on storage_policy
  for each row execute function touch_updated_at();

alter table storage_roots enable row level security;
alter table storage_capabilities enable row level security;
alter table folder_mappings enable row level security;
alter table documents enable row level security;
