alter table backups add column progress_percent integer not null default 0
  check (progress_percent between 0 and 100);
alter table backups add column progress_phase text not null default 'queued';
alter table backups add column progress_step integer not null default 0 check (progress_step >= 0);
alter table backups add column progress_steps integer not null default 5 check (progress_steps > 0);

alter table backup_destination add column share_protocol text
  check (share_protocol in ('smb', 'nfs'));
alter table backup_destination add column share_host text;
alter table backup_destination add column share_name text;
alter table backup_destination add column encryption_enabled boolean not null default true;
alter table backup_destination add column encryption_key_ref text;
alter table backup_destination add column encryption_key_confirmed_at timestamptz;

alter table backup_destination add constraint backup_destination_nas_details check (
  kind <> 'nas' or (
    share_protocol is not null and length(share_host) > 0 and length(share_name) > 0
  )
);
