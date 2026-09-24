-- Quota reservations and content publication are separate: an upload is not
-- readable until its bytes have reached the persistent volume. Row updates in
-- triggers serialize quota decisions across API processes without session locks.
alter table chat_attachments add column storage_state text not null default 'ready'
  check (storage_state in ('pending','ready'));
alter table chat_attachments add column referenced_at timestamptz;
update chat_attachments a set referenced_at=a.created_at where exists (
  select 1 from messages m where m.thread_id=a.thread_id
  and m.meta->'attachments' @> jsonb_build_array(jsonb_build_object('id',a.id::text)));
create table chat_attachment_usage (
  scope text primary key,
  bytes bigint not null default 0 check(bytes>=0),
  files bigint not null default 0 check(files>=0)
);
alter table chat_attachment_usage enable row level security;
insert into chat_attachment_usage select 'tenant',coalesce(sum(byte_size),0),count(*) from chat_attachments;
insert into chat_attachment_usage select 'user:'||owner_user_id,sum(byte_size),count(*) from chat_attachments group by owner_user_id;
insert into chat_attachment_usage select 'thread:'||thread_id,sum(byte_size),count(*) from chat_attachments group by thread_id;
create function chat_attachment_quota() returns trigger language plpgsql as $$
begin
  if TG_OP='INSERT' then
    -- Global row first provides one stable lock ordering, including deletion.
    update chat_attachment_usage set bytes=bytes+NEW.byte_size,files=files+1
      where scope='tenant' and bytes+NEW.byte_size<=2147483648 and files<10000;
    if not found then raise exception 'attachment_tenant_quota'; end if;
    insert into chat_attachment_usage(scope) values('user:'||NEW.owner_user_id),('thread:'||NEW.thread_id) on conflict do nothing;
    update chat_attachment_usage set bytes=bytes+NEW.byte_size,files=files+1
      where scope='user:'||NEW.owner_user_id and bytes+NEW.byte_size<=209715200 and files<1000;
    if not found then raise exception 'attachment_user_quota'; end if;
    update chat_attachment_usage set bytes=bytes+NEW.byte_size,files=files+1
      where scope='thread:'||NEW.thread_id and files<100;
    if not found then raise exception 'attachment_thread_quota'; end if;
    return NEW;
  else
    update chat_attachment_usage set bytes=bytes-OLD.byte_size,files=files-1 where scope='tenant';
    update chat_attachment_usage set bytes=bytes-OLD.byte_size,files=files-1 where scope='user:'||OLD.owner_user_id;
    update chat_attachment_usage set bytes=bytes-OLD.byte_size,files=files-1 where scope='thread:'||OLD.thread_id;
    return OLD;
  end if;
end $$;
create trigger chat_attachment_quota_insert before insert on chat_attachments for each row execute function chat_attachment_quota();
create trigger chat_attachment_quota_delete after delete on chat_attachments for each row execute function chat_attachment_quota();
create index chat_attachments_expiry on chat_attachments(created_at) where referenced_at is null;
