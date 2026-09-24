import type { Db } from '@josi-ce/core';

function validZone(value: unknown): string | null {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return null;
  }
}

function parsedProfile(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

function validLocale(value: unknown): string | null {
  const locale = typeof value === 'string' ? value.trim() : '';
  if (!locale) return null;
  try {
    new Intl.DateTimeFormat(locale).format(0);
    return locale;
  } catch {
    return null;
  }
}

export function localDateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar-day arithmetic, deliberately independent of 23/25-hour DST days. */
export function shiftCivilDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export interface EffectiveTimeContext {
  timeZone: string;
  locale: string;
  currentLocal: string;
  today: string;
  tomorrow: string;
  yesterday: string;
  prompt: string;
}

export async function effectiveTimeContext(db: Db, userId: string, now = new Date()): Promise<EffectiveTimeContext> {
  const [profile] = await db.query<{ parsed: unknown }>(
    `select parsed from persona_profiles where owner_user_id=$1 and kind='user'`, [userId],
  );
  const [workspace] = await db.query<{ timezone: string }>(`select timezone from workspace where id=true`);
  const parsed = parsedProfile(profile?.parsed);
  const profileZone = validZone(parsed.timezone);
  const timeZone = profileZone ?? validZone(workspace?.timezone) ?? 'UTC';
  const locale = validLocale(parsed.locale) ?? 'en-US';
  const today = localDateKey(now, timeZone);
  const currentLocal = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    timeZoneName: 'longOffset',
  }).format(now);
  const tomorrow = shiftCivilDate(today, 1);
  const yesterday = shiftCivilDate(today, -1);
  return {
    timeZone, locale, currentLocal, today, tomorrow, yesterday,
    prompt: `The effective timezone is ${timeZone}. The current local date and time is ${currentLocal}. `
      + `Today is ${today}, tomorrow is ${tomorrow}, and yesterday was ${yesterday}. `
      + 'Resolve relative dates from these local civil dates, not by adding 24 hours; daylight-saving changes can make a local day 23 or 25 hours. '
      + 'When a date omits its year, use the next occurrence that is not in the past. Do not ask the person to repeat this timezone.',
  };
}
