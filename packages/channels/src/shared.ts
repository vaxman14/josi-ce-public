import { timingSafeEqual } from 'node:crypto';

export type ExternalChannel = 'whatsapp' | 'slack' | 'signal';
export interface NormalizedMessage {
  channel: ExternalChannel;
  eventId: string;
  externalIdentity: string;
  conversationId: string;
  text: string;
  replyTo: string | null;
  attachmentIds: string[];
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ChannelPayloadError extends Error {}
