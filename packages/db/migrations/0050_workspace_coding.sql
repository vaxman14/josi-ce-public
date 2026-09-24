-- Opt-in only. Existing installations receive no execution capability.
alter table storage_capabilities add column coding_enabled boolean not null default false;
create table workspace_coding_runs (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references users(id) on delete cascade,
 mapping_id uuid not null references folder_mappings(id) on delete cascade,
 approval_id uuid references approvals(id),
 mode text not null check(mode in ('check','run')),
 source text not null check(octet_length(source)<=262144),
 status text not null default 'pending' check(status in ('pending','running','completed','failed','cancelled')),
 result jsonb not null default '{}',
 created_at timestamptz not null default now(),
 finished_at timestamptz
);
create index workspace_coding_owner on workspace_coding_runs(owner_user_id,created_at desc);
create table workspace_write_leases (
 owner_user_id uuid primary key references users(id) on delete cascade,
 token uuid not null,
 expires_at timestamptz not null
);
