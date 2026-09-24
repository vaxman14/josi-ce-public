import { appendEvent, type Db } from '@josi-ce/core';
import { hashPassword, verifyPassword } from './passwords.js';
import { checkLoginRate, recordLoginAttempt, type RateVerdict } from './ratelimit.js';
import { revokeAllSessions } from './sessions.js';

export type Role = 'super_admin' | 'member';

export interface User {
  id: string;
  email: string;
  username: string;
  role: Role;
  display_name: string | null;
  status: 'active' | 'disabled';
  last_login_at: string | null;
  created_at: string;
}

const PUBLIC_COLUMNS = `id, email, username, role, display_name, status, last_login_at, created_at`;

export class UserError extends Error {}

/** Creating the super admin is the setup wizard's job and nobody else's. The
 * database enforces uniqueness with a partial index; this returns a sentence a
 * human can act on instead of a constraint name. */
export async function createUser(
  db: Db,
  args: {
    email: string;
    username: string;
    role: Role;
    displayName?: string | null;
    password?: string | null;
  },
): Promise<User> {
  const hash = args.password ? await hashPassword(args.password) : null;
  let rows: User[];
  try {
    rows = await db.query<User>(
      `insert into users (email, username, role, display_name, password_hash)
       values ($1, $2, $3, $4, $5) returning ${PUBLIC_COLUMNS}`,
      [args.email.trim(), args.username.trim(), args.role, args.displayName ?? null, hash],
    );
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/users_email_key/.test(msg)) throw new UserError('that email is already registered');
    if (/users_username_key/.test(msg)) throw new UserError('that username is taken');
    if (/users_one_super_admin/.test(msg)) {
      throw new UserError('this workspace already has a super admin');
    }
    throw err;
  }
  await appendEvent(db, {
    actor: 'system',
    kind: 'user.created',
    subjectType: 'user',
    subjectId: rows[0].id,
    payload: { role: rows[0].role },
  });
  return rows[0];
}

export async function listUsers(db: Db): Promise<User[]> {
  return db.query<User>(`select ${PUBLIC_COLUMNS} from users order by role, created_at`);
}

export async function getUser(db: Db, id: string): Promise<User | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  const rows = await db.query<User>(`select ${PUBLIC_COLUMNS} from users where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findUserByLogin(
  db: Db,
  identifier: string,
): Promise<(User & { password_hash: string | null }) | null> {
  const rows = await db.query<User & { password_hash: string | null }>(
    `select ${PUBLIC_COLUMNS}, password_hash from users
     where lower(email) = lower($1) or lower(username) = lower($1) limit 1`,
    [identifier.trim()],
  );
  return rows[0] ?? null;
}

export async function updateUser(
  db: Db,
  id: string,
  patch: { email?: string; username?: string; displayName?: string; status?: 'active' | 'disabled' },
): Promise<User> {
  const columns: Record<string, unknown> = {
    email: patch.email,
    username: patch.username,
    display_name: patch.displayName,
    status: patch.status,
  };
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [col, val] of Object.entries(columns)) {
    if (val === undefined) continue;
    params.push(typeof val === 'string' ? val.trim() : val);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) {
    const existing = await getUser(db, id);
    if (!existing) throw new UserError('no such user');
    return existing;
  }
  let rows: User[];
  try {
    rows = await db.query<User>(
      `update users set ${sets.join(', ')} where id = $1 returning ${PUBLIC_COLUMNS}`,
      params,
    );
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/users_email_key/.test(msg)) throw new UserError('that email is already registered');
    if (/users_username_key/.test(msg)) throw new UserError('that username is taken');
    throw err;
  }
  if (!rows.length) throw new UserError('no such user');
  // A disabled account must not keep a live cookie.
  if (patch.status === 'disabled') await revokeAllSessions(db, id);
  return rows[0];
}

/** Set a password directly or via a redeemed token. Every change kills existing
 * sessions; the caller re-issues one for the person who just proved themselves. */
export async function setPassword(db: Db, userId: string, plain: string): Promise<void> {
  const hash = await hashPassword(plain);
  const rows = await db.query(`update users set password_hash = $2 where id = $1 returning id`, [userId, hash]);
  if (!rows.length) throw new UserError('no such user');
  await revokeAllSessions(db, userId);
}

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'rate_limited'; verdict: RateVerdict }
  | { ok: false; reason: 'invalid' };

/** The only path that turns a password into an identity. Rate check first, then
 * a constant-shape verify, then the attempt is always recorded. */
export async function login(
  db: Db,
  args: { identifier: string; password: string; ip?: string | null },
): Promise<LoginResult> {
  const ip = args.ip ?? null;
  const verdict = await checkLoginRate(db, args.identifier, ip);
  if (verdict.blocked) return { ok: false, reason: 'rate_limited', verdict };

  const user = await findUserByLogin(db, args.identifier);
  const passwordOk = await verifyPassword(user?.password_hash ?? null, args.password);
  const ok = !!user && user.status === 'active' && passwordOk;

  await recordLoginAttempt(db, { identifier: args.identifier, ip, success: ok });
  if (!ok) return { ok: false, reason: 'invalid' };

  await db.query(`update users set last_login_at = now() where id = $1`, [user!.id]);
  return { ok: true, user: user! };
}

/** Whether this installation has been claimed. The setup wizard is only
 * reachable while this is false. */
export async function hasSuperAdmin(db: Db): Promise<boolean> {
  const rows = await db.query(`select 1 from users where role = 'super_admin' limit 1`);
  return rows.length > 0;
}
