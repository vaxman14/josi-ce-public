-- Josi CE 0030: storage providers, phase 2 — Dropbox, Box, Nextcloud.
--
-- Item 19 of Roman's round-2 list, sequenced strictly after Drive/OneDrive
-- (item 14) proved the ingestion pipeline live. Same architecture, three more
-- sources:
--
--   * Dropbox and Box are OAuth2, same shape as Google/Microsoft — they widen
--     the existing `connections` table rather than inventing a parallel one.
--   * Nextcloud is different by nature, not by choice: self-hosted means there
--     is no central OAuth application to register. Its standard integration
--     pattern is WebDAV + an app password the person generates in their own
--     Nextcloud account. That credential is sealed exactly like an OAuth
--     refresh token — `connections.secrets_enc`, opened only at the moment of
--     use — and the server URL the person types lives in `connections.meta`,
--     which this table has carried since 0001 and which no provider has used
--     until now.
--
-- Widening `connections.provider` and `folder_mappings.provider` rather than
-- adding new tables keeps every rule that already governs a connection —
-- ownership, 404-not-403, sealed secrets, deny-by-default mapping, purge on
-- revoke — true of the new providers for free, because they are now sentences
-- inside the SAME check constraint, not a second copy of it that could drift.

-- ---------- connections gains three more providers ----------
alter table connections drop constraint connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('google', 'microsoft', 'dropbox', 'box', 'nextcloud'));

-- ---------- oauth_clients: Dropbox and Box register an application too ----------
-- Nextcloud has no client to register — there is deliberately no 'nextcloud'
-- row here. A self-hosted Nextcloud has no central app-registration console;
-- the WebDAV + app-password path needs no client id or secret of ours at all.
alter table oauth_clients drop constraint oauth_clients_provider_check;
alter table oauth_clients add constraint oauth_clients_provider_check
  check (provider in ('google', 'microsoft', 'dropbox', 'box'));

-- ---------- the handshake, same widening ----------
alter table oauth_states drop constraint oauth_states_provider_check;
alter table oauth_states add constraint oauth_states_provider_check
  check (provider in ('google', 'microsoft', 'dropbox', 'box'));

-- ---------- folder_mappings: three more sources for a folder to come from ----------
-- M46 still applies: a FOLDER, never an account, and never "map my whole
-- Nextcloud". A Nextcloud mapping's `remote_folder_id` holds the WebDAV path
-- of the folder (e.g. "/Documents/Clients") rather than a provider-issued
-- opaque id — Nextcloud's WebDAV surface has no separate id namespace the way
-- Drive or Graph do, and the path IS the stable handle a re-list walks from.
alter table folder_mappings drop constraint folder_mappings_provider_check;
alter table folder_mappings add constraint folder_mappings_provider_check
  check (provider in ('local', 'google_drive', 'onedrive', 'dropbox', 'box', 'nextcloud'));

-- ---------- connections.last_error_category already covers these providers ----------
-- 0005's check constraint is on the CATEGORY vocabulary (revoked/expired/…),
-- not the provider, so no change is needed there — the same categories mean
-- the same things for a WebDAV 401 as for an OAuth one.
