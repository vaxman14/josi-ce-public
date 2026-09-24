-- Rich document extraction and credential-file containment.
alter table documents drop constraint if exists documents_skip_reason_check;
alter table documents add constraint documents_skip_reason_check check (skip_reason in (
  'encrypted', 'password_protected', 'too_large', 'extension_not_allowed',
  'archive_excluded', 'archive_limits_exceeded', 'unreadable', 'malware_found',
  'quota_exceeded', 'unsupported_type', 'credential_detected'
));

update storage_policy
set allowed_extensions = array(
  select distinct x from unnest(allowed_extensions || array['png','jpg','jpeg','webp','bmp','tif','tiff']) x
)
where id = true;
