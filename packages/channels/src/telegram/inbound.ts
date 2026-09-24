// What happens when Telegram POSTs an update.
//
// This is the untrusted edge of the channel and it reads in the order the
// checks have to happen. Every early return below is a refusal that costs
// nothing — no database write beyond de-duplication, no model call, no reply —
// because the cheapest thing an unauthenticated caller can make us do should be
// nothing at all.
//
//   authenticity  → the secret header, compared in constant time
//   idempotence   → update_id, so a re-delivery is not a second answer
//   shape         → a private message, from a real user, with text
//   identity      → an ACTIVE link, or the one command that can create one
//   allowance     → a rate limit keyed on the chat, not on a user we may not have
//   the turn       → run as the LINKED USER, never as anyone named in the payload
//
// The last line is the one to hold on to. Nothing in an inbound update decides
// whose account is used. The `from` object in a Telegram message is chosen by
// whoever sent it, and it is used for exactly two things — a display handle and
// an audit note — neither of which is a permission.
import {
  LIMITS, addMessage, appendEvent, consume, createThread, listMessages, markActionsPresented, recordExchange,
  type Db,
} from '@josi-ce/core';
import { timingSafeEqual } from 'node:crypto';
import { LinkError, redeemLinkCode, resolveChat, type LinkRow } from './linking.js';
import { prepareOutbound } from './format.js';
import { checkAttachment, recordAttachment, type IncomingAttachment } from './attachments.js';

/** What the caller must supply. Everything that touches the outside world is an
 * argument, so a test drives the whole path without a network or a model. */
export interface InboundDeps {
  db: Db;
  /** Sends one already-escaped chunk to a chat. Retries live in the caller's
   * implementation, so this function stays about routing. */
  send: (args: { chatId: number; text: string; kind?: 'reply' | 'notice' | 'refusal' }) => Promise<void>;
  /** Runs one assistant turn for a user. Injected so this module does not
   * depend on the agent package, and so a routing test needs no model. */
  runTurn: (args: {
    userId: string; threadId: string; inbound: string;
  }) => Promise<{ reply: string; refusal?: { message: string }; actions?: Array<{ tool: string; result: unknown }>;
    retry?: object; mediaRequest?: object; mediaResult?: object }>;
  /** M41's disclosure, read from the mail policy so the wording an operator
   * customised once applies to every channel. */
  disclosure: string;
  attachments: { enabled: boolean; maxBytes: number };
  /** The bot's own username, for the linking instructions. */
  botUsername: string | null;
}

export type InboundOutcome =
  | 'accepted' | 'unlinked' | 'not_private' | 'ignored' | 'refused' | 'failed';

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    date?: number;
    chat?: { id?: number; type?: string };
    from?: { id?: number; is_bot?: boolean; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    document?: { file_id?: string; file_unique_id?: string; file_size?: number; mime_type?: string; file_name?: string };
    photo?: Array<{ file_id?: string; file_unique_id?: string; file_size?: number }>;
    voice?: unknown;
    video?: unknown;
    audio?: unknown;
    sticker?: unknown;
  };
}

/**
 * Constant-time comparison of the webhook secret.
 *
 * `===` on a secret leaks its length and its common prefix through timing. The
 * amount of information that leaks over a network is small; the cost of doing
 * it properly is one function, so there is no trade to make.
 *
 * A missing header is `false` without comparing anything, and the lengths are
 * checked first because `timingSafeEqual` throws on a mismatch — which would
 * itself be a length oracle if it were allowed to reach an error handler that
 * behaves differently.
 */
export function webhookSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** One indistinguishable refusal for every way a link code can fail. Telling a
 * stranger that a code "expired" rather than "is unknown" confirms it was real. */
const LINK_REFUSED =
  'That link code cannot be used. Open Josi in your browser, go to Settings → Telegram, '
  + 'and start a new link.';

const NOT_LINKED_HINT =
  'This chat is not linked to a Josi account. Sign in to Josi in your browser, '
  + 'go to Settings → Telegram, and tap the link it gives you.';

/**
 * Handle one update.
 *
 * Always resolves. A webhook handler that throws makes Telegram redeliver, and
 * redelivering something that failed deterministically is a loop — Phase 8 named
 * loop prevention as a requirement for mail and the same reasoning applies to a
 * channel that retries on our behalf. So every failure is recorded, answered
 * where there is somebody to answer, and reported as an outcome rather than
 * raised.
 */
export async function handleUpdate(
  deps: InboundDeps,
  update: TelegramUpdate,
): Promise<InboundOutcome> {
  const { db } = deps;

  // ---- idempotence -------------------------------------------------------
  // Before anything else that costs. Telegram redelivers until it gets a 2xx,
  // and a slow model call is exactly the case that produces a redelivery — so
  // without this, the expensive path is the one that runs twice.
  const updateId = typeof update.update_id === 'number' ? update.update_id : null;
  const message = update.message;
  const chatId = typeof message?.chat?.id === 'number' ? message.chat.id : null;

  if (updateId !== null) {
    const claimed = await db.query<{ update_id: string }>(
      `insert into telegram_updates (update_id, chat_id) values ($1, $2)
       on conflict (update_id) do nothing
       returning update_id`,
      [updateId, chatId],
    );
    if (!claimed.length) return 'ignored';
  }

  const finish = async (outcome: InboundOutcome): Promise<InboundOutcome> => {
    if (updateId !== null) {
      await db.query(`update telegram_updates set outcome = $2 where update_id = $1`,
        [updateId, outcome]);
    }
    return outcome;
  };

  // ---- shape -------------------------------------------------------------
  if (!message || chatId === null) return finish('ignored');

  // GROUPS ARE REFUSED. A group chat has no single owner, so routing a group
  // message to one person's assistant would let everyone else in that group
  // talk as them — and Phase 8 already named the unowned-inbox failure. There
  // is no group mode to configure, which is the strongest form of this rule.
  if (message.chat?.type !== 'private') {
    await appendEvent(db, {
      actor: 'system', kind: 'telegram.refused', subjectType: 'telegram_chat',
      subjectId: String(chatId), payload: { reason: 'not_private', chatType: message.chat?.type ?? 'unknown' },
    });
    return finish('not_private');
  }
  // A message from another bot is not a person and cannot have linked.
  if (message.from?.is_bot) return finish('ignored');

  const text = (message.text ?? message.caption ?? '').trim();

  // ---- allowance ---------------------------------------------------------
  // Keyed on the chat, because an unlinked chat has no user to charge. Spent
  // BEFORE the link lookup so that hammering an unlinked chat is also limited.
  const allowance = await consume(db, {
    limit: LIMITS.telegram_inbound, subject: `chat:${chatId}`,
  });
  if (!allowance.ok) {
    // Silence rather than a "slow down" reply: answering a flood is
    // participating in it, and the person doing it is not reading.
    await appendEvent(db, {
      actor: 'system', kind: 'telegram.rate_limited', subjectType: 'telegram_chat',
      subjectId: String(chatId), payload: { retryAfterSeconds: allowance.retryAfterSeconds },
    });
    return finish('refused');
  }

  // ---- identity ----------------------------------------------------------
  let link = await resolveChat(db, chatId);

  // `/start <code>` is the ONLY thing an unlinked chat may do.
  const startCode = parseStartCommand(text);
  if (startCode !== null) {
    if (link) {
      await deps.send({ chatId, kind: 'notice', text: 'This chat is already linked to your Josi account.' });
      return finish('accepted');
    }
    const codeAllowance = await consume(db, {
      limit: LIMITS.telegram_link, subject: `chat:${chatId}`,
    });
    if (!codeAllowance.ok) return finish('refused');

    if (!startCode) {
      await deps.send({ chatId, kind: 'notice', text: NOT_LINKED_HINT });
      return finish('unlinked');
    }
    try {
      const result = await redeemLinkCode(db, {
        code: startCode,
        chatId,
        telegramUserId: message.from?.id ?? null,
        telegramUsername: message.from?.username ?? null,
      });
      link = await resolveChat(db, chatId);
      await deps.send({
        chatId, kind: 'notice',
        text: 'This chat is now linked to your Josi account. Send a message and Josi will answer here.',
      });
      void result;
      return finish('accepted');
    } catch (err) {
      if (err instanceof LinkError) {
        await deps.send({ chatId, kind: 'refusal', text: LINK_REFUSED });
        return finish('refused');
      }
      throw err;
    }
  }

  if (!link) {
    await deps.send({ chatId, kind: 'notice', text: NOT_LINKED_HINT });
    return finish('unlinked');
  }

  // ---- commands ----------------------------------------------------------
  const command = parseCommand(text);
  if (command === '/help') {
    await deps.send({
      chatId, kind: 'notice',
      text: 'Send a message and Josi answers here, as you. '
        + 'Use /unlink to disconnect this chat. '
        + 'Everything else happens in Josi in your browser.',
    });
    return finish('accepted');
  }
  if (command === '/unlink') {
    // Unlinking from inside the chat, which is where somebody who has lost
    // access to the web app will reach for it.
    const { revokeLink } = await import('./linking.js');
    await revokeLink(db, { linkId: link.id, actorUserId: link.user_id });
    await deps.send({
      chatId, kind: 'notice',
      text: 'This chat is no longer linked. Josi will not answer here until you link it again.',
    });
    return finish('accepted');
  }

  // ---- attachments -------------------------------------------------------
  const attachment = extractAttachment(message);
  if (attachment) {
    const verdict = checkAttachment(attachment, deps.attachments);
    await recordAttachment(db, {
      chatId, userId: link.user_id, attachment, verdict,
    });
    if (!verdict.ok) {
      await deps.send({ chatId, kind: 'refusal', text: verdict.message });
      // A refused attachment with a caption still leaves a question worth
      // answering, so fall through when there are words; stop when there are not.
      if (!text) return finish('refused');
    }
  }
  // Anything Telegram sends that is not text and not a file CE accepts —
  // voice, video, stickers — is refused by name rather than ignored, because
  // silence reads as a broken bot.
  if (!text && !attachment && hasUnsupportedMedia(message)) {
    await deps.send({
      chatId, kind: 'refusal',
      text: 'Josi cannot read that kind of message yet. Send text, or a document.',
    });
    return finish('refused');
  }
  if (!text) return finish('ignored');

  // ---- the turn ----------------------------------------------------------
  const threadId = await threadFor(db, link);
  await db.query(`update telegram_links set last_inbound_at = now() where id = $1`, [link.id]);

  let result: { reply: string; refusal?: { message: string }; actions?: Array<{ tool: string; result: unknown }>;
    retry?: unknown; mediaRequest?: object; mediaResult?: object };
  try {
    result = await deps.runTurn({ userId: link.user_id, threadId, inbound: text });
  } catch (err) {
    console.error('telegram turn failed', (err as Error).message);
    await addMessage(db, { threadId, direction: 'in', body: text, channel: 'telegram' });
    await deps.send({
      chatId, kind: 'refusal',
      text: 'Something went wrong on the Josi side. Nothing was lost — try again in a moment.',
    });
    return finish('failed');
  }

  if (result.refusal) {
    // Recorded so the conversation is not missing what the person said, and
    // relayed verbatim. A refusal is never dressed up as an answer.
    await addMessage(db, { threadId, direction: 'in', body: text, channel: 'telegram' });
    await deps.send({ chatId, kind: 'refusal', text: result.refusal.message });
    return finish('refused');
  }

  const actionState=(result.actions??[]).find(action=>action.tool==='assistant_action_state'&&action.result&&typeof action.result==='object')?.result as {domain?:unknown}|undefined;
  const outboundMeta:Record<string,unknown>={};
  if(actionState?.domain==='email'||actionState?.domain==='calendar')outboundMeta.action_status_domain=actionState.domain;
  if(result.retry)outboundMeta.retry=result.retry;
  if(result.mediaResult)outboundMeta.media_result=result.mediaResult;
  const exchange = await recordExchange(db, {
    ownerUserId: link.user_id,
    threadId,
    channel: 'telegram',
    inbound: text,
    reply: result.reply,
    inboundMeta: result.mediaRequest ? { media_request: result.mediaRequest } : undefined,
    outboundMeta: Object.keys(outboundMeta).length ? outboundMeta : undefined,
  });
  const presentedTaskIds = (result.actions ?? []).map((action) => action.result)
    .filter((value): value is { state: string; task_id: string } => !!value && typeof value === 'object'
      && ['collecting', 'prepared'].includes(String((value as { state?: unknown }).state))
      && typeof (value as { task_id?: unknown }).task_id === 'string')
    .map((value) => value.task_id);
  await markActionsPresented(db, { ownerUserId: link.user_id, threadId, taskIds: presentedTaskIds, messageId: exchange.outbound.id });

  for (const chunk of prepareOutbound({ body: result.reply, disclosure: deps.disclosure })) {
    await deps.send({ chatId, text: chunk, kind: 'reply' });
  }
  await db.query(`update telegram_links set last_outbound_at = now() where id = $1`, [link.id]);
  return finish('accepted');
}

/**
 * One thread per link, created lazily.
 *
 * The thread is owned by the LINKED USER, which is what makes a Telegram
 * conversation an ordinary CE conversation: it appears in their Conversations
 * list, obeys their sharing, and is covered by backup, export and retention
 * without any of those features knowing Telegram exists.
 */
export async function threadFor(db: Db, link: LinkRow): Promise<string> {
  if (link.thread_id) {
    const [existing] = await db.query<{ id: string }>(
      `select id from threads where id = $1`, [link.thread_id],
    );
    if (existing) return existing.id;
  }
  const thread = await createThread(db, { ownerUserId: link.user_id, title: 'Telegram' });
  await db.query(`update telegram_links set thread_id = $2 where id = $1`, [link.id, thread.id]);
  return thread.id;
}

/** Recent turns, so a Telegram conversation has the same memory a web one does. */
export async function historyFor(db: Db, threadId: string, limit = 40) {
  return (await listMessages(db, { threadId, limit })).map((m) => ({
    role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
    content: m.body,
  }));
}

/** `/start` with an optional payload. Returns null when it is not a start
 * command at all, `''` when it is bare, and the code otherwise.
 *
 * The payload is length-capped before it goes anywhere near a database lookup:
 * a code is 27 characters of base64url and anything longer is not a near miss. */
export function parseStartCommand(text: string): string | null {
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S{1,128}))?$/.exec(text);
  if (!match) return null;
  return match[1] ?? '';
}

export function parseCommand(text: string): string | null {
  const match = /^(\/[a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text.toLowerCase());
  return match ? match[1] : null;
}

/** Pulls the one attachment CE will consider out of a message.
 *
 * A photo arrives as an array of sizes; the LARGEST is taken, because the
 * smaller ones are Telegram's own thumbnails and indexing a thumbnail of
 * somebody's document is worse than indexing nothing. */
export function extractAttachment(
  message: NonNullable<TelegramUpdate['message']>,
): IncomingAttachment | null {
  if (message.document?.file_id) {
    return {
      fileId: message.document.file_id,
      fileUniqueId: message.document.file_unique_id ?? null,
      declaredBytes: message.document.file_size ?? null,
      mimeType: message.document.mime_type ?? null,
      fileName: message.document.file_name ?? null,
    };
  }
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = [...message.photo].sort(
      (a, b) => (a.file_size ?? 0) - (b.file_size ?? 0),
    ).pop();
    if (largest?.file_id) {
      return {
        fileId: largest.file_id,
        fileUniqueId: largest.file_unique_id ?? null,
        declaredBytes: largest.file_size ?? null,
        mimeType: 'image/jpeg',
        fileName: null,
      };
    }
  }
  return null;
}

export function hasUnsupportedMedia(message: NonNullable<TelegramUpdate['message']>): boolean {
  return !!(message.voice || message.video || message.audio || message.sticker);
}
