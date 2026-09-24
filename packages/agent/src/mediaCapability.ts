import { appendEvent, type Db } from '@josi-ce/core';

export type ImageIntent = 'capability' | 'generate' | 'edit' | 'status';

export interface MediaRequestMeta {
  v: 1;
  id: string;
  media: 'image';
  intent: ImageIntent;
  refers_to?: string;
}

export interface MediaResultMeta {
  v: 1;
  request_id: string;
  media: 'image';
  intent: ImageIntent;
  status: 'unavailable';
  error: 'image_generation_unavailable';
}

export interface PriorMediaResult {
  request: MediaRequestMeta;
  result: MediaResultMeta;
}

const IMAGE_NOUN = '(?:images?|pictures?|photos?|artwork|illustrations?|graphics?|logos?|avatars?|icons?|banners?|posters?|wallpapers?)';
const GENERATE_VERB = '(?:generate|create|make|draw|render|design|produce)';
const EDIT_VERB = '(?:edit|modify|change|retouch|remove|replace|recolor|resize|crop|upscale)';

const CAPABILITY_PATTERNS = [
  new RegExp(`\\b(?:can|could)\\s+(?:you|josi)\\s+(?:actually\\s+)?(?:${GENERATE_VERB}|${EDIT_VERB})\\s+(?:an?\\s+|some\\s+)?${IMAGE_NOUN}\\b`, 'i'),
  new RegExp(`\\b(?:do|does)\\s+(?:you|josi)\\s+(?:support|have)\\s+(?:the\\s+ability\\s+to\\s+)?(?:image\\s+generation|${IMAGE_NOUN})\\b`, 'i'),
  /\b(?:is|are)\s+(?:image generation|image editing)\s+(?:available|supported|enabled)\b/i,
];
const GENERATE_PATTERN = new RegExp(`\\b${GENERATE_VERB}\\s+(?:me\\s+)?(?:an?\\s+|some\\s+|the\\s+)?${IMAGE_NOUN}\\b`, 'i');
const EDIT_PATTERN = new RegExp(`\\b${EDIT_VERB}\\s+(?:this|that|the|my|an?)?\\s*${IMAGE_NOUN}\\b`, 'i');
const STATUS_PATTERN = /^(?:so\s+)?(?:where\s+is\s+(?:it|the\s+(?:image|picture|photo))|where(?:'s| is)\s+(?:my|the)\s+(?:image|picture|photo)|is\s+it\s+(?:done|ready)|did\s+(?:it|the\s+(?:image|picture|photo))\s+(?:finish|work)|what(?:'s| is)\s+(?:its|the)\s+status|status\??)\s*[?.!]*$/i;

export function classifyImageIntent(text: string): Exclude<ImageIntent, 'status'> | null {
  const value = text.trim().slice(0, 8_000);
  if (!value) return null;
  if (CAPABILITY_PATTERNS.some((pattern) => pattern.test(value))) return 'capability';
  if (EDIT_PATTERN.test(value)) return 'edit';
  if (GENERATE_PATTERN.test(value)) return 'generate';
  return null;
}

export function isImmediateMediaStatusFollowup(text: string): boolean {
  return STATUS_PATTERN.test(text.trim());
}

/**
 * Returns media state only when it belongs to this owner and thread and is the
 * immediately preceding assistant result. The optional current inbound id is
 * ignored because the web route persists it before entering the agent; any
 * other intervening message breaks the binding.
 */
export async function immediatePriorMediaResult(
  db: Db,
  args: { ownerUserId: string; threadId: string; currentInboundMessageId?: string },
): Promise<PriorMediaResult | null> {
  const rows = await db.query<{ id: string; direction: 'in' | 'out'; meta: Record<string, unknown> }>(
    `select m.id,m.direction,m.meta from messages m
       join threads t on t.id=m.thread_id
      where m.thread_id=$1 and t.owner_user_id=$2
        and ($3::uuid is null or m.id<>$3::uuid)
      order by m.created_at desc,m.id desc limit 1`,
    [args.threadId, args.ownerUserId, args.currentInboundMessageId ?? null],
  );
  const row = rows[0];
  if (!row || row.direction !== 'out') return null;
  const raw = row.meta?.media_result;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = raw as Partial<MediaResultMeta>;
  if (result.v !== 1 || result.media !== 'image' || result.status !== 'unavailable'
      || result.error !== 'image_generation_unavailable' || typeof result.request_id !== 'string'
      || !['capability', 'generate', 'edit', 'status'].includes(String(result.intent))) return null;
  const request: MediaRequestMeta = {
    v: 1,
    id: result.request_id,
    media: 'image',
    intent: result.intent as ImageIntent,
  };
  return { request, result: result as MediaResultMeta };
}

export const IMAGE_GENERATION_UNAVAILABLE =
  'Image generation is unavailable on this installation. No image was created or attached.';

export async function auditUnsupportedImageIntent(
  db: Db,
  args: { ownerUserId: string; threadId: string; intent: ImageIntent },
): Promise<void> {
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'agent',
    kind: 'agent.unsupported_capability_attempt',
    subjectType: 'thread',
    subjectId: args.threadId,
    payload: { capability: 'image_generation', intent: args.intent },
  });
}
