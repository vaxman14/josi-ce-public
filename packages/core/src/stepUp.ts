// Step-up re-authentication.
//
// WHAT THE ENGINE DID, AND WHY CE CANNOT COPY IT
//
// The engine gates destructive actions behind a spoken PIN word. Its reasoning
// is sound and worth quoting: "Caller ID is spoofable. Anyone with a $5 SIP
// trunk can present the owner's number... caller ID gets you a conversation. It
// does not get you a destructive act."
//
// That threat does not exist here. CE has no phone line. A request arrives with
// a session cookie issued after a password login, behind CSRF. Nobody is
// spoofing an identity claim; the identity was established at sign-in.
//
// What IS still true is the shape of the risk: a session is not the person. A
// borrowed laptop, an open tab, a stolen cookie — all of them are someone else
// holding a session that was legitimately issued. The answer to that is to make
// them prove they know the password again, not to invent a second secret the
// owner has to remember and will eventually write on a sticky note.
//
// SO THIS IS RE-AUTHENTICATION, AND IT IS NAMED THAT WAY ON PURPOSE.
// It defends against a session someone else is holding. It does NOT defend
// against a stolen password — the attacker with the password can clear this
// gate as easily as the owner. Calling it a "second factor" would claim
// otherwise. A genuine second factor (TOTP) is not built; see
// PHASE_5_EVIDENCE.md.
//
// What is kept from the engine, unchanged, because it is right regardless of
// which factor is used:
//   * fail closed — an unlisted action is not gated, a listed one is
//   * a TTL'd unlock scoped to a session key, not to the account
//   * a lockout that is a COOL-DOWN, not a life sentence (the engine learned
//     this the hard way: counting failures over all time locked an owner out of
//     their own assistant permanently, three typos in a lifetime)
//   * every stopped attempt is logged, including the ones stopped by the
//     lockout, so the most suspicious case is not the one that leaves no trace
import type { Db } from './db.js';
import { appendEvent } from './events.js';

/** Actions that need more than a live session.
 *
 * The list is about consequence, not about which module the code lives in:
 * these are the ways a turn can cost someone something they cannot get back by
 * talking. Reading, searching, drafting and ordinary task conversation are
 * deliberately absent — a gate met constantly is a gate that gets disabled. */
export const SENSITIVE_ACTIONS = [
  'cancel_task',
  'release_hold',
  'change_settings',
  'spend_money',
  'delete_data',
  'send_as_user',
  'send_approved_email',
  'approve_task',
  // CE-specific: handing another person access to your own private resource is
  // as consequential as sending mail as you, and is the one an attacker on a
  // borrowed session would reach for to make their access outlive the session.
  'share_resource',
  'revoke_connection',
] as const;

export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export function isSensitiveAction(action: string): boolean {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

/** How long one cleared session stays cleared. Long enough not to nag through
 * a single sitting, short enough to die with it. */
export const VERIFICATION_TTL_SECONDS = 15 * 60;

/** Attempts allowed before the cool-down. */
export const MAX_ATTEMPTS = 5;

/** How far back a wrong attempt counts against you. A rate limit, not a life
 * sentence — see the engine's note above. */
export const LOCKOUT_WINDOW_SECONDS = 15 * 60;

export type StepUpReason =
  | 'not_sensitive'
  | 'verified'
  | 'needs_reauth'
  | 'locked_out';

export interface StepUpDecision {
  allowed: boolean;
  reason: StepUpReason;
  method?: 'password';
  /** A sentence the caller can show. Never a hint, never a stack trace. */
  message?: string;
}

/** Wrong attempts that still count: inside the cool-down, and since the last
 * time this session successfully re-authenticated. */
async function recentFailures(db: Db, userId: string, sessionKey: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from events
     where kind = 'stepup.failed'
       and actor_user_id = $1
       and payload->>'sessionKey' = $2
       and created_at > now() - make_interval(secs => $3)
       and created_at > coalesce((
         select max(created_at) from events
         where kind = 'stepup.verified' and actor_user_id = $1 and payload->>'sessionKey' = $2
       ), 'epoch'::timestamptz)`,
    [userId, sessionKey, LOCKOUT_WINDOW_SECONDS],
  );
  return Number(rows[0]?.n ?? 0);
}

async function activeVerification(
  db: Db,
  args: { userId: string; sessionKey: string },
): Promise<{ method: 'password' } | null> {
  const rows = await db.query<{ method: 'password' }>(
    `select method from step_up_verifications
     where user_id = $1 and session_key = $2 and expires_at > now()
     order by created_at desc limit 1`,
    [args.userId, args.sessionKey],
  );
  return rows[0] ?? null;
}

/** The check every surface makes before doing something it cannot undo.
 *
 * Fail-closed: an action on the list is refused until the session has
 * re-authenticated. Unlike the engine there is no `no_factor_configured` dead
 * end, because every CE account has a password by construction — that failure
 * mode was the engine's worst, and it disappears with the change of factor. */
export async function checkStepUp(
  db: Db,
  args: { userId: string; sessionKey: string; action: string },
): Promise<StepUpDecision> {
  if (!isSensitiveAction(args.action)) return { allowed: true, reason: 'not_sensitive' };

  const verified = await activeVerification(db, args);
  if (verified) return { allowed: true, reason: 'verified', method: verified.method };

  // Logged BEFORE the lockout branch returns, so someone still pushing after
  // five refusals is not the one case that leaves no trace.
  const lockedOut = (await recentFailures(db, args.userId, args.sessionKey)) >= MAX_ATTEMPTS;
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'system',
    kind: 'stepup.required',
    payload: { sessionKey: args.sessionKey, action: args.action, lockedOut },
  });

  if (lockedOut) {
    return {
      allowed: false,
      reason: 'locked_out',
      message: 'Too many failed secure reauthentication attempts. Wait a few minutes, then use the protected control in Settings. Never send your password in chat.',
    };
  }
  return {
    allowed: false,
    reason: 'needs_reauth',
    method: 'password',
    message: 'Use the protected reauthentication control in Settings to continue. Never send your password in chat.',
  };
}

export interface ReauthResult {
  ok: boolean;
  reason?: 'locked_out' | 'mismatch';
  attemptsLeft?: number;
}

/** Verify by password.
 *
 * The password is checked by a function the caller supplies rather than by this
 * module reaching into the auth package: core does not own password hashing,
 * and a copy of that logic here would be a second place for it to be wrong. */
export async function verifyStepUp(
  db: Db,
  args: {
    userId: string;
    sessionKey: string;
    password: string;
    verifyPassword: (userId: string, password: string) => Promise<boolean>;
    ttlSeconds?: number;
  },
): Promise<ReauthResult> {
  const failures = await recentFailures(db, args.userId, args.sessionKey);
  if (failures >= MAX_ATTEMPTS) return { ok: false, reason: 'locked_out', attemptsLeft: 0 };

  const ok = await args.verifyPassword(args.userId, args.password);
  if (!ok) {
    await appendEvent(db, {
      actorUserId: args.userId,
      actor: 'user',
      kind: 'stepup.failed',
      payload: { sessionKey: args.sessionKey, method: 'password' },
    });
    return { ok: false, reason: 'mismatch', attemptsLeft: Math.max(0, MAX_ATTEMPTS - failures - 1) };
  }

  const ttl = args.ttlSeconds ?? VERIFICATION_TTL_SECONDS;
  await db.query(
    `insert into step_up_verifications (user_id, session_key, method, expires_at)
     values ($1, $2, 'password', now() + make_interval(secs => $3))`,
    [args.userId, args.sessionKey, ttl],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'stepup.verified',
    payload: { sessionKey: args.sessionKey, method: 'password' },
  });
  return { ok: true };
}

/** Drop a session's unlock — on sign-out, or when a password changes. */
export async function clearStepUp(db: Db, args: { userId: string; sessionKey?: string }): Promise<void> {
  await db.query(
    `delete from step_up_verifications where user_id = $1 and ($2::text is null or session_key = $2)`,
    [args.userId, args.sessionKey ?? null],
  );
}
