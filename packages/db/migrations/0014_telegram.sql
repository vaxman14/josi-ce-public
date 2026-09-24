-- Josi CE 0014: Telegram as a first-class channel.
--
-- THE THING THIS SCHEMA IS SHAPED AROUND
--
-- A Telegram `chat_id` is an UNAUTHENTICATED CLAIM. Anybody who can find the
-- bot can send it a message, and the update that arrives carries a chat id and
-- a Telegram user id that CE has no way to challenge. Every other channel in CE
-- starts from a session cookie that Phase 1 issued; this one starts from a
-- number a stranger chose to send.
--
-- So the default for an unknown chat is REFUSAL, and the only way a chat stops
-- being unknown is `telegram_links` — a row a signed-in CE user created
-- deliberately, by redeeming a single-use code they were shown in the web app.
-- That is the whole trust story, and the tables below exist to make it the only
-- one available: there is no column anywhere here that an inbound update can
-- write, and no path from a chat id to a user that does not go through an
-- active link row.
--
-- WHAT IS NOT IN THESE TABLES
--
-- Message text. Not one column. A Telegram message becomes a row in `messages`,
-- under a thread, behind the ownership spine Phase 1 built — exactly where a
-- web-app message goes, and subject to exactly the same sharing rules. These
-- tables hold routing and operational metadata, so the super admin who can read
-- them for support is reading plumbing, not mail.

-- ---------- the installation's bot ----------
--
-- One bot per installation, configured by the super admin, using the operator's
-- OWN token from BotFather. No Josi-operated relay exists and there is nowhere
-- for one to be configured — the operator's Telegram bot talks to the
-- operator's own server, and nothing sits in between.
create table telegram_config (
  id boolean primary key default true check (id),

  -- Off until a token has been set AND probed. `enabled` alone never grants
  -- anything: the inbound path re-checks that a token exists and that the probe
  -- succeeded, because a row edited by any other means must not become live.
  enabled boolean not null default false,

  -- Sealed with the installation master key, like every other credential in
  -- CE. A database dump alone does not yield a working bot token — which
  -- matters more here than usual, because a bot token is not just a credential
  -- for reading: it lets the holder SEND, as the operator's assistant, to every
  -- person who ever linked.
  bot_token_enc text,

  -- Learned from getMe, not typed by the operator. Storing what the provider
  -- said rather than what the human believes is how a pasted-wrong token is
  -- caught at setup instead of at 2am.
  bot_id bigint,
  bot_username text,

  -- The `X-Telegram-Bot-Api-Secret-Token` header value, sealed. Telegram echoes
  -- this on every webhook delivery and nothing else does, so it is the only
  -- thing distinguishing a real delivery from anybody on the internet POSTing
  -- to a URL they guessed.
  webhook_secret_enc text,
  -- Where deliveries are expected. Recorded so the admin screen can show what
  -- was registered without asking Telegram, and so a stale registration after a
  -- domain change is visible.
  webhook_url text,
  webhook_set_at timestamptz,

  probed_at timestamptz,
  probe_ok boolean,
  -- A CATEGORY, never the provider's error string. Telegram's errors quote the
  -- token back in some failure modes, and an admin screen is not the place to
  -- render a credential.
  probe_error text check (probe_error is null or probe_error in (
    'unauthorized', 'network', 'rate_limited', 'malformed', 'unknown'
  )),

  -- M44's discipline, applied to a different channel: attachments are off until
  -- an administrator turns them on, and the ceiling is theirs to set.
  attachments_enabled boolean not null default false,
  max_attachment_bytes bigint not null default 5242880
    check (max_attachment_bytes > 0 and max_attachment_bytes <= 20971520),

  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- Enabled with no token is a configuration that cannot work but looks like it
  -- should. Refuse the shape rather than debug it later.
  constraint telegram_enabled_needs_token check (
    not enabled or (bot_token_enc is not null and webhook_secret_enc is not null)
  )
);
insert into telegram_config (id) values (true) on conflict do nothing;
create trigger telegram_config_touch before update on telegram_config
  for each row execute function touch_updated_at();

-- ---------- who a chat belongs to ----------
create table telegram_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,

  -- Telegram's ids are 64-bit and can be negative (groups are negative), which
  -- is one reason the inbound path refuses anything that is not a private chat.
  chat_id bigint not null,
  telegram_user_id bigint,
  -- Kept so the person can tell their own links apart when they have more than
  -- one. A Telegram @username is the person's own public handle, not content.
  telegram_username text,

  status text not null default 'active' check (status in ('active', 'revoked')),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Who revoked: the owner, or a super admin exercising L1.8. Recorded because
  -- "my Telegram stopped working" has two very different answers.
  revoked_by uuid references users(id) on delete set null,

  -- The conversation this chat feeds. One thread per link, created on the
  -- first message and kept, so a person's Telegram history is one continuous
  -- conversation rather than a new thread per message — and so it is a thread
  -- like any other: owned, shareable, searchable, and subject to the same
  -- retention as everything else they say to Josi.
  --
  -- `on delete set null` rather than cascade: deleting a conversation should
  -- not silently unlink somebody's phone.
  thread_id uuid references threads(id) on delete set null,

  last_inbound_at timestamptz,
  last_outbound_at timestamptz,

  constraint telegram_link_revoked_shape check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

-- ONE ACTIVE OWNER PER CHAT, as a database constraint rather than a check in
-- application code. This is the row that decides whose conversation a message
-- reaches; two of them for one chat would mean a message routed by whichever
-- happened to sort first.
create unique index telegram_links_one_active_chat
  on telegram_links (chat_id) where status = 'active';
create index telegram_links_user on telegram_links (user_id, status);

-- ---------- one-time link codes ----------
--
-- Same discipline as Phase 1's session tokens, for the same reason: this code
-- is a bearer credential that converts into an authenticated channel, so the
-- database stores a HASH. A dump does not yield a redeemable code, and neither
-- does a screenshot of a support query.
create table telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,

  -- sha256 of the code. Unique so a hash collision or a duplicate insert is a
  -- constraint violation rather than two users sharing a code.
  code_hash text not null unique,

  expires_at timestamptz not null,
  -- Single use. Set on redemption, and the redemption statement is conditional
  -- on it being null, so two simultaneous redemptions cannot both win.
  used_at timestamptz,
  used_by_chat_id bigint,
  -- Set when the user mints a replacement or unlinks, so an old code in a chat
  -- history stops working immediately rather than at expiry.
  invalidated_at timestamptz,

  created_at timestamptz not null default now()
);
create index telegram_link_codes_user on telegram_link_codes (user_id, created_at desc);
create index telegram_link_codes_expiry on telegram_link_codes (expires_at);

-- ---------- delivery de-duplication ----------
--
-- Telegram re-delivers an update until it gets a 2xx, and a timeout on our side
-- means the same message arrives again. Without this table a slow turn becomes
-- two answers to one question, and — worse — two charges against the model cap.
--
-- The primary key IS the de-duplication: the insert is `on conflict do nothing`
-- and a zero-row result means "already handled, acknowledge and stop".
create table telegram_updates (
  update_id bigint primary key,
  chat_id bigint,
  received_at timestamptz not null default now(),
  -- What happened to it, for the admin's operational view. No message text.
  outcome text not null default 'accepted' check (outcome in (
    'accepted', 'unlinked', 'not_private', 'ignored', 'refused', 'failed'
  ))
);
create index telegram_updates_received on telegram_updates (received_at);

-- ---------- outbound attempts ----------
--
-- Retries need somewhere to record that they happened, and an operator
-- debugging "Josi went quiet" needs to see attempts and categories. Again: a
-- category, never Telegram's error text, and never the message.
create table telegram_outbound (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  -- Which CE user this was on behalf of, so the admin view can be filtered
  -- without reading anything.
  user_id uuid references users(id) on delete set null,
  kind text not null default 'reply' check (kind in ('reply', 'notice', 'refusal')),

  state text not null default 'pending' check (state in ('pending', 'sent', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  -- Character count, so "the reply was empty" is diagnosable without storing
  -- the reply.
  body_chars integer not null default 0 check (body_chars >= 0),
  chunks integer not null default 1 check (chunks >= 1),
  error_category text check (error_category is null or error_category in (
    'unauthorized', 'blocked_by_user', 'chat_not_found', 'rate_limited',
    'network', 'too_large', 'malformed', 'unknown'
  )),

  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index telegram_outbound_chat on telegram_outbound (chat_id, created_at desc);
create index telegram_outbound_state on telegram_outbound (state, created_at);

-- ---------- attachments ----------
--
-- Recorded, never stored here. What CE keeps is the decision it made and why —
-- so an owner asking "why did Josi ignore my photo" gets an answer, and so a
-- pattern of refusals is visible to the administrator who set the limits.
create table telegram_attachments (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  user_id uuid references users(id) on delete set null,
  -- Telegram's opaque file id. Not a URL, not a path, not a filename.
  file_unique_id text,
  declared_bytes bigint check (declared_bytes is null or declared_bytes >= 0),
  received_bytes bigint check (received_bytes is null or received_bytes >= 0),
  mime_type text,
  extension text,
  outcome text not null check (outcome in (
    'accepted', 'too_large', 'type_not_allowed', 'attachments_disabled',
    'download_failed', 'oversize_during_download', 'unsafe_name'
  )),
  created_at timestamptz not null default now()
);
create index telegram_attachments_chat on telegram_attachments (chat_id, created_at desc);
