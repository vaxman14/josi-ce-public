export interface CalendarPresentationOptions {
  locale?: string | null;
  timeZone?: string | null;
}

function safeLocale(value: unknown): string {
  const locale = typeof value === 'string' && value.trim() ? value.trim() : 'en-US';
  try { new Intl.DateTimeFormat(locale).format(0); return locale; } catch { return 'en-US'; }
}

function safeTimeZone(value: unknown): string {
  const timeZone = typeof value === 'string' && value.trim() ? value.trim() : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); return timeZone; } catch { return 'UTC'; }
}

function parsed(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function civilDate(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => part.value).join('-');
}

function tidy(value: string): string {
  return value.replace(/[\u00a0\u202f]/gu, ' ').replace(/\s*–\s*/u, '–');
}

/** Human-only calendar presentation. Task slots, provider payloads and audit
 * records keep their original ISO timestamps; this formatter is used only at
 * the final message boundary. */
export function formatCalendarRange(startValue: unknown, endValue: unknown, options: CalendarPresentationOptions = {}): string {
  const locale = safeLocale(options.locale);
  const timeZone = safeTimeZone(options.timeZone);
  const start = parsed(startValue);
  const end = parsed(endValue);
  const full = new Intl.DateTimeFormat(locale, {
    timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  if (!start || !end) {
    return `Start: ${start ? tidy(full.format(start)) : 'Not specified'}\nEnd: ${end ? tidy(full.format(end)) : 'Not specified'}`;
  }
  if (civilDate(start, locale, timeZone) === civilDate(end, locale, timeZone)) {
    const date = new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'full' }).format(start);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).formatRange(start, end);
    return `Date: ${tidy(date)}\nTime: ${tidy(time)}`;
  }
  return `Start: ${tidy(full.format(start))}\nEnd: ${tidy(full.format(end))}`;
}
