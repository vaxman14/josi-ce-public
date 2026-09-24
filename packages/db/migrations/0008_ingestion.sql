-- Josi CE 0008: documents and storage, part two — untrusted bytes.
--
-- Everything 0007 governed was a GRANT. Everything here is a FILE, and the
-- plan's risk note is about exactly this half: "extraction, OCR and watching all
-- touch untrusted bytes."
--
-- The shape of the defence is that a file is guilty until checked. A document
-- arrives as `discovered` and only becomes `extracted` by passing every gate in
-- turn — size, extension, encryption, archive bounds, malware. Any gate can end
-- it, and every ending is recorded with a reason the owner can read (M74).

-- ---------- what a scan found ----------
-- M57 is unusually specific and worth restating: a finding BLOCKS processing and
-- alerts the owner and the administrator, and Josi must not move, quarantine,
-- modify or delete the source. That is not timidity. Antivirus false positives
-- on ordinary business documents are common, and a system that deletes or
-- relocates a customer's file on a false positive has destroyed data it was
-- trusted with. Blocking is reversible; deleting is not.
--
-- So there is no quarantine path, no move, no rewrite. There is a row here and
-- a state change on the document.
create table malware_findings (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- The scanner's name for it. This is metadata, not content: a signature name
  -- describes the malware, not the file's subject matter.
  signature text not null,
  scanner text not null default 'clamav',
  -- Proof the source was untouched, taken before and after the scan.
  source_hash_before text,
  source_hash_after text,
  found_at timestamptz not null default now(),
  -- M57: both parties are told.
  owner_notified_at timestamptz,
  admin_notified_at timestamptz
);
create index malware_findings_document on malware_findings (document_id);
create index malware_findings_recent on malware_findings (found_at desc);

-- ---------- the scanner's own health ----------
-- M58: automatic definition updates are a super-admin setting, not forced, and
-- the UI must show enabled state, installed version, last success and failures.
-- Out-of-date definitions are the failure mode that looks exactly like working.
create table clamav_status (
  id boolean primary key default true check (id),
  reachable boolean not null default false,
  definition_version text,
  definitions_updated_at timestamptz,
  last_check_at timestamptz,
  last_success_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error_category text check (last_error_category in (
    'unreachable', 'timeout', 'update_failed', 'out_of_date', 'unknown'
  )),
  updated_at timestamptz not null default now()
);
insert into clamav_status (id) values (true);
create trigger clamav_status_touch before update on clamav_status
  for each row execute function touch_updated_at();

-- ---------- extraction ----------
-- The text pulled out of a document. This is DERIVED DATA in the strongest
-- sense — it is the file's contents, in the database, searchable.
--
-- It is a separate table from `documents` rather than a column on it for one
-- reason: purge. M54 requires that revoking indexing destroys extracted text
-- while the mapping and its file list may survive, and a separate table makes
-- "delete the text but keep the record" a delete rather than an update that
-- somebody might write as a no-op.
create table document_text (
  document_id uuid primary key references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  content text not null,
  -- Where it came from, so a citation can be precise (M67).
  locator_kind text not null default 'none' check (locator_kind in (
    'none', 'page', 'sheet', 'slide', 'heading', 'line'
  )),
  char_count integer not null default 0 check (char_count >= 0),
  -- M52: whether OCR produced this, so the owner knows the text was guessed
  -- from an image rather than read from the file.
  from_ocr boolean not null default false,
  extracted_at timestamptz not null default now()
);

-- Individual locatable pieces, so a citation can say "page 4" rather than
-- "somewhere in this file" (M67).
create table document_segments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  locator_kind text not null default 'none' check (locator_kind in (
    'none', 'page', 'sheet', 'slide', 'heading', 'line'
  )),
  -- "4", "Sheet1!B12", "Introduction". Free text because the vocabulary differs
  -- per format and a citation is shown, not parsed.
  locator text not null default '',
  content text not null,
  from_ocr boolean not null default false
);
create index document_segments_doc on document_segments (document_id, ordinal);

-- ---------- archives ----------
-- M65: excluded by default; bounded when enabled. A record per extraction so
-- the bounds can be shown to have been applied rather than merely configured.
create table archive_extractions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  entries_seen integer not null default 0,
  entries_extracted integer not null default 0,
  bytes_expanded bigint not null default 0,
  max_depth_reached integer not null default 0,
  -- Why it stopped, when it stopped early. A zip bomb is a `limit` outcome, not
  -- an error: the bounds worked.
  stopped_reason text check (stopped_reason in (
    'complete', 'entry_limit', 'size_limit', 'depth_limit', 'time_limit',
    'encrypted_entry', 'unsafe_path', 'unreadable'
  )),
  extracted_at timestamptz not null default now()
);
create index archive_extractions_doc on archive_extractions (document_id);

-- ---------- the queue ----------
-- M53: a throttled background queue, with concurrency and hour restrictions the
-- administrator controls. M75: a global pause stops new work without deleting
-- anything already built.
create table processing_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('extract', 'ocr', 'scan', 'index')),
  state text not null default 'queued' check (state in (
    'queued', 'running', 'done', 'failed', 'skipped'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  -- A category, never a parser's error string: a parser that fails on a
  -- document often quotes the document.
  error_category text check (error_category in (
    'unreadable', 'encrypted', 'too_large', 'timeout', 'malware_found',
    'out_of_hours', 'paused', 'quota_exceeded', 'unknown'
  )),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index processing_jobs_pending on processing_jobs (state, queued_at)
  where state in ('queued', 'running');
create index processing_jobs_document on processing_jobs (document_id);
-- One live job of each kind per document. Without this a rescan queues a second
-- extraction while the first is still running, and on Pi-class hardware that is
-- how a queue becomes a thrash.
create unique index processing_jobs_one_live
  on processing_jobs (document_id, kind)
  where state in ('queued', 'running');

alter table malware_findings enable row level security;
alter table document_text enable row level security;
alter table document_segments enable row level security;
alter table archive_extractions enable row level security;
alter table processing_jobs enable row level security;
