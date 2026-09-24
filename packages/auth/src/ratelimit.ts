import type { Db } from '@josi-ce/core';

export const LOCKOUT_WINDOW_SECONDS = 15 * 60;
export const MAX_ATTEMPTS_PER_IDENTIFIER = 8;
export const MAX_ATTEMPTS_PER_IP = 25;

export interface RateVerdict {
  blocked: boolean;
  reason?: 'identifier' | 'ip';
  retryAfterSeconds: number;
}

/** Two counters, deliberately: per-identifier stops someone grinding one
 * account, per-IP stops someone spraying many accounts from one host.
 * Successful logins clear the identifier counter. */
export async function checkLoginRate(db: Db, identifier: string, ip: string | null): Promise<RateVerdict> {
  const rows = await db.query<{ by_identifier: string; by_ip: string }>(
    `select
       count(*) filter (where identifier = $1) as by_identifier,
       count(*) filter (where ip is not distinct from $2 and $2 is not null) as by_ip
     from login_attempts
     where success = false and created_at > now() - make_interval(secs => $3)`,
    [identifier.toLowerCase(), ip, LOCKOUT_WINDOW_SECONDS],
  );
  const byIdentifier = Number(rows[0]?.by_identifier ?? 0);
  const byIp = Number(rows[0]?.by_ip ?? 0);
  if (byIdentifier >= MAX_ATTEMPTS_PER_IDENTIFIER) {
    return { blocked: true, reason: 'identifier', retryAfterSeconds: LOCKOUT_WINDOW_SECONDS };
  }
  if (byIp >= MAX_ATTEMPTS_PER_IP) {
    return { blocked: true, reason: 'ip', retryAfterSeconds: LOCKOUT_WINDOW_SECONDS };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

export async function recordLoginAttempt(
  db: Db,
  args: { identifier: string; ip: string | null; success: boolean },
): Promise<void> {
  await db.query(
    `insert into login_attempts (identifier, ip, success) values ($1, $2, $3)`,
    [args.identifier.toLowerCase(), args.ip, args.success],
  );
  if (args.success) {
    await db.query(
      `delete from login_attempts where identifier = $1 and success = false`,
      [args.identifier.toLowerCase()],
    );
  }
}
