// Linking a Telegram chat to a CE account.
//
// This is the only bridge between "a number in an inbound webhook" and "a
// person with an account", so it is the whole trust story of the channel and
// everything else here assumes it is right.
//
// THE CODE IS A BEARER CREDENTIAL. It converts, on presentation, into an
// authenticated channel that can talk to somebody's assistant. So it gets the
// treatment Phase 1 gave session tokens, point for point:
//
//   * 160 bits from a CSPRNG. Not a six-digit number a person types — a code
//     that arrives by a deep link does not need to be short, and a short code
//     is guessable at Telegram's message rate.
//   * Stored as a SHA-256 hash. A database dump, a screenshot in a support
//     ticket, or a log line yields nothing redeemable.
//   * Single use, enforced by a conditional UPDATE rather than a read-then-
//     write, so two simultaneous redemptions cannot both win.
//   * Short TTL, because the window in which a leaked code matters should be
//     minutes.
//   * Invalidated on unlink and on minting a replacement, so an old code
//     sitting in a chat history is dead rather than dormant.
//
// AND THE REVERSE DIRECTION. A code proves that whoever holds it was shown it
// by a signed-in session. It does NOT prove anything about the Telegram account
// redeeming it — so the link records which Telegram account claimed it, and the
// person is told, in the web app and in the chat, which account is now linked.
// A stolen code is therefore visible rather than silent.
import { appendEvent, type Db } from '@josi-ce/core';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class LinkError extends Error {
  constructor(message: string, readonly reason:
    | 'unknown_code' | 'expired' | 'already_used' | 'invalidated'
    | 'chat_taken' | 'not_linked' | 'not_yours') {
    super(message);
  }
}

/** Fifteen minutes. Long enough to switch to Telegram and tap a link, short
 * enough that a code left on a screen stops mattering quickly. */
export const LINK_CODE_TTL_SECONDS = 15 * 60;

/** 20 bytes = 160 bits, base64url. */
export function generateLinkCode(): string {
  return randomBytes(20).toString('base64url');
}

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests.
 *
 * The lookup below is by hash and therefore already constant-ish, but this is
 * used where a candidate is compared against a stored value, and a length-aware
 * early return in `===` is exactly the leak that makes a hash comparison
 * pointless. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface MintedCode {
  /** The plaintext code. Returned once, to the signed-in user who asked, and
   * never stored anywhere it could be read back. */
  code: string;
  expiresAt: string;
  /** `https://t.me/<bot>?start=<code>` when the bot's username is known, so the
   * person taps rather than types. Null when no bot is configured yet. */
  deepLink: string | null;
}

/**
 * Mint a code for a signed-in user.
 *
 * Minting invalidates that person's outstanding codes first. Two live codes for
 * one account is one more than anybody needs, and the alternative — a code from
 * a previous attempt still working — is exactly the loose end that makes "I
 * revoked it" untrue.
 */
export async function mintLinkCode(
  db: Db,
  args: { userId: string; botUsername: string | null; ttlSeconds?: number },
): Promise<MintedCode> {
  await invalidateCodesFor(db, args.userId);

  const code = generateLinkCode();
  const ttl = args.ttlSeconds ?? LINK_CODE_TTL_SECONDS;
  const [row] = await db.query<{ expires_at: string }>(
    `insert into telegram_link_codes (user_id, code_hash, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     returning expires_at`,
    [args.userId, hashLinkCode(code), ttl],
  );

  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'telegram.link_code_minted',
    subjectType: 'user',
    subjectId: args.userId,
    // No code, no hash. That a code was minted is metadata; the code is not.
    payload: { ttlSeconds: ttl },
  });

  return {
    code,
    expiresAt: row.expires_at,
    deepLink: args.botUsername ? `https://t.me/${args.botUsername}?start=${code}` : null,
  };
}

export async function invalidateCodesFor(db: Db, userId: string): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update telegram_link_codes set invalidated_at = now()
     where user_id = $1 and used_at is null and invalidated_at is null
     returning id`,
    [userId],
  );
  return rows.length;
}

export interface LinkResult {
  userId: string;
  linkId: string;
  chatId: number;
}

/**
 * Redeem a code and create the link.
 *
 * Every refusal below is a separate `reason`, and the caller turns all of them
 * into the SAME sentence for the chat. Telling a stranger in a Telegram window
 * that a code "has expired" rather than "is unknown" confirms that the code was
 * real, which is a probing oracle for anybody trying codes.
 *
 * The single-use guarantee is the conditional UPDATE: `used_at is null` is part
 * of the WHERE clause, so the database decides the winner. Phase 3 learned this
 * the hard way — an application-level check around a read cannot be tested for
 * concurrency under pglite, and the fix was to make the SQL itself the latch.
 */
export async function redeemLinkCode(
  db: Db,
  args: {
    code: string;
    chatId: number;
    telegramUserId?: number | null;
    telegramUsername?: string | null;
  },
): Promise<LinkResult> {
  const hash = hashLinkCode(args.code);

  // Claim the code first, atomically. Nothing about the chat is touched until
  // this succeeds, so a failed redemption leaves no trace to probe.
  const claimed = await db.query<{ id: string; user_id: string }>(
    `update telegram_link_codes
     set used_at = now(), used_by_chat_id = $2
     where code_hash = $1
       and used_at is null
       and invalidated_at is null
       and expires_at > now()
     returning id, user_id`,
    [hash, args.chatId],
  );

  if (!claimed.length) {
    // Work out WHY only for the audit log, which an administrator reads. The
    // caller still gets one indistinguishable refusal.
    const [existing] = await db.query<{
      used_at: string | null; invalidated_at: string | null; expired: boolean;
    }>(
      `select used_at, invalidated_at, expires_at <= now() as expired
       from telegram_link_codes where code_hash = $1`,
      [hash],
    );
    const reason = !existing ? 'unknown_code'
      : existing.used_at ? 'already_used'
      : existing.invalidated_at ? 'invalidated'
      : 'expired';
    await appendEvent(db, {
      actor: 'system',
      kind: 'telegram.link_refused',
      subjectType: 'telegram_chat',
      subjectId: String(args.chatId),
      payload: { reason },
    });
    throw new LinkError('that link code cannot be used', reason);
  }

  const { user_id: userId } = claimed[0];

  // A chat may belong to exactly one account. The partial unique index enforces
  // it; this check turns the constraint violation into a sentence, and the
  // re-link case (same person, same chat) into a no-op rather than an error.
  const [existingLink] = await db.query<{ id: string; user_id: string }>(
    `select id, user_id from telegram_links where chat_id = $1 and status = 'active'`,
    [args.chatId],
  );
  if (existingLink && existingLink.user_id !== userId) {
    await appendEvent(db, {
      actor: 'system',
      kind: 'telegram.link_refused',
      subjectType: 'telegram_chat',
      subjectId: String(args.chatId),
      payload: { reason: 'chat_taken' },
    });
    throw new LinkError(
      'that Telegram chat is already linked to a different account on this installation',
      'chat_taken',
    );
  }

  if (existingLink) {
    await db.query(
      `update telegram_links set telegram_user_id = $2, telegram_username = $3 where id = $1`,
      [existingLink.id, args.telegramUserId ?? null, args.telegramUsername ?? null],
    );
    return { userId, linkId: existingLink.id, chatId: args.chatId };
  }

  const [link] = await db.query<{ id: string }>(
    `insert into telegram_links (user_id, chat_id, telegram_user_id, telegram_username)
     values ($1, $2, $3, $4) returning id`,
    [userId, args.chatId, args.telegramUserId ?? null, args.telegramUsername ?? null],
  );

  await appendEvent(db, {
    actorUserId: userId,
    actor: 'user',
    kind: 'telegram.linked',
    subjectType: 'telegram_link',
    subjectId: link.id,
    // The Telegram @username is the linking account's own public handle, and
    // the person needs to see it to notice a link they did not make.
    payload: { telegramUsername: args.telegramUsername ?? null },
  });

  return { userId, linkId: link.id, chatId: args.chatId };
}

export interface LinkRow {
  id: string;
  user_id: string;
  chat_id: string;
  telegram_username: string | null;
  /** The conversation this chat feeds. Null until the first message creates it. */
  thread_id: string | null;
  status: 'active' | 'revoked';
  linked_at: string;
  revoked_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

/**
 * Resolve an inbound chat id to the account that owns it.
 *
 * `status = 'active'` is in the WHERE clause and not applied afterwards, so a
 * revoked link cannot be resolved by a caller that forgets to check. This is
 * the single function every inbound path goes through, and it is the reason a
 * revocation takes effect on the next message rather than eventually.
 */
export async function resolveChat(db: Db, chatId: number): Promise<LinkRow | null> {
  const [row] = await db.query<LinkRow>(
    `select * from telegram_links where chat_id = $1 and status = 'active'`,
    [chatId],
  );
  return row ?? null;
}

export async function listLinksFor(db: Db, userId: string): Promise<LinkRow[]> {
  return db.query<LinkRow>(
    `select * from telegram_links where user_id = $1 order by linked_at desc`,
    [userId],
  );
}

/**
 * Revoke a link.
 *
 * `actorUserId` is the person doing it and `asAdmin` says on what authority. A
 * member may revoke only their own; a super admin may revoke anybody's, which
 * is L1.8's operator control — and, notably, is the one thing an administrator
 * can do to somebody's Telegram, since they cannot read a word of it.
 */
export async function revokeLink(
  db: Db,
  args: { linkId: string; actorUserId: string; asAdmin?: boolean },
): Promise<LinkRow> {
  const [row] = await db.query<LinkRow>(
    `select * from telegram_links where id = $1`, [args.linkId],
  );
  if (!row) throw new LinkError('no such link', 'not_linked');
  if (!args.asAdmin && row.user_id !== args.actorUserId) {
    // 'not_yours' becomes a 404 at the route, for the reason `requireOwnership`
    // gives: 403 would confirm somebody else has this link id.
    throw new LinkError('no such link', 'not_yours');
  }
  if (row.status === 'revoked') return row;

  const [updated] = await db.query<LinkRow>(
    `update telegram_links set status = 'revoked', revoked_at = now(), revoked_by = $2
     where id = $1 returning *`,
    [args.linkId, args.actorUserId],
  );
  // Outstanding codes go too. Revoking a link and leaving a live code is
  // revocation that lasts until somebody taps an old message.
  await invalidateCodesFor(db, row.user_id);

  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.asAdmin ? 'super_admin' : 'user',
    kind: 'telegram.unlinked',
    subjectType: 'telegram_link',
    subjectId: args.linkId,
    payload: { byAdmin: !!args.asAdmin },
  });
  return updated;
}

/** Housekeeping: codes that can never be redeemed again are dead weight, and
 * keeping a used code's hash forever is keeping a record of a credential. */
export async function pruneLinkCodes(db: Db, olderThanSeconds = 86_400): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `delete from telegram_link_codes
     where created_at < now() - make_interval(secs => $1)
     returning id`,
    [olderThanSeconds],
  );
  return rows.length;
}
