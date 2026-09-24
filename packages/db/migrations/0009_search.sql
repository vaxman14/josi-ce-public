-- Josi CE 0009: documents and storage, part three — search.
--
-- M51: PostgreSQL full-text search by DEFAULT, semantic optional, and external
-- embeddings forbidden in Local-only mode.
--
-- The default matters more than it looks. Full-text search runs entirely inside
-- the database: no model, no network, no bytes leaving the host. Semantic search
-- is better at some questions and requires sending the text of somebody's
-- documents to an embedding service. Making FTS the default and semantic an
-- explicit, disclosed opt-in is the difference between a product that leaks by
-- default and one that does not.

-- The searchable form of a document's text.
--
-- A generated column rather than a trigger: a trigger can be dropped, and an
-- out-of-date index that still returns results is worse than no index, because
-- it looks like it is working.
alter table document_text
  add column search_vector tsvector
  generated always as (to_tsvector('english', content)) stored;

create index document_text_fts on document_text using gin (search_vector);
-- Every search is scoped by owner. The index leads with owner_user_id so that
-- scoping is cheap enough that nobody is ever tempted to skip it.
create index document_text_owner on document_text (owner_user_id);

alter table document_segments
  add column search_vector tsvector
  generated always as (to_tsvector('english', content)) stored;
create index document_segments_fts on document_segments using gin (search_vector);
create index document_segments_owner on document_segments (owner_user_id);

-- ---------- semantic search ----------
-- M51: optional, and it must disclose that text leaves the server.
--
-- Stored as bytes rather than a pgvector column because CE targets stock
-- PostgreSQL on Pi-class hardware, where an extension may not be installable.
-- Cosine similarity over a few thousand rows in the application is slower than
-- an index and fast enough to be honest about.
create table document_embeddings (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  segment_id uuid references document_segments(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- Which model produced it. A mixture of models in one index silently returns
  -- nonsense, because the vectors are not comparable.
  model text not null,
  dimensions integer not null check (dimensions > 0),
  vector bytea not null,
  created_at timestamptz not null default now()
);
create index document_embeddings_owner on document_embeddings (owner_user_id, model);
create index document_embeddings_document on document_embeddings (document_id);

-- The disclosure a person saw and agreed to before any text was sent anywhere.
-- Recorded per user, because consent given by one person is not consent given
-- by another.
create table semantic_consents (
  user_id uuid primary key references users(id) on delete cascade,
  disclosure text not null,
  provider text not null,
  consented_at timestamptz not null default now()
);

-- ---------- what a search returned ----------
-- M67: citations name the file and the most precise locator available, and
-- offer "Open source" only while the person still has access.
--
-- M71 is the reason this table exists at all: revoking access must make
-- citations unavailable WITHOUT rewriting messages that were already sent. So a
-- citation is stored by reference — resolve it at display time, and a revoked
-- document simply stops resolving.
create table message_citations (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  segment_id uuid references document_segments(id) on delete set null,
  owner_user_id uuid not null references users(id) on delete cascade,
  -- Kept so a citation can still say WHAT it referred to after the document is
  -- gone. This is the person's own filename, shown back to them, and it is not
  -- exposed to anyone else.
  filename_at_time text not null,
  locator text not null default '',
  created_at timestamptz not null default now()
);
create index message_citations_message on message_citations (message_id);
create index message_citations_document on message_citations (document_id);

alter table document_embeddings enable row level security;
alter table semantic_consents enable row level security;
alter table message_citations enable row level security;
