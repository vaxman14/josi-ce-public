import { createHash, randomBytes } from 'node:crypto';
import { appendEvent, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { ExternalChannel } from './shared.js';

export interface ExternalConfigRow {
  provider: ExternalChannel;
  enabled: boolean;
  credentials_enc: string | null;
  webhook_secret_enc: string | null;
  risk_acknowledged_at: string | null;
  configured_at: string | null;
  probed_at: string | null;
  probe_ok: boolean | null;
  probe_error_category: string | null;
}

export interface ExternalLinkRow {
  id: string; provider: ExternalChannel; user_id: string; external_identity: string;
  conversation_id: string; thread_id: string | null; status: 'active' | 'revoked';
  linked_at: string; revoked_at: string | null; last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export class ExternalChannelError extends Error {
  constructor(message: string, readonly category = 'invalid') { super(message); }
}

export async function loadExternalConfig(db: Db, provider: ExternalChannel): Promise<ExternalConfigRow> {
  const [row] = await db.query<ExternalConfigRow>('select * from external_channel_configs where provider = $1', [provider]);
  if (!row) throw new ExternalChannelError('that channel is not available', 'not_configured');
  return row;
}

export function describeExternalConfig(row: ExternalConfigRow) {
  return {
    provider: row.provider, enabled: row.enabled, configured: !!row.credentials_enc,
    riskAcknowledged: !!row.risk_acknowledged_at, configuredAt: row.configured_at,
    probedAt: row.probed_at, probeOk: row.probe_ok,
    probeError: row.probe_error_category,
  };
}

export function openExternalConfig(masterKey: MasterKey | null, row: ExternalConfigRow): Record<string, string> {
  if (!masterKey || !row.credentials_enc || !row.webhook_secret_enc) {
    throw new ExternalChannelError('the channel is not configured or the installation key is unavailable', 'not_configured');
  }
  const credentials = openSealed<Record<string, string>>(masterKey, row.credentials_enc);
  const webhook = openSealed<{ secret: string }>(masterKey, row.webhook_secret_enc);
  return { ...credentials, webhookSecret: webhook.secret };
}

export async function storeExternalConfig(db: Db, args: {
  provider: ExternalChannel; masterKey: MasterKey | null; credentials: Record<string, string>;
  webhookSecret?: string; actorUserId: string; riskAcknowledged?: boolean;
}): Promise<void> {
  if (!args.masterKey) throw new ExternalChannelError('the installation master key is unavailable', 'no_master_key');
  if (!Object.values(args.credentials).every((v) => typeof v === 'string' && v.trim())) {
    throw new ExternalChannelError('all channel configuration fields are required');
  }
  if (args.provider === 'signal' && !args.riskAcknowledged) {
    throw new ExternalChannelError('acknowledge the Signal bridge and account risk before configuring it', 'risk_not_acknowledged');
  }
  const secret = args.webhookSecret?.trim() || randomBytes(32).toString('base64url');
  await db.query(
    `update external_channel_configs set credentials_enc=$2, webhook_secret_enc=$3,
       risk_acknowledged_at=case when $4 then now() else risk_acknowledged_at end,
       configured_at=now(), enabled=false, probe_ok=null, probe_error_category=null, updated_at=now()
     where provider=$1`,
    [args.provider, seal(args.masterKey, args.credentials), seal(args.masterKey, { secret }), !!args.riskAcknowledged],
  );
  await appendEvent(db, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'external_channel.configured', subjectType: 'external_channel', subjectId: args.provider, payload: { provider: args.provider } });
}

export async function setExternalProbe(db: Db, provider: ExternalChannel, ok: boolean, category: string | null): Promise<void> {
  await db.query('update external_channel_configs set probed_at=now(), probe_ok=$2, probe_error_category=$3, updated_at=now() where provider=$1', [provider, ok, category]);
}

export async function setExternalEnabled(db: Db, provider: ExternalChannel, enabled: boolean): Promise<void> {
  const row = await loadExternalConfig(db, provider);
  if (enabled && (!row.credentials_enc || row.probe_ok !== true)) throw new ExternalChannelError('configure and successfully test the channel before turning it on');
  await db.query('update external_channel_configs set enabled=$2, updated_at=now() where provider=$1', [provider, enabled]);
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function mintExternalLinkCode(db: Db, provider: ExternalChannel, userId: string) {
  const code = randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.query('delete from external_channel_link_codes where user_id=$1 and provider=$2 and used_at is null', [userId, provider]);
  await db.query('insert into external_channel_link_codes(provider,user_id,code_hash,expires_at) values($1,$2,$3,$4)', [provider, userId, hash(code), expiresAt]);
  return { code, expiresAt };
}

export async function consumeExternalLinkCode(db: Db, args: { provider: ExternalChannel; code: string; externalIdentity: string; conversationId: string }): Promise<ExternalLinkRow | null> {
  const rows = await db.query<{ id: string; user_id: string }>(
    `update external_channel_link_codes set used_at=now()
     where id=(select id from external_channel_link_codes where provider=$1 and code_hash=$2 and used_at is null and expires_at>now() for update skip locked limit 1)
     returning id,user_id`, [args.provider, hash(args.code)],
  );
  const claimed = rows[0]; if (!claimed) return null;
  await db.query("update external_channel_links set status='revoked', revoked_at=now() where provider=$1 and external_identity=$2 and status='active'", [args.provider, args.externalIdentity]);
  const [link] = await db.query<ExternalLinkRow>(
    `insert into external_channel_links(provider,user_id,external_identity,conversation_id)
     values($1,$2,$3,$4) returning *`, [args.provider, claimed.user_id, args.externalIdentity, args.conversationId],
  );
  await appendEvent(db, { actorUserId: claimed.user_id, actor: 'user', kind: 'external_channel.linked', subjectType: 'external_channel_link', subjectId: link.id, payload: { provider: args.provider } });
  return link;
}

export async function resolveExternalLink(db: Db, provider: ExternalChannel, identity: string): Promise<ExternalLinkRow | null> {
  const [row] = await db.query<ExternalLinkRow>("select * from external_channel_links where provider=$1 and external_identity=$2 and status='active'", [provider, identity]);
  return row ?? null;
}

export async function listExternalLinks(db: Db, userId: string): Promise<ExternalLinkRow[]> {
  return db.query<ExternalLinkRow>('select * from external_channel_links where user_id=$1 order by linked_at desc', [userId]);
}

export async function revokeExternalLink(db: Db, linkId: string, userId?: string): Promise<boolean> {
  const params = userId ? [linkId, userId] : [linkId];
  const rows = await db.query<{ id: string }>(`update external_channel_links set status='revoked',revoked_at=now() where id=$1 ${userId ? 'and user_id=$2' : ''} and status='active' returning id`, params);
  return rows.length > 0;
}

export async function claimExternalEvent(db: Db, provider: ExternalChannel, eventId: string, conversationId: string): Promise<boolean> {
  const rows = await db.query<{ event_id: string }>('insert into external_channel_events(provider,event_id,conversation_id) values($1,$2,$3) on conflict do nothing returning event_id', [provider, eventId, conversationId]);
  return rows.length > 0;
}

export async function finishExternalEvent(db: Db, provider: ExternalChannel, eventId: string, outcome: string): Promise<void> {
  await db.query('update external_channel_events set outcome=$3 where provider=$1 and event_id=$2', [provider, eventId, outcome]);
}
