-- Private reusable structured email templates. Ownership is always required in application queries.
create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists email_templates_owner_name on email_templates(owner_user_id,name);
alter table email_templates enable row level security;
