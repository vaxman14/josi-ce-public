-- Josi CE 0006: operational email.
--
-- THE FAILURE THIS SCHEMA IS SHAPED TO PREVENT
--
-- The phase plan names it: "an unowned shared inbox forming". Josi sends on
-- behalf of a person, through one central mailbox. If a reply comes back and
-- nobody owns it, that mailbox becomes a pile of correspondence belonging to
-- everyone and therefore to no one — and the first person to open the admin
-- screen is reading their colleagues' mail.
--
-- So every thread has an `owner_user_id` that is never null, and every inbound
-- message either resolves to one through an unguessable routing token or lands
-- in quarantine. There is deliberately no third outcome and no "unassigned"
-- state to drift into.

-- ---------- threads ----------
-- Private to the person who started them (M37). `email_thread` was already a
-- resource type in the Phase 1 ownership spine; this is the table it names.
create table email_threads (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  subject text not null,
  -- What makes a reply come back to THIS thread and THIS person. It travels in
  -- the Reply-To address and nowhere else, so it is random rather than derived:
  -- anything guessable would let a stranger inject into someone's conversation.
  routing_token text not null unique,
  status text not null default 'open' check (status in ('open', 'closed')),
  -- M40: deleting puts a thread in recoverable trash, it does not destroy it.
  deleted_at timestamptz,
  purge_after timestamptz,
  last_activity_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index email_threads_owner on email_threads (owner_user_id, last_activity_at desc);
create index email_threads_purge on email_threads (purge_after) where deleted_at is not null;

-- Who is on the thread, and how much of it they can see.
--
-- `history_from` is M43 made concrete: a recipient added later sees the thread
-- from the moment they were added, unless the initiator explicitly agreed to
-- expose more. The approval screen shows exactly which messages that covers.
create table email_participants (
  thread_id uuid not null references email_threads(id) on delete cascade,
  address text not null,
  role text not null default 'to' check (role in ('to', 'cc')),
  history_from timestamptz not null default now(),
  added_at timestamptz not null default now(),
  added_by uuid references users(id) on delete set null,
  primary key (thread_id, address)
);

-- ---------- messages ----------
create table email_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references email_threads(id) on delete cascade,
  direction text not null check (direction in ('out', 'in')),
  from_address text not null,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text not null,
  body_text text not null,
  -- RFC 5322 identifiers, used for threading and for loop detection.
  message_id text,
  in_reply_to text,
  -- Exactly-once: the same content, to the same people, on the same thread, is
  -- one send however many times it is asked for.
  content_hash text,
  created_at timestamptz not null default now()
);
create index email_messages_thread on email_messages (thread_id, created_at);
create unique index email_messages_once
  on email_messages (thread_id, content_hash)
  where direction = 'out' and content_hash is not null;

-- Attachment METADATA. The bytes are not stored here: in 0.1 there is nowhere
-- for an attachment to come from — mapped folders are Phase 9 — and this table
-- exists so the approval preview (M44) can name the exact file before Phase 9
-- can supply one.
create table email_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references email_messages(id) on delete cascade,
  filename text not null,
  content_type text not null,
  byte_size integer not null check (byte_size >= 0),
  sha256 text not null
);

-- ---------- delivery ----------
-- What the administrator is allowed to see (M38): who sent it, to which
-- address, when, what happened, and a sanitised category. There is deliberately
-- no subject column and no body column in this table — the metadata view reads
-- from here, so it cannot leak content by someone widening a SELECT.
create table email_sends (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references email_messages(id) on delete cascade,
  -- Denormalised on purpose, for the same reason: the admin view never needs to
  -- join to a table that has bodies in it.
  initiating_user_id uuid references users(id) on delete set null,
  recipient text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed')),
  attempts integer not null default 0,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  -- A category, never the SMTP server's response text: bounce messages quote
  -- the message that bounced.
  error_category text check (error_category in (
    'auth', 'connection', 'rejected_recipient', 'rejected_content', 'rate_limited', 'unknown'
  )),
  idempotency_key text not null unique
);
create index email_sends_admin on email_sends (queued_at desc);

-- ---------- inbound ----------
-- Anything that could not be resolved to an owner. Headers only: the body of an
-- unrouted message belongs to nobody, so storing it would create exactly the
-- unowned pile this schema exists to prevent.
create table email_quarantine (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  from_address text,
  to_address text,
  reason text not null check (reason in (
    'no_routing_token', 'unknown_token', 'thread_deleted', 'loop_suspected', 'inbound_disabled'
  )),
  -- Enough to diagnose, not enough to read.
  message_id text,
  subject_length integer,
  body_length integer
);
create index email_quarantine_recent on email_quarantine (received_at desc);

-- ---------- policy ----------
create table mail_policy (
  id boolean primary key default true check (id),
  -- M39. Null = threads are kept until their owner deletes them.
  retention_days integer check (retention_days is null or retention_days > 0),
  -- M40. 0 = deleting is immediate.
  trash_days integer not null default 30 check (trash_days >= 0),
  -- M41. Customisable wording; `not null` and a length check are what make it
  -- non-removable. `{user}` is substituted with the initiating person's name.
  disclosure text not null default 'Sent by Josi, an AI assistant, on behalf of {user}.',
  -- M36. Governs whether inbound processing is AVAILABLE. It is not permission
  -- for anyone to read anybody's mail, and no admin route reads a thread.
  inbound_enabled boolean not null default false,
  -- M42. Operational mail reaches the people in a conversation; it does not
  -- reach a list. A low ceiling is the difference.
  max_recipients integer not null default 10 check (max_recipients between 1 and 50),
  updated_at timestamptz not null default now(),
  -- The disclosure cannot be emptied or reduced to whitespace. Enforced here as
  -- well as in code, because a policy row is editable by anything with database
  -- access and this is the one that must not be removable.
  constraint mail_disclosure_present check (length(btrim(disclosure)) >= 10)
);
insert into mail_policy (id) values (true);
create trigger mail_policy_touch before update on mail_policy
  for each row execute function touch_updated_at();

-- ---------- approvals for mail ----------
-- Phase 5 built the approval mechanism: a pinned payload hash, one live request
-- per action, decided only by the person it is for. Mail needs exactly that for
-- M43 and M44, so this widens the existing table rather than growing a second
-- mechanism with its own subtly different rules.
alter table approvals alter column task_id drop not null;
alter table approvals add column thread_id uuid references email_threads(id) on delete cascade;
alter table approvals add constraint approvals_one_subject check (
  (task_id is not null and thread_id is null)
  or (task_id is null and thread_id is not null)
);
create index approvals_thread on approvals (thread_id);
-- The Phase 5 uniqueness index keyed on task_id, which is now nullable and
-- therefore no longer covers mail. A second index does the same job for threads.
create unique index approvals_one_pending_thread
  on approvals (thread_id, action, payload_hash)
  where status = 'pending' and thread_id is not null;

alter table email_threads enable row level security;
alter table email_participants enable row level security;
alter table email_messages enable row level security;
alter table email_attachments enable row level security;
alter table email_sends enable row level security;
alter table email_quarantine enable row level security;
