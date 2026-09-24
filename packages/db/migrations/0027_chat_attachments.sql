create table chat_attachments (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  filename text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0 and byte_size <= 20971520),
  storage_path text not null,
  extracted_text text,
  created_at timestamptz not null default now()
);
create index chat_attachments_thread on chat_attachments(thread_id, created_at);
alter table chat_attachments enable row level security;
