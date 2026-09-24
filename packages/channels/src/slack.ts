import { createHmac } from 'node:crypto';
import { ChannelPayloadError, secureEqual, type NormalizedMessage } from './shared.js';

export function verifySlackSignature(rawBody: Buffer, timestamp: unknown, signature: unknown, secret: string, now = Date.now()): boolean {
  if (typeof timestamp !== 'string' || typeof signature !== 'string' || !/^v0=/.test(signature)) return false;
  const seconds = Number(timestamp); if (!Number.isFinite(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 300) return false;
  return secureEqual(signature, `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(rawBody).digest('hex')}`);
}

export function normalizeSlack(payload: unknown): NormalizedMessage[] {
  const root = record(payload); const event = record(root.event);
  if (root.type !== 'event_callback' || event.type !== 'message' || event.subtype || event.bot_id) return [];
  const id = text(root.event_id); const user = text(event.user); const channel = text(event.channel);
  if (!id || !user || !channel) return [];
  return [{ channel: 'slack', eventId: id, externalIdentity: `${text(root.team_id)}:${user}`, conversationId: `${text(root.team_id)}:${channel}`, text: text(event.text), replyTo: text(event.thread_ts) || null, attachmentIds: array(event.files).map((file) => text(record(file).id)).filter(Boolean) }];
}

export async function sendSlack(args: { botToken: string; channel: string; text: string; threadTs?: string | null; fetchImpl?: typeof fetch }): Promise<string> {
  const response = await (args.fetchImpl ?? fetch)('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: `Bearer ${args.botToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: args.channel, text: args.text, ...(args.threadTs ? { thread_ts: args.threadTs } : {}) }) });
  const raw = await response.text().catch(() => ''); let parsed: Record<string, unknown> = {};
  try { parsed = record(JSON.parse(raw)); } catch { /* handled below */ }
  if (!response.ok || parsed.ok !== true) throw new ChannelPayloadError(`Slack refused the message (${response.status}).`);
  return text(parsed.ts);
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
