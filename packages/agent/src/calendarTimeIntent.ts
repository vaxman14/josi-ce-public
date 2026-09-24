import type { Db } from '@josi-ce/core';
import { effectiveTimeContext, shiftCivilDate } from './timeContext.js';

export interface CalendarRelativeTimeIntent {
  kind: 'relative_day';
  dayOffset: number;
  localDate: string;
  localTime: string;
  durationMinutes?: number;
  timeZone: string;
}

export type CalendarTimeResolution =
  | { kind: 'none' }
  | { kind: 'incomplete'; intent: CalendarRelativeTimeIntent; message: string }
  | { kind: 'invalid'; error: 'nonexistent_local_time' | 'ambiguous_local_time' | 'bad_calendar_time'; message: string }
  | { kind: 'resolved'; intent: CalendarRelativeTimeIntent; start: string; end: string };

function numberFromWords(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fortyfive: 45,
    sixty: 60, ninety: 90,
  };
  return words[value.toLowerCase().replace(/[ -]/g, '')] ?? null;
}

function parseDurationMinutes(text: string): number | null {
  const match = /\b(?:for\s+)?(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty(?:[ -]?five)?|sixty|ninety)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(text);
  if (!match) return null;
  const amount = numberFromWords(match[1]);
  if (amount === null) return null;
  const minutes = /^(?:h|hr|hrs|hour|hours)$/i.test(match[2]) ? amount * 60 : amount;
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

function clockFromMatch(match: RegExpExecArray | null): string | null {
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase().replace(/\./g, '');
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseLocalTime(text: string): string | null {
  // A bare number is not a time: in “45 minutes” it is a duration. Require
  // “at”/“from”, a meridiem, or a colon-form clock before treating it as one.
  return clockFromMatch(/\b(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(text)
    ?? /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(text)
    ?? /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text));
}

function parseEndLocalTime(text: string): string | null {
  return clockFromMatch(/\b(?:to|until|through)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i.exec(text));
}

function relativeDayOffset(text: string): number | null {
  if (/\bday after tomorrow\b/i.test(text)) return 2;
  if (/\btomorrow\b/i.test(text)) return 1;
  if (/\b(?:today|tonight)\b/i.test(text)) return 0;
  const inDays = /\bin\s+(\d{1,3})\s+(days?|weeks?)\b/i.exec(text);
  if (inDays) {
    const count = Number(inDays[1]) * (/^week/i.test(inDays[2]) ? 7 : 1);
    return count <= 366 ? count : null;
  }
  return null;
}

function mentionsRelativeDate(text: string): boolean {
  return /\b(?:today|tonight|tomorrow|day after tomorrow|in\s+\d+\s+(?:days?|weeks?)|(?:this|next)\s+(?:week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(text);
}

function civilParts(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function offsetMinutesAt(value: Date, timeZone: string): number | null {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone, timeZoneName: 'longOffset', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(value).find((candidate) => candidate.type === 'timeZoneName')?.value;
  const match = /^GMT(?:(?<sign>[+-])(?<hour>\d{1,2})(?::(?<minute>\d{2}))?)?$/.exec(part ?? '');
  if (!match?.groups?.sign) return part === 'GMT' ? 0 : null;
  const total = Number(match.groups.hour) * 60 + Number(match.groups.minute ?? 0);
  return match.groups.sign === '-' ? -total : total;
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/** Resolve one civil minute. Zero matches is a DST gap; two is a DST fold. */
export function resolveCivilMinute(localDate: string, localTime: string, timeZone: string):
  | { ok: true; instant: Date; iso: string }
  | { ok: false; reason: 'nonexistent' | 'ambiguous' } {
  const target = `${localDate}T${localTime}`;
  const naive = Date.parse(`${target}:00Z`);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const offset = offsetMinutesAt(new Date(naive + hours * 3_600_000), timeZone);
    if (offset !== null) offsets.add(offset);
  }
  const matches = [...offsets].map((offset) => ({
    offset,
    instant: new Date(naive - offset * 60_000),
  })).filter((candidate) => civilParts(candidate.instant, timeZone) === target)
    .sort((a, b) => a.instant.getTime() - b.instant.getTime());
  if (!matches.length) return { ok: false, reason: 'nonexistent' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous' };
  const only = matches[0];
  return { ok: true, instant: only.instant, iso: `${target}:00${offsetText(only.offset)}` };
}

function formatInstant(value: Date, timeZone: string): string {
  const local = civilParts(value, timeZone);
  const offset = offsetMinutesAt(value, timeZone);
  if (offset === null) throw new Error(`Could not resolve offset for ${timeZone}`);
  return `${local}:00${offsetText(offset)}`;
}

/** Require model-supplied absolutes to carry unambiguous offset semantics. */
export function validateAbsoluteCalendarRange(start: unknown, end: unknown): string | null {
  if (start === undefined || end === undefined) return null;
  const explicit = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof start !== 'string' || typeof end !== 'string' || !explicit.test(start) || !explicit.test(end)) {
    return 'Calendar start and end must be explicit ISO 8601 timestamps with Z or a numeric UTC offset.';
  }
  const startMs = Date.parse(start); const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 'Calendar start and end are invalid or the end is not after the start.';
  }
  return null;
}

/**
 * Rebuild relative calendar timestamps from the authenticated turn's latest
 * user text. Model-supplied absolutes are never authoritative for that intent.
 */
export async function resolveCalendarTimeIntent(
  db: Db,
  args: {
    userId: string;
    latestUserText?: string;
    effectiveNow?: Date;
    existingIntent?: unknown;
  },
): Promise<CalendarTimeResolution> {
  const text = args.latestUserText?.trim() ?? '';
  const offset = relativeDayOffset(text);
  const relativeMention = mentionsRelativeDate(text);
  const existing = args.existingIntent && typeof args.existingIntent === 'object'
    ? args.existingIntent as Partial<CalendarRelativeTimeIntent> : null;
  if (offset === null && existing?.kind !== 'relative_day' && !relativeMention) return { kind: 'none' };
  const inheritedOffset = typeof existing?.dayOffset === 'number' && Number.isInteger(existing.dayOffset)
    ? existing.dayOffset : null;

  const temporal = await effectiveTimeContext(db, args.userId, args.effectiveNow ?? new Date());
  if (offset === null && inheritedOffset === null) {
    return { kind: 'invalid', error: 'bad_calendar_time', message: `I could not safely resolve that relative date in ${temporal.timeZone}. Please give an explicit calendar date.` };
  }
  const dayOffset = offset ?? inheritedOffset!;
  const localDate = offset === null && existing?.localDate
    ? existing.localDate
    : shiftCivilDate(temporal.today, dayOffset);
  const localTime = parseLocalTime(text) ?? existing?.localTime ?? null;
  const durationMinutes = parseDurationMinutes(text) ?? existing?.durationMinutes;
  const explicitEndTime = parseEndLocalTime(text);
  if (!localTime) {
    return { kind: 'invalid', error: 'bad_calendar_time', message: `I could not safely determine the local time for that relative date in ${temporal.timeZone}. Please give a time.` };
  }
  const intent: CalendarRelativeTimeIntent = {
    kind: 'relative_day', dayOffset, localDate, localTime, timeZone: temporal.timeZone,
    ...(durationMinutes ? { durationMinutes } : {}),
  };
  if (!durationMinutes && !explicitEndTime) {
    return { kind: 'incomplete', intent, message: 'I have the relative date and time, but need the event duration before I can prepare it.' };
  }
  const start = resolveCivilMinute(localDate, localTime, temporal.timeZone);
  if (!start.ok) {
    return start.reason === 'nonexistent'
      ? { kind: 'invalid', error: 'nonexistent_local_time', message: `${localTime} does not exist on ${localDate} in ${temporal.timeZone} because of the daylight-saving transition. Choose another time.` }
      : { kind: 'invalid', error: 'ambiguous_local_time', message: `${localTime} occurs twice on ${localDate} in ${temporal.timeZone} because of the daylight-saving transition. Choose another unambiguous time.` };
  }
  if (explicitEndTime) {
    const end = resolveCivilMinute(localDate, explicitEndTime, temporal.timeZone);
    if (!end.ok) {
      return end.reason === 'nonexistent'
        ? { kind: 'invalid', error: 'nonexistent_local_time', message: `${explicitEndTime} does not exist on ${localDate} in ${temporal.timeZone} because of the daylight-saving transition. Choose another time.` }
        : { kind: 'invalid', error: 'ambiguous_local_time', message: `${explicitEndTime} occurs twice on ${localDate} in ${temporal.timeZone} because of the daylight-saving transition. Choose another unambiguous time.` };
    }
    const explicitDuration = (end.instant.getTime() - start.instant.getTime()) / 60_000;
    if (!Number.isInteger(explicitDuration) || explicitDuration <= 0 || explicitDuration > 24 * 60) {
      return { kind: 'invalid', error: 'bad_calendar_time', message: 'The relative event end must be after its start on the same local date.' };
    }
    intent.durationMinutes = explicitDuration;
    return { kind: 'resolved', intent, start: start.iso, end: end.iso };
  }
  const endInstant = new Date(start.instant.getTime() + durationMinutes! * 60_000);
  return { kind: 'resolved', intent, start: start.iso, end: formatInstant(endInstant, temporal.timeZone) };
}
