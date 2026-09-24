import type { Db } from '@josi-ce/core';
import { hashToken, newToken } from './sessions.js';

export type TokenPurpose = 'invite' | 'reset';

export const RESET_TTL_SECONDS = 60 * 60; // 1 hour, per spec
export const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** One-time email token. Same storage rule as sessions: only the hash lands in
 * the table, so the link in the mailbox is the only copy of the secret. */
export async function issueAuthToken(
  db: Db,
  args: { userId: string; purpose: TokenPurpose; ttlSeconds?: number },
): Promise<{ token: string; expiresAt: Date }> {
  const ttl = args.ttlSeconds ?? (args.purpose === 'reset' ? RESET_TTL_SECONDS : INVITE_TTL_SECONDS);
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttl * 1000);
  // Outstanding tokens of the same purpose are burned: issuing a new reset
  // link must invalidate the one that might be sitting in an old email.
  await db.query(
    `update auth_tokens set used_at = now()
     where user_id = $1 and purpose = $2 and used_at is null`,
    [args.userId, args.purpose],
  );
  await db.query(
    `insert into auth_tokens (user_id, token_hash, purpose, expires_at) values ($1, $2, $3, $4)`,
    [args.userId, hashToken(token), args.purpose, expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export interface RedeemedToken {
  user_id: string;
  purpose: TokenPurpose;
  email: string;
  username: string;
}

/** Look up a token without consuming it (used to render the set-password form). */
export async function peekAuthToken(db: Db, token: string): Promise<RedeemedToken | null> {
  const rows = await db.query<RedeemedToken>(
    `select t.user_id, t.purpose, u.email, u.username
     from auth_tokens t join users u on u.id = t.user_id
     where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
     limit 1`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

/** Consume atomically. The `used_at is null and expires_at > now()` predicate
 * lives in the UPDATE so two racing redemptions cannot both win. */
export async function consumeAuthToken(db: Db, token: string): Promise<RedeemedToken | null> {
  const rows = await db.query<{ user_id: string; purpose: TokenPurpose }>(
    `update auth_tokens set used_at = now()
     where token_hash = $1 and used_at is null and expires_at > now()
     returning user_id, purpose`,
    [hashToken(token)],
  );
  if (!rows.length) return null;
  const u = await db.query<{ email: string; username: string }>(
    `select email, username from users where id = $1`,
    [rows[0].user_id],
  );
  return { user_id: rows[0].user_id, purpose: rows[0].purpose, email: u[0]?.email ?? '', username: u[0]?.username ?? '' };
}
