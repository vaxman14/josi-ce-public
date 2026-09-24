-- One table for the operator's OAuth applications, not two.
--
-- THE DEFECT. Migration 0002 created `connector_configs` for the setup wizard.
-- Migration 0005 created `oauth_clients` for the connector system built in
-- Phase 7. Nothing ever bridged them, and nothing that connects an account has
-- ever read `connector_configs`.
--
-- So an operator who registered their Google and Microsoft applications during
-- setup was told both were configured, and then found the Connect button
-- reporting that no application had been registered. The wizard wrote to one
-- table and the product read from another. Every test passed, because the
-- wizard's tests asserted against the wizard's table.
--
-- `oauth_clients` is the live one. The wizard now writes there, and anything
-- already stranded in `connector_configs` is carried across.

-- `oauth_clients.redirect_uri` is NOT NULL and `connector_configs.redirect_uri`
-- was not, so a row with neither a stored URI nor a usable domain cannot be
-- carried across — there is nothing truthful to put in the column. Those rows
-- are left where they are rather than migrated with a made-up value; the
-- operator re-registers from Settings, which is one form and produces a URI
-- that matches what the server will actually honour.
insert into oauth_clients (provider, client_id, client_secret_enc, redirect_uri)
select
  c.provider,
  c.client_id,
  -- Carried as ciphertext. The same installation master key opens it, so
  -- nothing is decrypted or re-encrypted here.
  c.client_secret_enc,
  coalesce(
    nullif(c.redirect_uri, ''),
    'https://' || d.domain || '/api/connections/' || c.provider || '/callback'
  )
from connector_configs c
left join (select domain from deployment_config where id = true) d on true
where coalesce(nullif(c.redirect_uri, ''), nullif(d.domain, '')) is not null
  and coalesce(d.domain, '') <> 'localhost'
-- An application registered through Settings after Phase 7 is the current
-- truth and is never overwritten by a stranded wizard row.
on conflict (provider) do nothing;

-- `connector_configs` is now unused by every code path. It is NOT dropped:
-- it holds sealed client secrets, and destroying an operator's credentials to
-- tidy a schema is a worse outcome than an orphaned table. It carries a comment
-- so the next person to read the schema is not misled by it.
comment on table connector_configs is
  'DEPRECATED and unused. Superseded by oauth_clients (migration 0005). Rows were '
  'carried across by migration 0018 where a redirect URI could be determined. '
  'Nothing reads this table; do not add anything to it.';
