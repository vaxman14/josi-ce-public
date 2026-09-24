import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '@josi-ce/core';

export const SESSION_COOKIE = 'josi_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export interface SessionUser {
  id: string;
  email: string;
  username: string;
  /** CE has no operator above the workspace. `super_admin` sets policy for the
   * installation; `member` uses the product. Neither implies access to another
   * person's private resources — see core/ownership.ts. */
  role: 'super_admin' | 'member';
  display_name: string | null;
  status: 'active' | 'disabled';
  session_id: string;
}

/** The cookie value never touches the database. We store sha256(token), so a
 * dump of `sessions` cannot be replayed as a login. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  db: Db,
  args: { userId: string; ip?: string | null; userAgent?: string | null; ttlSeconds?: number },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = newToken();
  const ttl = args.ttlSeconds ?? SESSION_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const rows = await db.query<{ id: string }>(
    `insert into sessions (user_id, token_hash, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [args.userId, hashToken(token), args.ip ?? null, (args.userAgent ?? '').slice(0, 400) || null, expiresAt.toISOString()],
  );
  return { token, sessionId: rows[0].id, expiresAt };
}

/** Resolve a cookie to a live user. Disabled users and revoked/expired
 * sessions resolve to null — the check is one query so it cannot drift. */
export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db.query<SessionUser>(
    `select u.id, u.email, u.username, u.role, u.display_name, u.status, s.id as session_id
     from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
       and u.status = 'active'
     limit 1`,
    [hashToken(token)],
  );
  if (!rows.length) return null;
  await db.query(`update sessions set last_seen_at = now() where id = $1`, [rows[0].session_id]);
  return rows[0];
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query(`update sessions set revoked_at = now() where id = $1 and revoked_at is null`, [sessionId]);
  // A revoked login must not leave a five-minute Vault authorization alive.
  await db.query(`delete from vault_unlocks where session_id = $1`, [sessionId]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<number> {
  const rows = await db.query(
    `update sessions set revoked_at = now() where user_id = $1 and revoked_at is null returning id`,
    [userId],
  );
  await db.query(`delete from vault_unlocks where user_id = $1`, [userId]);
  return rows.length;
}

export interface SessionRow {
  id: string;
  user_id: string;
  email: string;
  username: string;
  role: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export async function listActiveSessions(db: Db): Promise<SessionRow[]> {
  return db.query<SessionRow>(
    `select s.id, s.user_id, u.email, u.username, u.role, s.ip, s.user_agent,
            s.created_at, s.last_seen_at, s.expires_at
     from sessions s join users u on u.id = s.user_id
     where s.revoked_at is null and s.expires_at > now()
     order by s.last_seen_at desc limit 500`,
  );
}

/** Constant-time compare for anything derived from user input. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
