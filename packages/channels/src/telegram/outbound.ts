// Sending, with the retries and the record of what happened.
//
// Split out from `inbound.ts` so the routing logic can be tested with a `send`
// that does nothing, and so the retry policy has one home. The interesting
// decisions here are about what NOT to retry and what to do when a person has
// blocked the bot.
import { appendEvent, type Db } from '@josi-ce/core';
import { TelegramApiError, TelegramBotApi, withRetry, type RetryOptions } from './api.js';

export interface SenderDeps {
  db: Db;
  api: TelegramBotApi;
  retry?: RetryOptions;
}

/**
 * Send one chunk, retrying what is worth retrying, and record the attempt.
 *
 * BLOCKED IS NOT A FAILURE TO RETRY. When a person blocks the bot, every future
 * send to that chat fails identically and forever. Retrying it three times per
 * message turns one person's decision into a steady stream of requests against
 * the installation's rate limit, so `blocked_by_user` and `chat_not_found`
 * revoke the link instead: the channel is genuinely gone, and the person will
 * see it as unlinked in Josi rather than as silently broken.
 */
export async function sendChunk(
  deps: SenderDeps,
  args: {
    chatId: number;
    text: string;
    userId?: string | null;
    kind?: 'reply' | 'notice' | 'refusal';
  },
): Promise<void> {
  const [row] = await deps.db.query<{ id: string }>(
    `insert into telegram_outbound (chat_id, user_id, kind, body_chars)
     values ($1, $2, $3, $4) returning id`,
    [args.chatId, args.userId ?? null, args.kind ?? 'reply', args.text.length],
  );

  let attempts = 0;
  try {
    await withRetry(async () => {
      attempts += 1;
      await deps.api.sendMessage({
        chatId: args.chatId, text: args.text, parseMode: 'MarkdownV2',
      });
    }, deps.retry);
  } catch (err) {
    const category = err instanceof TelegramApiError ? err.category : 'unknown';
    await deps.db.query(
      `update telegram_outbound set state = 'failed', attempts = $2, error_category = $3
       where id = $1`,
      [row.id, attempts, category],
    );
    await appendEvent(deps.db, {
      actorUserId: args.userId ?? null,
      actor: 'system',
      kind: 'telegram.send_failed',
      subjectType: 'telegram_chat',
      subjectId: String(args.chatId),
      // A category. Telegram's description can quote the request, and the
      // request URL carries the bot token.
      payload: { category, attempts },
    });

    if (category === 'blocked_by_user' || category === 'chat_not_found') {
      await revokeForDeadChat(deps.db, args.chatId, category);
    }
    throw err;
  }

  await deps.db.query(
    `update telegram_outbound set state = 'sent', attempts = $2, sent_at = now() where id = $1`,
    [row.id, attempts],
  );
}

/** The chat is gone. Mark the link revoked so the web app tells the truth about
 * it, and so nothing keeps trying. */
async function revokeForDeadChat(db: Db, chatId: number, reason: string): Promise<void> {
  const rows = await db.query<{ id: string; user_id: string }>(
    `update telegram_links set status = 'revoked', revoked_at = now()
     where chat_id = $1 and status = 'active'
     returning id, user_id`,
    [chatId],
  );
  for (const row of rows) {
    await appendEvent(db, {
      actorUserId: row.user_id,
      actor: 'system',
      kind: 'telegram.unlinked',
      subjectType: 'telegram_link',
      subjectId: row.id,
      payload: { reason },
    });
  }
}
