import { Router, type Express, type Request, type Response } from 'express';
import {
  appendEvent, createThread, listMessages, loadMasterKey, markActionsPresented, recordExchange,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  SIGNAL_RISK_NOTICE, claimExternalEvent, consumeExternalLinkCode, describeExternalConfig,
  finishExternalEvent, listExternalLinks, loadExternalConfig, mintExternalLinkCode,
  normalizeSignal, normalizeSlack, normalizeWhatsApp, openExternalConfig,
  resolveExternalLink, revokeExternalLink, sendSignal, sendSlack, sendWhatsApp,
  setExternalEnabled, setExternalProbe, storeExternalConfig, verifySignalBridge,
  verifySlackSignature, verifyWhatsAppChallenge, verifyWhatsAppSignature,
  type ExternalChannel, type ExternalLinkRow, type NormalizedMessage,
} from '@josi-ce/channels';
import { runAssistantTurn } from '@josi-ce/agent';
import { mailPolicy } from '@josi-ce/mail';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute, param } from './async.js';

export interface ExternalChannelCtx {
  db: Db; masterKey?: LoadOptions | false; appUrl: string; fetchImpl?: typeof fetch;
  llmFetch?: typeof fetch; llmResolve?: (hostname: string) => Promise<string[]>;
  connectorFetch?: typeof fetch;
}

const PROVIDERS = new Set<ExternalChannel>(['whatsapp', 'slack']);
const providerOf = (value: unknown): ExternalChannel | null => typeof value === 'string' && PROVIDERS.has(value as ExternalChannel) ? value as ExternalChannel : null;
const text = (value: unknown, max = 4000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function keyOf(ctx: ExternalChannelCtx): MasterKey | null {
  if (ctx.masterKey === false) return null;
  try { return loadMasterKey(ctx.masterKey ?? undefined); } catch { return null; }
}

function publicLink(link: ExternalLinkRow) {
  return { id: link.id, provider: link.provider, status: link.status, linkedAt: link.linked_at, revokedAt: link.revoked_at, lastInboundAt: link.last_inbound_at, lastOutboundAt: link.last_outbound_at };
}

export function externalChannelRoutes(ctx: ExternalChannelCtx): Router {
  const r = Router(); r.use(requireAuth);
  r.get('/', asyncRoute(async (req, res) => {
    const configs = await Promise.all([...PROVIDERS].map((p) => loadExternalConfig(ctx.db, p)));
    const links = await listExternalLinks(ctx.db, req.user!.id);
    res.json({ channels: configs.map(describeExternalConfig), links: links.map(publicLink), signalRiskNotice: SIGNAL_RISK_NOTICE });
  }));
  r.post('/:provider/link-code', asyncRoute(async (req, res) => {
    const provider = providerOf(param(req, 'provider')); if (!provider) return res.status(404).json({ error: 'no such channel' });
    const config = await loadExternalConfig(ctx.db, provider);
    if (!config.enabled) return res.status(409).json({ error: 'that channel is not turned on for this installation' });
    const minted = await mintExternalLinkCode(ctx.db, provider, req.user!.id);
    res.status(201).json({ ...minted, instruction: `Send “link ${minted.code}” to Josi on ${provider}.` });
  }));
  r.delete('/links/:id', asyncRoute(async (req, res) => {
    const revoked = await revokeExternalLink(ctx.db, param(req, 'id'), req.user!.id);
    if (!revoked) return res.status(404).json({ error: 'not found' });
    res.json({ revoked: true });
  }));
  return r;
}

export function adminExternalChannelRoutes(ctx: ExternalChannelCtx): Router {
  const r = Router(); r.use(requireSuperAdmin);
  r.get('/', asyncRoute(async (_req, res) => {
    const configs = await Promise.all([...PROVIDERS].map((p) => loadExternalConfig(ctx.db, p)));
    res.json({ channels: configs.map(describeExternalConfig), signalRiskNotice: SIGNAL_RISK_NOTICE });
  }));
  r.post('/:provider/config', asyncRoute(async (req, res) => {
    const provider = providerOf(param(req, 'provider')); if (!provider) return res.status(404).json({ error: 'no such channel' });
    const credentials = credentialsFrom(provider, req.body);
    await storeExternalConfig(ctx.db, { provider, masterKey: keyOf(ctx), credentials, webhookSecret: provider === 'whatsapp' ? text(req.body?.webhookSecret, 500) : undefined, actorUserId: req.user!.id, riskAcknowledged: req.body?.riskAcknowledged === true });
    res.status(201).json({ configured: true, enabled: false });
  }));
  r.post('/:provider/probe', asyncRoute(async (req, res) => {
    const provider = providerOf(param(req, 'provider')); if (!provider) return res.status(404).json({ error: 'no such channel' });
    const row = await loadExternalConfig(ctx.db, provider); const secrets = openExternalConfig(keyOf(ctx), row);
    let ok = false; let category: string | null = null;
    try { ok = await probe(provider, secrets, ctx.fetchImpl); category = ok ? null : 'rejected'; } catch { category = 'network'; }
    await setExternalProbe(ctx.db, provider, ok, category);
    res.status(ok ? 200 : 502).json({ ok, category });
  }));
  r.post('/:provider/enabled', asyncRoute(async (req, res) => {
    const provider = providerOf(param(req, 'provider')); if (!provider) return res.status(404).json({ error: 'no such channel' });
    await setExternalEnabled(ctx.db, provider, req.body?.enabled === true);
    await appendEvent(ctx.db, { actorUserId: req.user!.id, actor: 'super_admin', kind: 'external_channel.enabled_changed', subjectType: 'external_channel', subjectId: provider, payload: { provider, enabled: req.body?.enabled === true } });
    res.json({ enabled: req.body?.enabled === true });
  }));
  return r;
}

function credentialsFrom(provider: ExternalChannel, body: Record<string, unknown> | undefined): Record<string, string> {
  if (provider === 'whatsapp') return { appSecret: text(body?.appSecret, 500), accessToken: text(body?.accessToken, 1000), phoneNumberId: text(body?.phoneNumberId, 100) };
  if (provider === 'slack') return { signingSecret: text(body?.signingSecret, 500), botToken: text(body?.botToken, 1000) };
  return { bridgeUrl: text(body?.bridgeUrl, 1000), account: text(body?.account, 200), bridgeSecret: text(body?.bridgeSecret, 500) };
}

async function probe(provider: ExternalChannel, s: Record<string, string>, fetchImpl = fetch): Promise<boolean> {
  if (provider === 'whatsapp') {
    const r = await fetchImpl(`https://graph.facebook.com/v23.0/${encodeURIComponent(s.phoneNumberId)}?fields=id`, { headers: { Authorization: `Bearer ${s.accessToken}` } }); return r.ok;
  }
  if (provider === 'slack') {
    const r = await fetchImpl('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${s.botToken}` } });
    const body = await r.json().catch(() => ({})) as { ok?: boolean }; return r.ok && body.ok === true;
  }
  const r = await fetchImpl(`${s.bridgeUrl.replace(/\/$/, '')}/v1/about`, { headers: { 'X-Josi-Signature': s.bridgeSecret } }); return r.ok;
}

export function mountExternalChannelWebhooks(app: Express, ctx: ExternalChannelCtx): void {
  app.get('/channels/whatsapp/webhook', asyncRoute(async (req, res) => {
    const row = await loadExternalConfig(ctx.db, 'whatsapp');
    if (!row.enabled) return res.status(404).send('not found');
    let s: Record<string, string>; try { s = openExternalConfig(keyOf(ctx), row); } catch { return res.status(404).send('not found'); }
    const challenge = verifyWhatsAppChallenge(req.query, s.webhookSecret);
    if (challenge === null) return res.status(404).send('not found');
    res.type('text/plain').send(challenge);
  }));
  app.post('/channels/:provider/webhook', asyncRoute(async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const provider = providerOf(param(req, 'provider')); if (!provider) return res.status(404).json({ error: 'not found' });
    const row = await loadExternalConfig(ctx.db, provider); if (!row.enabled) return res.status(404).json({ error: 'not found' });
    let s: Record<string, string>; try { s = openExternalConfig(keyOf(ctx), row); } catch { return res.status(404).json({ error: 'not found' }); }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const authentic = provider === 'whatsapp' ? verifyWhatsAppSignature(raw, req.get('x-hub-signature-256'), s.appSecret)
      : provider === 'slack' ? verifySlackSignature(raw, req.get('x-slack-request-timestamp'), req.get('x-slack-signature'), s.signingSecret)
      : verifySignalBridge(raw, req.get('x-josi-signature'), s.bridgeSecret);
    if (!authentic) return res.status(404).json({ error: 'not found' });
    if (provider === 'slack' && req.body?.type === 'url_verification' && typeof req.body?.challenge === 'string') return res.json({ challenge: req.body.challenge });
    const messages = provider === 'whatsapp' ? normalizeWhatsApp(req.body) : provider === 'slack' ? normalizeSlack(req.body) : normalizeSignal(req.body);
    for (const message of messages) await processInbound(ctx, s, message).catch((err) => console.error(`${provider} webhook failed`, (err as Error).message));
    res.status(200).json({ ok: true });
  }));
}

async function processInbound(ctx: ExternalChannelCtx, secrets: Record<string, string>, message: NormalizedMessage): Promise<void> {
  if (!await claimExternalEvent(ctx.db, message.channel, message.eventId, message.conversationId)) return;
  const finish = (outcome: string) => finishExternalEvent(ctx.db, message.channel, message.eventId, outcome);
  const match = /^link\s+([A-Za-z0-9_-]{20,128})$/i.exec(message.text);
  if (match) {
    const link = await consumeExternalLinkCode(ctx.db, { provider: message.channel, code: match[1], externalIdentity: message.externalIdentity, conversationId: message.conversationId });
    await sendExternal(ctx, secrets, message, link ? 'Linked. You can talk to Josi here now.' : 'That link code is invalid or expired. Generate a new one in Josi.');
    return finish(link ? 'accepted' : 'refused');
  }
  const link = await resolveExternalLink(ctx.db, message.channel, message.externalIdentity);
  if (!link) { await sendExternal(ctx, secrets, message, 'This identity is not linked. Sign in to Josi, create a one-time link code, then send “link CODE” here.'); return finish('unlinked'); }
  if (message.attachmentIds.length && !message.text) { await sendExternal(ctx, secrets, message, 'Josi cannot read files from this channel yet. Use the web app for attachments.'); return finish('refused'); }
  if (!message.text) return finish('ignored');
  const threadId = await externalThread(ctx.db, link);
  const history = (await listMessages(ctx.db, { threadId, limit: 40 })).map((m) => ({ role: m.direction === 'in' ? 'user' as const : 'assistant' as const, content: m.body }));
  const result = await runAssistantTurn({ db: ctx.db, registry: { db: ctx.db, masterKey: keyOf(ctx), fetchImpl: ctx.llmFetch, resolve: ctx.llmResolve }, userId: link.user_id, threadId, history, inbound: message.text, connectorFetch: ctx.connectorFetch, channel: 'external', sessionKey: threadId });
  const reply = result.refusal?.message ?? result.reply;
  const actionState=result.actions.find(action=>action.tool==='assistant_action_state'&&action.result&&typeof action.result==='object')?.result as {domain?:unknown}|undefined;
  const outboundMeta:Record<string,unknown>={};
  if(actionState?.domain==='email'||actionState?.domain==='calendar')outboundMeta.action_status_domain=actionState.domain;
  if(result.retry)outboundMeta.retry=result.retry;
  if(result.mediaResult)outboundMeta.media_result=result.mediaResult;
  const exchange=await recordExchange(ctx.db, { ownerUserId: link.user_id, threadId, channel: message.channel, inbound: message.text, reply,
    inboundMeta:result.mediaRequest?{media_request:result.mediaRequest}:undefined,
    outboundMeta:Object.keys(outboundMeta).length?outboundMeta:undefined });
  const presentedTaskIds=result.actions.map(action=>action.result).filter((value):value is {state:string;task_id:string}=>
    !!value&&typeof value==='object'&&['collecting','prepared'].includes(String((value as {state?:unknown}).state))&&typeof (value as {task_id?:unknown}).task_id==='string').map(value=>value.task_id);
  await markActionsPresented(ctx.db,{ownerUserId:link.user_id,threadId,taskIds:presentedTaskIds,messageId:exchange.outbound.id});
  const disclosure = (await mailPolicy(ctx.db)).disclosure.replace('{user}', 'you');
  await sendExternal(ctx, secrets, message, `${reply}\n\n${disclosure}`);
  await ctx.db.query('update external_channel_links set last_inbound_at=now(),last_outbound_at=now() where id=$1', [link.id]);
  return finish(result.refusal ? 'refused' : 'accepted');
}

async function externalThread(db: Db, link: ExternalLinkRow): Promise<string> {
  if (link.thread_id) { const [row] = await db.query<{ id: string }>('select id from threads where id=$1', [link.thread_id]); if (row) return row.id; }
  const thread = await createThread(db, { ownerUserId: link.user_id, title: link.provider[0].toUpperCase() + link.provider.slice(1) });
  await db.query('update external_channel_links set thread_id=$2 where id=$1', [link.id, thread.id]); return thread.id;
}

async function sendExternal(ctx: ExternalChannelCtx, s: Record<string, string>, message: NormalizedMessage, body: string): Promise<void> {
  const [queued] = await ctx.db.query<{ id: string }>('insert into external_channel_outbound(provider,conversation_id,body_chars) values($1,$2,$3) returning id', [message.channel, message.conversationId, body.length]);
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) try {
    let id = '';
    if (message.channel === 'whatsapp') id = await sendWhatsApp({ phoneNumberId: s.phoneNumberId, token: s.accessToken, to: message.externalIdentity, text: body, fetchImpl: ctx.fetchImpl });
    else if (message.channel === 'slack') id = await sendSlack({ botToken: s.botToken, channel: message.conversationId.split(':').slice(1).join(':'), text: body, threadTs: message.replyTo, fetchImpl: ctx.fetchImpl });
    else await sendSignal({ bridgeUrl: s.bridgeUrl, account: s.account, recipient: message.externalIdentity, text: body, secret: s.bridgeSecret, fetchImpl: ctx.fetchImpl });
    await ctx.db.query("update external_channel_outbound set state='sent',attempts=$2,provider_message_id=$3,sent_at=now() where id=$1", [queued.id, attempt, id || null]); return;
  } catch (err) { last = err; await ctx.db.query('update external_channel_outbound set attempts=$2 where id=$1', [queued.id, attempt]); }
  await ctx.db.query("update external_channel_outbound set state='failed',error_category='provider_error' where id=$1", [queued.id]); throw last;
}

declare global { namespace Express { interface Request { rawBody?: Buffer } } }
