-- Storage readiness and content-analysis availability are separate facts.
-- storage_path is retained for schema compatibility but now contains only the
-- opaque server id; filesystem paths and URLs are never persisted.
alter table chat_attachments add column analysis_status text not null default 'available'
  check (analysis_status in ('available','unavailable'));
alter table chat_attachments add column analysis_code text;
update chat_attachments set storage_path=id::text;
alter table chat_attachments drop constraint chat_attachments_byte_size_check;
alter table chat_attachments add constraint chat_attachments_byte_size_check
  check (byte_size >= 0 and byte_size <= 104857600);
