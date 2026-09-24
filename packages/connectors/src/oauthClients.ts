// The operator's own OAuth application.
//
// M28: CE ships with no client of its own. Each installation registers its own
// Google/Microsoft/Dropbox/Box application, exactly as other self-hosted
// products require, and the secret is sealed with the installation master key
// before storage.
//
// Nextcloud never appears here. It has no OAuth application to register at
// all — see `OAUTH_PROVIDERS` in capabilities.ts — so there is deliberately no
// 'nextcloud' row in `oauth_clients` and no code path that would insert one.
//
// There is no environment variable for these and no default. A CE image that
// carried a client secret would be handing every installation the same
// credential, and the first person to extract it could impersonate all of them.
import { appendEvent, deleteVaultSlot, openCredentialPayload, storeCredentialPayload, type Db, type MasterKey } from '@josi-ce/core';
import { OAUTH_PROVIDERS, type OAuthProvider } from './capabilities.js';
import type { OAuthClient } from './providers.js';

export interface ClientStatus {
  provider: OAuthProvider;
  configured: boolean;
  clientId: string | null;
  redirectUri: string | null;
  updatedAt: string | null;
}

/** What an administrator may see: that it is set, and the two values that are
 * not secret. Never the secret, in any form. */
export async function clientStatuses(db: Db): Promise<ClientStatus[]> {
  const rows = await db.query<{
    provider: OAuthProvider; client_id: string; redirect_uri: string; updated_at: string;
  }>(`select provider, client_id, redirect_uri, updated_at from oauth_clients`);
  const found = new Map(rows.map((r) => [r.provider, r]));
  return [...OAUTH_PROVIDERS].map((provider) => {
    const row = found.get(provider);
    // Built field by field rather than spread. A `...row` here would serve the
    // sealed secret the moment somebody widened the SELECT — which is exactly
    // what mutation M19 did, and what Phase 4's M18 did before it.
    return {
      provider,
      configured: !!row,
      // The client id is public by design — it travels in the authorize URL.
      clientId: row?.client_id ?? null,
      redirectUri: row?.redirect_uri ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function saveClient(
  db: Db,
  key: MasterKey,
  args: {
    provider: OAuthProvider;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    actorUserId: string;
  },
): Promise<void> {
  const stored=await storeCredentialPayload(db,key,{ownerUserId:args.actorUserId,kind:'oauth_token',service:'oauth_client',slot:args.provider,label:`${args.provider} OAuth client secret`,payload:{clientSecret:args.clientSecret},actorUserId:args.actorUserId});
  await db.query(
    `insert into oauth_clients (provider, client_id, client_secret_enc, redirect_uri, configured_by)
     values ($1, $2, $3, $4, $5)
     on conflict (provider) do update set
       client_id = excluded.client_id,
       client_secret_enc = excluded.client_secret_enc,
       redirect_uri = excluded.redirect_uri,
       configured_by = excluded.configured_by`,
    [args.provider, args.clientId, stored, args.redirectUri, args.actorUserId],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'connector.client_configured',
    // The provider and the fact it changed. Not the id, not the secret, not
    // the URI — the audit log answers "who changed what kind of thing, when".
    payload: { provider: args.provider },
  });
}

export async function deleteClient(
  db: Db,
  args: { provider: OAuthProvider; actorUserId: string },
): Promise<void> {
  await db.query(`delete from oauth_clients where provider = $1`, [args.provider]);
  const [owner]=await db.query<{id:string}>(`select id from users where role='super_admin' order by created_at limit 1`);
  if(owner)await deleteVaultSlot(db,{ownerUserId:owner.id,service:'oauth_client',slot:args.provider,actorUserId:args.actorUserId});
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'connector.client_removed',
    payload: { provider: args.provider },
  });
}

export class NoClientError extends Error {}

/** Opens the client for use. The only place the secret is decrypted. */
export async function loadClient(db: Db, key: MasterKey, provider: OAuthProvider): Promise<OAuthClient> {
  const [row] = await db.query<{ client_id: string; client_secret_enc: string; redirect_uri: string }>(
    `select client_id, client_secret_enc, redirect_uri from oauth_clients where provider = $1`,
    [provider],
  );
  if (!row) {
    throw new NoClientError(
      `no ${provider} application is configured for this installation — an administrator sets that up first`,
    );
  }
  return {
    provider,
    clientId: row.client_id,
    clientSecret: (await (async()=>{const [owner]=await db.query<{id:string}>(`select id from users where role='super_admin' order by created_at limit 1`);return openCredentialPayload<{clientSecret:string}>(db,key,{ownerUserId:owner?.id??'',service:'oauth_client',slot:provider,stored:row.client_secret_enc});})()).clientSecret,
    redirectUri: row.redirect_uri,
  };
}
