import { json, type Db } from '@josi-ce/core';

export interface PublicAddress {
  origin: string;
  hostname: string;
  tlsMode: 'bundled_caddy' | 'external_proxy';
}

/** Parse the installer-owned browser origin.  This deliberately accepts LAN
 * HTTP as well as public HTTPS: changing back to LAN must repair stale public
 * metadata just as reliably as changing between two public domains. */
export function publicAddressFromEnvironment(appUrl: string, accessMode = process.env.JOSI_ACCESS_MODE): PublicAddress {
  const url = new URL(appUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('APP_URL is not a valid installation origin');
  }
  if ((accessMode === 'domain' || accessMode === 'proxy') && url.protocol !== 'https:') {
    throw new Error('the configured public installation origin must use HTTPS');
  }
  return {
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    tlsMode: accessMode === 'proxy' ? 'external_proxy' : 'bundled_caddy',
  };
}

/** Keep every persisted derivative of APP_URL in one PostgreSQL statement.
 *
 * PostgreSQL statement atomicity is important here.  The network controller
 * considers the new stack ready only after API startup succeeds.  Therefore a
 * database error prevents readiness and makes the controller restore the old
 * .env/Compose/Caddy shape; the restored API then runs this same statement
 * with the old APP_URL, completing the rollback without a split-brain window.
 *
 * Remote registration is finalized by the controller after public health,
 * never speculatively at boot. The controller restores it on failure.
 */
export async function reconcilePublicAddress(db: Db, address: PublicAddress): Promise<void> {
  await db.query(
    `with deployment as (
       update deployment_config
          set domain = $1, tls_mode = $2,
              certificate_verified_at = case when domain is distinct from $1 or tls_mode is distinct from $2 or (select settings->>'publicAddress' from workspace where id=true) is distinct from $3 then null else certificate_verified_at end
        where id = true
        returning domain
     ), workspace_changed as (
       update workspace
          set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{publicAddress}', to_jsonb($3::text), true)
        where id = true
        returning id
     ), oauth_changed as (
       update oauth_clients
          set redirect_uri = $3 || '/api/connections/' || provider || '/callback'
        where redirect_uri is distinct from $3 || '/api/connections/' || provider || '/callback'
        returning provider
     )
     update telegram_config
        set webhook_url = $3 || '/telegram/webhook', webhook_set_at = null
      where id = true and webhook_url is not null
        and webhook_url is distinct from $3 || '/telegram/webhook'`,
    [address.hostname, address.tlsMode, address.origin],
  );
}

/** A rollback snapshot contains address metadata only, never OAuth credentials. */
export async function snapshotPublicAddress(db:Db) {
  const [deployment]=await db.query(`select domain,tls_mode,certificate_verified_at from deployment_config where id=true`);
  const [workspace]=await db.query(`select settings->'publicAddress' as origin from workspace where id=true`);
  const oauth=await db.query(`select provider,redirect_uri from oauth_clients`);
  const [telegram]=await db.query(`select webhook_url,webhook_set_at from telegram_config where id=true`);
  return {deployment,workspace,oauth,telegram};
}

export async function restorePublicAddress(db:Db,snapshot:Awaited<ReturnType<typeof snapshotPublicAddress>>) {
  // One statement: even an injected database failure restores either everything
  // or nothing. Runtime startup already restored the old origin before this runs.
  await db.query(`with d as (
    update deployment_config set domain=$1,tls_mode=$2,certificate_verified_at=$3 where id=true
  ), w as (
    update workspace set settings=case when $4::jsonb is null then settings-'publicAddress'
      else jsonb_set(settings,'{publicAddress}',$4::jsonb,true) end where id=true
  ), o as (
    update oauth_clients c set redirect_uri=v.redirect_uri
      from jsonb_to_recordset($5::jsonb) as v(provider text,redirect_uri text) where c.provider=v.provider
  ) update telegram_config set webhook_url=$6,webhook_set_at=$7 where id=true`,[
    snapshot.deployment?.domain??null,snapshot.deployment?.tls_mode??'bundled_caddy',snapshot.deployment?.certificate_verified_at??null,
    snapshot.workspace?.origin==null?null:json(snapshot.workspace.origin),json(snapshot.oauth),
    snapshot.telegram?.webhook_url??null,snapshot.telegram?.webhook_set_at??null,
  ]);
}

/** Publish an already-configured remote webhook only after public TLS/health
 * succeeds. A remote failure aborts the address transaction and triggers restore. */
export async function verifyPublicAddress(db:Db,masterKey:import('@josi-ce/core').MasterKey,origin:string,previous:Awaited<ReturnType<typeof snapshotPublicAddress>>|null,fetchImpl?:typeof fetch){
  if(previous?.telegram?.webhook_set_at){
    if(!origin.startsWith('https://'))throw new Error('Disconnect the registered Telegram webhook before switching to LAN HTTP.');
    const {registerWebhook}=await import('@josi-ce/channels');
    const [admin]=await db.query<{id:string}>(`select id from users where role='super_admin' and status='active' order by created_at limit 1`);
    if(!admin)throw new Error('No administrator can authorize webhook registration.');
    await registerWebhook(db,{masterKey,appUrl:origin,actorUserId:admin.id,fetchImpl});
  }
  await db.query(`update deployment_config set certificate_verified_at=now() where id=true`);
}

export async function restoreRemotePublicAddress(db:Db,masterKey:import('@josi-ce/core').MasterKey,previous:Awaited<ReturnType<typeof snapshotPublicAddress>>,fetchImpl?:typeof fetch){
  if(previous.telegram?.webhook_set_at&&typeof previous.telegram.webhook_url==='string'){
    const {loadConfig,openToken,openWebhookSecret,TelegramBotApi}=await import('@josi-ce/channels');
    const config=await loadConfig(db);
    const api=new TelegramBotApi({token:openToken(masterKey,config),fetchImpl});
    await api.setWebhook({url:previous.telegram.webhook_url,secretToken:openWebhookSecret(masterKey,config)});
  }
}
