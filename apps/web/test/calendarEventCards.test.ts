import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../src/pages/Calendar.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

describe('time-grid event-card containment', () => {
  it('uses a clipped slot wrapper instead of a native scrolling surface', () => {
    expect(page).toContain('className="calendar-time-event"');
    expect(page).not.toContain('className="absolute overflow-auto p-px"');
    expect(css).toMatch(/\.calendar-time-event\s*\{[\s\S]*?overflow-hidden/);
    expect(css).toMatch(/\.calendar-event-card\s*\{[\s\S]*?h-full[\s\S]*?overflow-hidden/);
    expect(css).toContain('contain: layout paint');
  });

  it('keeps full accessible text while progressively revealing visual detail', () => {
    expect(page).toContain('title={`${title} — ${time} — ${metadata}`}');
    expect(page).toContain('aria-label={`${title}, ${time}, ${metadata}`}');
    expect(css).toMatch(/\.calendar-event-time,\s*\n\s*\.calendar-event-metadata \{ display: none; \}/);
    expect(css).toContain('@container calendar-event (min-height: 2.5rem)');
    expect(css).toContain('@container calendar-event (min-height: 4.5rem)');
    expect(css).toContain('@container calendar-event (min-height: 6rem)');
    expect(css).toContain('-webkit-line-clamp: 2');
  });

  it('uses spacious FullCalendar-like time rows and readable overlapping columns', () => {
    expect(page).toContain('data-testid="calendar-page" className="w-full min-w-0 space-y-4"');
    expect(page).toContain("minWidth:view==='week'?1252:496");
    expect(page).toContain('calendar-time-axis relative h-[2304px]');
    expect(page).toContain('gridTemplateColumns:`4.75rem repeat(');
    expect(page).not.toContain('sticky top-0 z-20 h-12');
    expect(page).not.toContain('sticky top-12 z-20');
    expect(page).toContain('calendar-time-grid relative h-[2304px]');
    expect(page).toContain('height:`${row.height}%`');
    expect(page).toContain('left:`${row.column/row.columns*100}%`');
    expect(page).toContain('width:`${100/row.columns}%`');
    expect(page).toContain('data-calendar-event-duration={Math.round((row.end-row.start)/60000)}');
    expect(css).toMatch(/\.calendar-event-title\s*\{[\s\S]*?text-ellipsis[\s\S]*?whitespace-nowrap/);
    expect(css).toContain('focus-visible:ring-inset');
    expect(css).not.toContain('max-height: max(28rem, calc(100vh - 24rem))');
    expect(css).toMatch(/\.calendar-time-grid-scroll\s*\{[\s\S]*?overflow-x: auto;[\s\S]*?overflow-y: visible;/);
    expect(css).not.toContain('scrollbar-gutter: stable');
    expect(css).toContain('var(--calendar-event-color, #7c3aed)');
    expect(page).toContain('calendar-all-day-event');
    expect(css).toMatch(/\.calendar-all-day-event\s*\{[\s\S]*?h-11[\s\S]*?overflow-hidden/);
  });
});
