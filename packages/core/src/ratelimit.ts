// Rate limiting the expensive things.
//
// Distinct from `@josi-ce/auth`'s sign-in limiter, and deliberately so. That one
// counts FAILURES and forgets them on success, because what it is limiting is
// guessing. This one counts ATTEMPTS regardless of outcome, because what it is
// limiting is WORK — a diagnostics bundle, a pg_dump, an embedding run. A
// successful expensive request is exactly as expensive as a failed one.
//
// Per subject, never global. A global counter on a small server means one
// person holding down a button denies the feature to everybody else, which
// turns a rate limit into the outage it was meant to prevent.
import type { Db } from './db.js';

export interface Limit {
  /** What is being limited. */
  bucket: string;
  /** How many are allowed in a window. */
  max: number;
  windowSeconds: number;
}

/** The buckets, named once so a route cannot invent one and quietly get its own
 * unlimited allowance. */
export const LIMITS = {
  /** Builds a bundle: reads config, counts rows, compresses. */
  diagnostics: { bucket: 'diagnostics', max: 5, windowSeconds: 3600 },
  /** Runs pg_dump against the whole database. */
  backup: { bucket: 'backup', max: 4, windowSeconds: 3600 },
  /** Leaves the installation, if a gateway is configured. */
  support_submit: { bucket: 'support_submit', max: 10, windowSeconds: 86_400 },
  /** Reaches an external provider to check a credential. */
  provider_probe: { bucket: 'provider_probe', max: 20, windowSeconds: 3600 },
  /** Full-text search across somebody's documents. */
  search: { bucket: 'search', max: 120, windowSeconds: 60 },
  /** Inbound Telegram messages from one chat.
   *
   * The subject is the CHAT, not the user, and that is the whole point: an
   * unlinked chat has no user to attribute work to, and it is precisely the
   * unlinked chat that is anonymous internet traffic. Every turn costs a model
   * call against the installation's cap, so a chat holding down send is
   * spending somebody else's money.
   *
   * 20/minute is far above human conversation and far below a script. */
  telegram_inbound: { bucket: 'telegram_inbound', max: 20, windowSeconds: 60 },
  /** Authenticated native submissions. Also backed by a hard database cap of
   * 50 queued/running turns per owner. */
  durable_turn: { bucket: 'durable_turn', max: 20, windowSeconds: 60 },
  /** Link-code redemption attempts from one chat. Tight, because this one is a
   * guessing surface: a 160-bit code is not brute-forcible, but a limit means
   * the attempt is visible in the audit log as a burst rather than a trickle. */
  telegram_link: { bucket: 'telegram_link', max: 5, windowSeconds: 600 },
} as const satisfies Record<string, Limit>;

export interface LimitVerdict {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Take one from the allowance, or refuse.
 *
 * A fixed window rather than a sliding one: it is one statement, it needs no
 * background sweep, and the worst case — twice the allowance across a window
 * boundary — is irrelevant for limits whose purpose is stopping a person from
 * looping, not stopping a botnet.
 *
 * The whole thing is a single upsert so two concurrent requests cannot both
 * read a stale count and both proceed.
 */
export async function consume(
  db: Db,
  args: { limit: Limit; subject: string },
): Promise<LimitVerdict> {
  const { limit } = args;
  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `insert into rate_limits (bucket, subject, window_started_at, count)
     values ($1, $2, now(), 1)
     on conflict (bucket, subject) do update set
       -- A new window resets the count; otherwise it climbs. Both branches are
       -- in the same statement so there is no read-then-write to race.
       window_started_at = case
         when rate_limits.window_started_at < now() - make_interval(secs => $3)
           then now() else rate_limits.window_started_at end,
       count = case
         when rate_limits.window_started_at < now() - make_interval(secs => $3)
           then 1 else rate_limits.count + 1 end
     returning count, extract(epoch from (now() - window_started_at))::int as age_seconds`,
    [limit.bucket, args.subject, limit.windowSeconds],
  );

  const count = row?.count ?? 1;
  const age = row?.age_seconds ?? 0;
  return {
    ok: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    retryAfterSeconds: Math.max(1, limit.windowSeconds - age),
  };
}

/** Read the allowance without spending it. For a UI that wants to grey a button
 * rather than let somebody press it and be refused. */
export async function peek(
  db: Db,
  args: { limit: Limit; subject: string },
): Promise<LimitVerdict> {
  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `select count, extract(epoch from (now() - window_started_at))::int as age_seconds
     from rate_limits where bucket = $1 and subject = $2`,
    [args.limit.bucket, args.subject],
  );
  if (!row || row.age_seconds >= args.limit.windowSeconds) {
    return { ok: true, remaining: args.limit.max, retryAfterSeconds: 0 };
  }
  return {
    ok: row.count < args.limit.max,
    remaining: Math.max(0, args.limit.max - row.count),
    retryAfterSeconds: Math.max(1, args.limit.windowSeconds - row.age_seconds),
  };
}

/** Housekeeping. Rows outside every window are dead weight. */
export async function pruneRateLimits(db: Db, olderThanSeconds = 86_400): Promise<number> {
  const rows = await db.query<{ bucket: string }>(
    `delete from rate_limits where window_started_at < now() - make_interval(secs => $1)
     returning bucket`,
    [olderThanSeconds],
  );
  return rows.length;
}
