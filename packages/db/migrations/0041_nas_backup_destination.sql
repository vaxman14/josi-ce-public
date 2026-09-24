alter table backup_destination drop constraint if exists backup_destination_kind_check;
alter table backup_destination add constraint backup_destination_kind_check
  check (kind in ('s3', 'r2', 'b2', 'nas'));
