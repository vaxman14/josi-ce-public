// Parental Controls: the authority, the timetable, and the counting.
//
// Read `ownership.ts` first. It says access to a private row comes from owning
// it or from a share its owner created, and that neither membership nor
// super-admin status grants anything. THAT FILE IS NOT MODIFIED BY THIS
// FEATURE and this one does not call into it. A parent's visibility is a
// separate, narrower authority with its own decision point — the function
// `parentalAuthority` below — and it is narrow in five ways at once:
//
//   * It exists only while a `parental_links` row exists and has not ended.
//   * It covers exactly one named child, never "children" as a category.
//   * It covers conversations, schedule, limits and usage. Not that child's
//     connections, credentials, documents, mail or storage.
//   * It is bought. With the module inert, this file grants nothing and
//     enforces nothing — every function below answers as though the feature
//     were not installed.
//   * It never flows upward. An administrator has no path to it, and neither
//     does the parent's parent, because there is no such concept here.
//
// WHAT THE TIMETABLE ACTUALLY MEANS, said once and repeated on screen
//
// A minute is recorded when the child SENDS SOMETHING TO JOSI. Every channel
// counts, because every channel goes through one turn function. Nothing else is
// observed and nothing is inferred between turns: this stack cannot see a phone
// being held, an app being opened or a page being read, so it does not sell a
// limit that claims to. "45 minutes a day" here means 45 distinct minutes in
// which a message was sent, and the screens say exactly that.
import type { Db } from './db.js';
import { appendEvent } from './events.js';
import { entitlementStatus } from './entitlements.js';

export const PARENTAL_MODULE = 'parental_controls' as const;

/** How long a proved password-and-second-factor stays spendable. Short: it
 * covers one deliberate act, not a session of them. */
export const AUTHORITY_GRANT_TTL_SECONDS = 5 * 60;

/** A ceiling on how many accounts one adult may create through this feature.
 * Not a licensing limit — a blast radius. Account creation is otherwise the
 * super admin's alone, and this is the one door out of that. */
export const MAX_CHILDREN_PER_PARENT = 12;

export interface ParentalLink {
  id: string;
  parent_user_id: string;
  child_user_id: string;
  created_at: string;
  ended_at: string | null;
}

export interface ChildControls {
  childUserId: string;
  timezone: string;
  dailyLimitMinutes: number | null;
  scheduleEnabled: boolean;
  windows: ScheduleWindow[];
  updatedAt: string | null;
}

export interface ScheduleWindow {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

const UUID = /^[0-9a-fA-F-]{36}$/;

/** Is the module bought and live right now? Every entry point below asks this
 * first, so a lapsed licence makes the feature inert rather than half-present:
 * no visibility for the parent AND no enforcement against the child. Holding a
 * child to a timetable nobody is paying for, and that nobody with authority can
 * see or change, would be the worse of the two failures. */
export async function parentalModuleLive(db: Db): Promise<boolean> {
  return (await entitlementStatus(db, PARENTAL_MODULE)).entitled;
}

// ------------------------------------------------------------- relationships

/** The live link for a child, or null. The one query that decides authority. */
export async function controllerOf(db: Db, childUserId: string): Promise<ParentalLink | null> {
  if (!UUID.test(childUserId)) return null;
  const rows = await db.query<ParentalLink>(
    `select id, parent_user_id, child_user_id, created_at, ended_at
     from parental_links where child_user_id = $1 and ended_at is null`,
    [childUserId],
  );
  return rows[0] ?? null;
}

export async function childrenOf(db: Db, parentUserId: string): Promise<ParentalLink[]> {
  if (!UUID.test(parentUserId)) return [];
  return db.query<ParentalLink>(
    `select id, parent_user_id, child_user_id, created_at, ended_at
     from parental_links where parent_user_id = $1 and ended_at is null
     order by created_at`,
    [parentUserId],
  );
}

/**
 * THE DECISION POINT. May this person act as the guardian of that person?
 *
 * Note what is absent, in the same spirit as `resolveAccess`: any branch on
 * role. A super admin asking about a child they are not linked to gets exactly
 * what a stranger gets — false — and there is no second function that answers
 * differently. Callers turn a false into a **404**, never a 403: confirming
 * that a particular account is somebody's managed child is itself a disclosure
 * about a family.
 */
export async function parentalAuthority(
  db: Db,
  args: { parentUserId: string; childUserId: string },
): Promise<boolean> {
  if (!(await parentalModuleLive(db))) return false;
  const link = await controllerOf(db, args.childUserId);
  return !!link && link.parent_user_id === args.parentUserId;
}

/** Is this account managed by somebody? Used to decide Child Mode, and
 * deliberately derived from the link rather than from a flag on `users`: two
 * places to say the same thing is how they come to disagree. */
export async function isManagedChild(db: Db, userId: string): Promise<boolean> {
  if (!(await parentalModuleLive(db))) return false;
  return !!(await controllerOf(db, userId));
}

export async function createLink(
  db: Db,
  args: { parentUserId: string; childUserId: string; actorUserId: string; timezone?: string },
): Promise<ParentalLink> {
  const rows = await db.query<ParentalLink>(
    `insert into parental_links (parent_user_id, child_user_id, created_by_user_id)
     values ($1, $2, $3)
     returning id, parent_user_id, child_user_id, created_at, ended_at`,
    [args.parentUserId, args.childUserId, args.actorUserId],
  );
  // The controls row is created WITH the link, permissive, so "managed" and
  // "has a timetable" are never the same question.
  await db.query(
    `insert into child_controls (child_user_id, timezone, updated_by_user_id)
     values ($1, $2, $3) on conflict (child_user_id) do nothing`,
    [args.childUserId, safeTimezone(args.timezone ?? 'UTC'), args.actorUserId],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'parental.link_created',
    subjectType: 'user',
    subjectId: args.childUserId,
    payload: { linkId: rows[0].id, factors: 'password_totp' },
  });
  return rows[0];
}

/** End a relationship. The row stays, ended, because the trail should still
 * say that it existed; the visibility it granted is gone on the next query. */
export async function endLink(
  db: Db,
  args: { parentUserId: string; childUserId: string; actorUserId: string },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update parental_links set ended_at = now(), ended_by_user_id = $3
     where parent_user_id = $1 and child_user_id = $2 and ended_at is null
     returning id`,
    [args.parentUserId, args.childUserId, args.actorUserId],
  );
  if (!rows.length) return false;
  // The timetable goes with the authority. Leaving a limit behind that nobody
  // may see or change would be a rule enforced by nobody.
  await db.query(`delete from child_schedule_windows where child_user_id = $1`, [args.childUserId]);
  await db.query(`delete from child_controls where child_user_id = $1`, [args.childUserId]);
  // And so does the record of when they were using Josi. It was collected to
  // enforce a limit that no longer exists and to answer a question nobody may
  // now ask; keeping it would leave a surveillance record of somebody's
  // afternoons that its subject never agreed to and nobody can look at. The
  // conversations themselves are the CHILD'S OWN and are not touched.
  await db.query(`delete from child_activity_minutes where child_user_id = $1`, [args.childUserId]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'parental.link_ended',
    subjectType: 'user',
    subjectId: args.childUserId,
    payload: { linkId: rows[0].id, factors: 'password_totp' },
  });
  return true;
}

// ----------------------------------------------------------------- timetable

/** A timezone the database and Intl will both accept, or UTC. A bad string
 * must not become a SQL error on a page a parent is reading. */
export function safeTimezone(timezone: string): string {
  const candidate = (timezone ?? '').trim();
  if (!candidate) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return 'UTC';
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Where a moment falls in somebody's own week: 0 = Sunday, and minutes since
 * their local midnight. Computed through Intl rather than by adding an offset,
 * because the offset changes twice a year and a hand-rolled one is wrong on
 * those two days — which are exactly the days somebody notices. */
export function localWeekPosition(
  now: Date,
  timezone: string,
): { weekday: number; minute: number; dayKey: string } {
  const tz = safeTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = Math.max(0, WEEKDAYS.indexOf(get('weekday') as (typeof WEEKDAYS)[number]));
  // Intl renders midnight as "24" in some locales/engines; both mean minute 0.
  const hour = Number(get('hour')) % 24;
  const minute = hour * 60 + Number(get('minute'));
  return { weekday, minute, dayKey: `${get('year')}-${get('month')}-${get('day')}` };
}

export async function getControls(db: Db, childUserId: string): Promise<ChildControls | null> {
  if (!UUID.test(childUserId)) return null;
  const rows = await db.query<{
    child_user_id: string; timezone: string; daily_limit_minutes: number | null;
    schedule_enabled: boolean; updated_at: string;
  }>(
    `select child_user_id, timezone, daily_limit_minutes, schedule_enabled, updated_at
     from child_controls where child_user_id = $1`,
    [childUserId],
  );
  if (!rows.length) return null;
  const windows = await db.query<{ weekday: number; start_minute: number; end_minute: number }>(
    `select weekday, start_minute, end_minute from child_schedule_windows
     where child_user_id = $1 order by weekday, start_minute`,
    [childUserId],
  );
  return {
    childUserId,
    timezone: rows[0].timezone,
    dailyLimitMinutes: rows[0].daily_limit_minutes === null ? null : Number(rows[0].daily_limit_minutes),
    scheduleEnabled: rows[0].schedule_enabled,
    windows: windows.map((w) => ({
      weekday: Number(w.weekday), startMinute: Number(w.start_minute), endMinute: Number(w.end_minute),
    })),
    updatedAt: rows[0].updated_at,
  };
}

export class ScheduleError extends Error {}

/** Windows, validated as a set rather than one at a time: overlapping windows
 * on one day are not wrong so much as unreadable, and a parent who writes two
 * should be told, not silently given their union. */
export function normalizeWindows(input: unknown): ScheduleWindow[] {
  if (!Array.isArray(input)) return [];
  const out: ScheduleWindow[] = [];
  for (const raw of input.slice(0, 7 * 6)) {
    const item = raw as Record<string, unknown>;
    const weekday = Number(item.weekday);
    const startMinute = Number(item.startMinute);
    const endMinute = Number(item.endMinute);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new ScheduleError('a day of the week has to be one of the seven');
    }
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
      throw new ScheduleError('a time has to be a whole number of minutes past midnight');
    }
    if (startMinute < 0 || startMinute > 1439 || endMinute < 1 || endMinute > 1440) {
      throw new ScheduleError('a window has to be inside one day');
    }
    if (endMinute <= startMinute) {
      throw new ScheduleError('a window has to end after it starts. For a stretch that runs past midnight, write one window on each day.');
    }
    out.push({ weekday, startMinute, endMinute });
  }
  out.sort((a, b) => (a.weekday - b.weekday) || (a.startMinute - b.startMinute));
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].weekday === out[i - 1].weekday && out[i].startMinute < out[i - 1].endMinute) {
      throw new ScheduleError('two windows on the same day overlap. Merge them into one.');
    }
  }
  return out;
}

export async function setControls(
  db: Db,
  args: {
    childUserId: string;
    actorUserId: string;
    timezone?: string;
    dailyLimitMinutes?: number | null;
    scheduleEnabled?: boolean;
    windows?: ScheduleWindow[];
  },
): Promise<ChildControls | null> {
  const limit = args.dailyLimitMinutes;
  if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 5 || limit > 1440)) {
    throw new ScheduleError('a daily limit has to be between 5 minutes and 24 hours, or nothing at all');
  }
  await db.query(
    `update child_controls set
       timezone = coalesce($2::text, timezone),
       daily_limit_minutes = case when $3::boolean then $4::integer else daily_limit_minutes end,
       schedule_enabled = coalesce($5::boolean, schedule_enabled),
       updated_at = now(),
       updated_by_user_id = $6
     where child_user_id = $1`,
    [
      args.childUserId,
      args.timezone === undefined ? null : safeTimezone(args.timezone),
      limit !== undefined,
      limit ?? null,
      args.scheduleEnabled === undefined ? null : args.scheduleEnabled,
      args.actorUserId,
    ],
  );
  if (args.windows) {
    await db.query(`delete from child_schedule_windows where child_user_id = $1`, [args.childUserId]);
    for (const w of args.windows) {
      await db.query(
        `insert into child_schedule_windows (child_user_id, weekday, start_minute, end_minute)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [args.childUserId, w.weekday, w.startMinute, w.endMinute],
      );
    }
  }
  // The FIELDS that changed, never their values: a bedtime is a fact about a
  // household, and the audit trail is read by the installation's administrator.
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'parental.controls_updated',
    subjectType: 'user',
    subjectId: args.childUserId,
    payload: {
      fields: [
        args.timezone !== undefined ? 'timezone' : null,
        limit !== undefined ? 'dailyLimitMinutes' : null,
        args.scheduleEnabled !== undefined ? 'scheduleEnabled' : null,
        args.windows ? 'schedule' : null,
      ].filter(Boolean),
    },
  });
  return getControls(db, args.childUserId);
}

// ------------------------------------------------------------------- minutes

export type ActivityChannel = 'web' | 'native' | 'telegram' | 'external';

/** Record that this child spoke to Josi in this minute. Idempotent by primary
 * key, so ten messages in one minute are one minute. */
export async function recordChildActivity(
  db: Db,
  args: { childUserId: string; channel: ActivityChannel; at?: Date },
): Promise<void> {
  const at = args.at ?? new Date();
  const minute = new Date(Math.floor(at.getTime() / 60000) * 60000).toISOString();
  await db.query(
    `insert into child_activity_minutes (child_user_id, minute, channel)
     values ($1, $2, $3) on conflict do nothing`,
    [args.childUserId, minute, args.channel],
  );
}

/** Minutes used so far in the child's own current day. */
export async function minutesUsedToday(
  db: Db,
  args: { childUserId: string; timezone: string; now?: Date },
): Promise<number> {
  const tz = safeTimezone(args.timezone);
  const now = args.now ?? new Date();
  const rows = await db.query<{ n: string }>(
    `select count(*) as n from child_activity_minutes
     where child_user_id = $1
       and (minute at time zone $2::text)::date = ($3::timestamptz at time zone $2::text)::date`,
    [args.childUserId, tz, now.toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface UsageDay {
  day: string;
  minutes: number;
  channels: string[];
}

export interface UsageSummary {
  timezone: string;
  days: UsageDay[];
  totalMinutes: number;
  conversations: number;
  messagesSent: number;
  busiestDay: string | null;
}

/**
 * What a parent is shown instead of a transcript.
 *
 * Counts and days, so the ordinary question — is this a lot, is it late, is it
 * every day — is answerable without anybody reading a word. The words are one
 * deliberate click away, on a route that writes an audit entry, because reading
 * a child's conversation should be a thing somebody chose to do.
 */
export async function usageSummary(
  db: Db,
  args: { childUserId: string; timezone: string; days?: number; now?: Date },
): Promise<UsageSummary> {
  const tz = safeTimezone(args.timezone);
  const days = Math.min(90, Math.max(1, args.days ?? 14));
  const now = (args.now ?? new Date()).toISOString();
  const rows = await db.query<{ day: string; n: string; channels: string[] }>(
    `select to_char((minute at time zone $2::text)::date, 'YYYY-MM-DD') as day,
            count(*) as n,
            array_agg(distinct channel) as channels
     from child_activity_minutes
     where child_user_id = $1
       and (minute at time zone $2::text)::date > ($3::timestamptz at time zone $2::text)::date - $4::integer
     group by 1 order by 1`,
    [args.childUserId, tz, now, days],
  );
  const [threads] = await db.query<{ n: string }>(
    `select count(*) as n from threads where owner_user_id = $1`, [args.childUserId],
  );
  const [messages] = await db.query<{ n: string }>(
    `select count(*) as n from messages m join threads t on t.id = m.thread_id
     where t.owner_user_id = $1 and m.direction = 'in'`,
    [args.childUserId],
  );

  const usage = rows.map((r) => ({ day: r.day, minutes: Number(r.n), channels: r.channels ?? [] }));
  const busiest = usage.reduce<UsageDay | null>((best, d) => (!best || d.minutes > best.minutes ? d : best), null);
  return {
    timezone: tz,
    days: usage,
    totalMinutes: usage.reduce((sum, d) => sum + d.minutes, 0),
    conversations: Number(threads?.n ?? 0),
    messagesSent: Number(messages?.n ?? 0),
    busiestDay: busiest?.day ?? null,
  };
}

// -------------------------------------------------------------- the decision

export type ChildAccessReason =
  | 'not_managed'
  | 'module_inert'
  | 'allowed'
  | 'outside_schedule'
  | 'daily_limit';

export interface ChildAccessDecision {
  allowed: boolean;
  reason: ChildAccessReason;
  /** True only when this account is genuinely a managed child of a live
   * module. Callers use it to decide whether to count a minute. */
  managed: boolean;
  message?: string;
  usedMinutes?: number;
  limitMinutes?: number | null;
  /** A sentence in the child's own local time, e.g. "07:00 on Monday". Never a
   * timestamp: "blocked until 2026-09-09T14:00:00Z" is not an answer. */
  opensAgain?: string | null;
}

/**
 * May this person talk to Josi right now?
 *
 * Called on EVERY turn, from the one function every channel goes through, and
 * again by the web route before a turn is started. Two checks rather than one
 * because a route that forgot to ask would otherwise be a silent hole, and the
 * turn function is the last place that can still refuse.
 *
 * Everybody who is not a managed child of a live module is allowed, in one
 * indexed query, and that is the overwhelmingly common answer.
 */
export async function checkChildAccess(
  db: Db,
  args: { userId: string; now?: Date },
): Promise<ChildAccessDecision> {
  const link = await controllerOf(db, args.userId);
  if (!link) return { allowed: true, reason: 'not_managed', managed: false };
  if (!(await parentalModuleLive(db))) return { allowed: true, reason: 'module_inert', managed: false };

  const controls = await getControls(db, args.userId);
  if (!controls) return { allowed: true, reason: 'allowed', managed: true };

  const now = args.now ?? new Date();
  const here = localWeekPosition(now, controls.timezone);

  if (controls.scheduleEnabled) {
    const open = controls.windows.some(
      (w) => w.weekday === here.weekday && here.minute >= w.startMinute && here.minute < w.endMinute,
    );
    if (!open) {
      return {
        allowed: false,
        reason: 'outside_schedule',
        managed: true,
        message: 'Josi is not answering right now — this is outside your agreed hours.',
        opensAgain: nextOpening(controls.windows, here),
      };
    }
  }

  if (controls.dailyLimitMinutes !== null) {
    const used = await minutesUsedToday(db, {
      childUserId: args.userId, timezone: controls.timezone, now,
    });
    if (used >= controls.dailyLimitMinutes) {
      return {
        allowed: false,
        reason: 'daily_limit',
        managed: true,
        message: 'You have used today’s time with Josi. It starts again tomorrow.',
        usedMinutes: used,
        limitMinutes: controls.dailyLimitMinutes,
      };
    }
    return {
      allowed: true, reason: 'allowed', managed: true, usedMinutes: used, limitMinutes: controls.dailyLimitMinutes,
    };
  }

  return { allowed: true, reason: 'allowed', managed: true, limitMinutes: null };
}

/** The next window that starts after this moment, described the way a person
 * would say it. Null when the timetable has no windows at all — the honest
 * answer there is "nobody has set an hour when this opens", and the caller
 * says exactly that rather than inventing a time. */
export function nextOpening(
  windows: ScheduleWindow[],
  here: { weekday: number; minute: number },
): string | null {
  if (!windows.length) return null;
  const clock = (minute: number): string =>
    `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const weekday = (here.weekday + ahead) % 7;
    const candidates = windows
      .filter((w) => w.weekday === weekday && (ahead > 0 || w.startMinute > here.minute))
      .sort((a, b) => a.startMinute - b.startMinute);
    if (!candidates.length) continue;
    const when = clock(candidates[0].startMinute);
    if (ahead === 0) return `${when} today`;
    if (ahead === 1) return `${when} tomorrow`;
    return `${when} on ${WEEKDAY_NAMES[weekday]}`;
  }
  return null;
}

// ------------------------------------------------- proving it is really them

/** Issue a grant. The CALLER has already checked a password and a TOTP code —
 * this module does not own either, and a second copy of that logic here would
 * be a second place for it to be wrong. */
export async function issueAuthorityGrant(
  db: Db,
  args: { userId: string; sessionKey: string; ttlSeconds?: number },
): Promise<{ id: string; expiresAt: string }> {
  const rows = await db.query<{ id: string; expires_at: string }>(
    `insert into parental_authority_grants (user_id, session_key, expires_at)
     values ($1, $2, now() + make_interval(secs => $3))
     returning id, expires_at`,
    [args.userId, args.sessionKey, args.ttlSeconds ?? AUTHORITY_GRANT_TTL_SECONDS],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'parental.authority_granted',
    subjectType: 'user',
    subjectId: args.userId,
    payload: { factors: 'password_totp' },
  });
  return { id: rows[0].id, expiresAt: rows[0].expires_at };
}

/**
 * Spend a grant, or refuse.
 *
 * One conditional UPDATE, so a grant cannot be spent twice by two requests that
 * both read it first — the second UPDATE matches nothing. Consumed BEFORE the
 * change it authorises is made, because a change that happened against a grant
 * that was not consumed is a grant that can be replayed.
 */
export async function consumeAuthorityGrant(
  db: Db,
  args: { userId: string; sessionKey: string; purpose: string },
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `update parental_authority_grants set used_at = now(), used_for = $3
     where id = (
       select id from parental_authority_grants
       where user_id = $1 and session_key = $2 and used_at is null and expires_at > now()
       order by created_at desc limit 1
     )
     returning id`,
    [args.userId, args.sessionKey, args.purpose.slice(0, 60)],
  );
  return rows.length > 0;
}

/** What the child is told, in their own words, about what the adult can see.
 * Kept here beside the queries that make it true, so a change to one is a
 * change to the other in the same file. */
export const CHILD_DISCLOSURE = [
  'They can read your conversations with Josi, including anything you attach.',
  'They can see how many minutes you spend with Josi each day, and set a daily limit.',
  'They can set the hours when Josi will answer you.',
  'They can see when you last used Josi, on any channel.',
] as const;

export const CHILD_DISCLOSURE_LIMITS = [
  'They cannot see your password, and they cannot sign in as you.',
  'They cannot read anything outside Josi — not your phone, your browser, your other apps or your other accounts.',
  'You can see, on this page, every time they opened one of your conversations.',
] as const;
