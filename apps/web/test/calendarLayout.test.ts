import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/Calendar.tsx', import.meta.url), 'utf8');
const scheduleSection = '<section aria-label="Calendar schedule" className="space-y-4">';
const sourceCard = '<Card><CardTitle>Calendars</CardTitle>';

describe('calendar page visual order', () => {
  it('renders the schedule controls and calendar before the source picker', () => {
    expect(page.indexOf(scheduleSection)).toBeGreaterThan(-1);
    expect(page.indexOf(sourceCard)).toBeGreaterThan(page.indexOf(scheduleSection));
  });

  it('keeps the whole source-selection card together below the rendered calendar', () => {
    const scheduleStart = page.indexOf(scheduleSection);
    const scheduleEnd = page.indexOf('    </section>', scheduleStart);
    const sourceStart = page.indexOf(sourceCard);

    expect(scheduleEnd).toBeGreaterThan(scheduleStart);
    expect(sourceStart).toBeGreaterThan(scheduleEnd);
    expect(page.slice(sourceStart)).toContain('type="checkbox" checked={s.selected}');
    expect(page.slice(sourceStart)).toContain("s.writeDefault?'Write default':'Make default'");
    expect(page.slice(sourceStart)).not.toMatch(/(?:^|\s)(?:order-|sm:order-|md:order-|lg:order-)/);
  });

  it('uses the full practical member-content width without framing the schedule as a second app window', () => {
    expect(page).toContain('data-testid="calendar-page" className="w-full min-w-0 space-y-4"');
    expect(page).not.toMatch(/data-testid="calendar-page"[^>]+(?:max-w-|mx-auto)/);
    expect(page).toContain(scheduleSection);
    expect(page.slice(page.indexOf(scheduleSection), page.indexOf('    </section>', page.indexOf(scheduleSection)))).not.toContain('<Card>');
  });
});
