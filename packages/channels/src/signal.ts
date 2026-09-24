import { createHmac } from 'node:crypto';
import { ChannelPayloadError, secureEqual, type NormalizedMessage } from './shared.js';

export const SIGNAL_RISK_NOTICE = 'Signal has no official bot or business API. This integration requires a self-hosted bridge, may stop working after Signal changes, and may put the linked Signal account at risk.';

export function verifySignalBridge(rawBody: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string') return false;
  return secureEqual(signature, createHmac('sha256', secret).update(rawBody).digest('hex'));
}

export function normalizeSignal(payload: unknown): NormalizedMessage[] {
  const root = record(payload); const envelope = record(root.envelope); const data = record(envelope.dataMessage);
  const source = text(envelope.sourceNumber) || text(envelope.sourceUuid); const timestamp = String(envelope.timestamp ?? '');
  if (!source || !timestamp || (!text(data.message) && !array(data.attachments).length)) return [];
  return [{ channel: 'signal', eventId: `${source}:${timestamp}`, externalIdentity: source, conversationId: source, text: text(data.message), replyTo: null, attachmentIds: array(data.attachments).map((item) => text(record(item).id)).filter(Boolean) }];
}

export async function sendSignal(args: { bridgeUrl: string; account: string; recipient: string; text: string; secret: string; fetchImpl?: typeof fetch }): Promise<void> {
  const body = JSON.stringify({ account: args.account, recipients: [args.recipient], message: args.text });
  const response = await (args.fetchImpl ?? fetch)(`${args.bridgeUrl.replace(/\/$/, '')}/v2/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Josi-Signature': createHmac('sha256', args.secret).update(body).digest('hex') }, body });
  if (!response.ok) throw new ChannelPayloadError(`The Signal bridge refused the message (${response.status}).`);
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
