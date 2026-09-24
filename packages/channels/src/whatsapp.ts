import { createHmac } from 'node:crypto';
import { ChannelPayloadError, secureEqual, type NormalizedMessage } from './shared.js';

export function verifyWhatsAppSignature(rawBody: Buffer, signature: unknown, appSecret: string): boolean {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  return secureEqual(signature, `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`);
}

export function verifyWhatsAppChallenge(query: Record<string, unknown>, token: string): string | null {
  return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === token && typeof query['hub.challenge'] === 'string'
    ? query['hub.challenge'] : null;
}

export function normalizeWhatsApp(payload: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const entries = asArray(asRecord(payload).entry);
  for (const entry of entries) for (const change of asArray(asRecord(entry).changes)) {
    const value = asRecord(asRecord(change).value);
    for (const raw of asArray(value.messages)) {
      const message = asRecord(raw); const from = string(message.from); const id = string(message.id);
      if (!from || !id) continue;
      const type = string(message.type); const typed = asRecord(message[type]);
      const text = type === 'text' ? string(typed.body) : string(asRecord(message.button).text) || string(asRecord(message.interactive).button_reply && asRecord(asRecord(message.interactive).button_reply).title);
      out.push({ channel: 'whatsapp', eventId: id, externalIdentity: from, conversationId: from, text, replyTo: string(asRecord(message.context).id) || null, attachmentIds: ['image','audio','video','document','sticker'].includes(type) && string(typed.id) ? [string(typed.id)] : [] });
    }
  }
  return out;
}

export async function sendWhatsApp(args: { phoneNumberId: string; token: string; to: string; text: string; fetchImpl?: typeof fetch }): Promise<string> {
  const response = await (args.fetchImpl ?? fetch)(`https://graph.facebook.com/v23.0/${encodeURIComponent(args.phoneNumberId)}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: args.to, type: 'text', text: { body: args.text, preview_url: false } }) });
  const raw = await response.text().catch(() => ''); if (!response.ok) throw new ChannelPayloadError(`WhatsApp refused the message (${response.status}).`);
  try { return string(asArray(asRecord(JSON.parse(raw)).messages)[0] && asRecord(asArray(asRecord(JSON.parse(raw)).messages)[0]).id); } catch { return ''; }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
