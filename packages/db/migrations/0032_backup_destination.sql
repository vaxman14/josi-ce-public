-- Where backups go, configured by a person rather than by the host.
--
-- Before this, sending a backup anywhere but the container's own volume meant
-- editing compose files and mounting host secret files named by a prefix the
-- UI called `primary` and never explained. That is not a setting; it is a
-- deployment procedure, and it put the one thing that saves an installation
-- behind the one skill most of its operators do not have.
--
-- The credential lives here, sealed with the installation master key, exactly
-- as every other stored credential does. Two consequences are deliberate:
--
--   * A stolen database is not a stolen bucket. `credentials_enc` is opaque
--     without the key, and the key is in no backup by construction.
--   * There is no `secret_prefix` column and no name of a host file. The
--     application holds its own credential or it has none.
--
-- Single row, like deployment_config: an installation stores its backups in one
-- place. A second destination is a different feature (rotation, tiering) and
-- would be a different table rather than a second row nobody chose between.
create table backup_destination (
  id boolean primary key default true check (id),

  -- 's3', 'r2' or 'b2'. All three speak the S3 API and are signed with SigV4;
  -- what differs is how the endpoint is derived and what the fields are called
  -- in the vendor's own console, which is a presentation concern rather than a
  -- protocol one.
  kind text not null check (kind in ('s3', 'r2', 'b2')),

  -- What the operator called it. Shown instead of the bucket in passing
  -- mentions, so a screenshot of the backups page does not disclose a bucket
  -- name to whoever is looking over their shoulder.
  label text not null default '',

  bucket text not null check (length(bucket) > 0),

  -- AWS needs a real region. R2 has none and is always signed as `auto`. B2's
  -- region is part of its endpoint host. Stored for all three because it is
  -- what the signature is computed over.
  region text not null check (length(region) > 0),

  -- Cloudflare's account id. Only R2 uses it, and only to derive the endpoint.
  account_id text,

  -- Set ONLY when the operator is pointing at an S3-compatible endpoint that
  -- Josi cannot derive — MinIO, Ceph, a private gateway. Null for AWS, R2 and
  -- B2, whose hosts follow from the fields above. Derived rather than typed is
  -- the safer default: a mistyped endpoint is an exfiltration target.
  endpoint text,

  -- An optional key prefix INSIDE the bucket, so an installation can share a
  -- bucket with something else. This is object naming and nothing to do with
  -- the removed secret-file prefix; it is never part of a credential.
  object_prefix text not null default '',

  -- The sealed envelope: access key id, secret access key, and for temporary
  -- credentials a session token. One envelope rather than a column each, so a
  -- widening `select *` cannot start serving half a credential.
  credentials_enc text,

  -- What the last connection test actually established, recorded rather than
  -- assumed. A destination that has never been tested is not claimed to work.
  last_check_at timestamptz,
  last_check_ok boolean,
  last_check_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- R2 is the only kind that needs an account id, and it cannot work without
-- one. Enforced here so a row that could never be signed cannot be stored.
alter table backup_destination add constraint backup_destination_r2_account
  check (kind <> 'r2' or (account_id is not null and length(account_id) > 0));
