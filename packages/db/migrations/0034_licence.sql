-- The installation's licence.
--
-- One row, because an installation is licensed or it is not. Replacing a
-- licence overwrites this row rather than accumulating history nobody can act
-- on — the operator's question is always "am I licensed now", and a list of
-- superseded keys answers a question nobody asked.
--
-- The token is NOT a secret in the way an API key is: it is a signed statement
-- about this installation, and it verifies against a public key stamped into
-- the image. It is still stored unencrypted on purpose, and that is a
-- deliberate decision rather than an oversight — sealing it with the master key
-- would mean an installation whose key is missing could not tell the operator
-- whether it was licensed, which is exactly when they most need to know.
create table licence (
  id boolean primary key default true check (id),

  -- `<base64url payload>.<base64url signature>`. Verified on every read; the
  -- stored state below is a cache of that verification, never the authority.
  token text not null check (length(token) > 0),

  -- What the last verification concluded, so the admin screen can render
  -- without re-running crypto on every poll, and so a licence that has expired
  -- since activation is visible as expired rather than as active.
  last_state text check (last_state in (
    'unverifiable_build', 'active', 'expired', 'wrong_installation', 'invalid'
  )),
  last_checked_at timestamptz,

  -- Copied out of the verified payload for display and for ordering. Never
  -- trusted for a decision: the token is re-verified and these are refreshed
  -- from it, so editing them by hand changes what is shown and not what is
  -- permitted.
  subject text,
  expires_at timestamptz,

  activated_at timestamptz not null default now(),
  activated_by uuid references users(id) on delete set null
);
