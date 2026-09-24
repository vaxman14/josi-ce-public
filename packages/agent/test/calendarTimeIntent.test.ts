import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { resolveCalendarTimeIntent, resolveCivilMinute, validateAbsoluteCalendarRange } from '../src/calendarTimeIntent.js';

let db: TestDb; let userId: string;
beforeEach(async () => {
  db = await testDb();
  userId = (await createUser(db, { email: 'relative-time@example.test', username: 'relative-time', role: 'super_admin' })).id;
  await db.query(`insert into persona_profiles(owner_user_id,kind,content,parsed,ignored)
    values($1,'user','timezone: America/Los_Angeles',$2,'[]')`, [userId, JSON.stringify({ timezone: 'America/Los_Angeles' })]);
});

describe('server calendar time intent', () => {
  it('enforces the Sep 17 tomorrow request independently of model timestamps', async () => {
    const resolved = await resolveCalendarTimeIntent(db, {
      userId,
      latestUserText: 'tomorrow at 4pm, 45 minutes',
      effectiveNow: new Date('2026-09-18T04:00:00.000Z'),
    });
    expect(resolved).toMatchObject({
      kind: 'resolved',
      start: '2026-09-18T16:00:00-07:00',
      end: '2026-09-18T16:45:00-07:00',
      intent: { kind: 'relative_day', dayOffset: 1, localDate: '2026-09-18', localTime: '16:00', durationMinutes: 45, timeZone: 'America/Los_Angeles' },
    });
  });

  it('accepts an explicit relative local-time range without trusting model absolutes', async () => {
    expect(await resolveCalendarTimeIntent(db, {
      userId,
      latestUserText: 'tomorrow from 4pm to 5pm',
      effectiveNow: new Date('2026-09-18T04:00:00.000Z'),
    })).toMatchObject({
      kind: 'resolved',
      start: '2026-09-18T16:00:00-07:00',
      end: '2026-09-18T17:00:00-07:00',
      intent: { durationMinutes: 60 },
    });
  });

  it('carries structured relative intent into a duration-only retry', async () => {
    const first = await resolveCalendarTimeIntent(db, {
      userId, latestUserText: 'tomorrow at 4pm', effectiveNow: new Date('2026-09-18T04:00:00.000Z'),
    });
    expect(first.kind).toBe('incomplete');
    const retried = await resolveCalendarTimeIntent(db, {
      userId, latestUserText: '45 minutes', effectiveNow: new Date('2026-09-18T04:01:00.000Z'),
      existingIntent: first.kind === 'incomplete' ? first.intent : undefined,
    });
    expect(retried).toMatchObject({ kind: 'resolved', start: '2026-09-18T16:00:00-07:00', end: '2026-09-18T16:45:00-07:00' });
  });

  it('resolves bounded day offsets and refuses unsupported relative weekdays', async () => {
    expect(await resolveCalendarTimeIntent(db, {
      userId, latestUserText: 'in 2 days at 4pm for 45 minutes', effectiveNow: new Date('2026-09-18T04:00:00.000Z'),
    })).toMatchObject({ kind: 'resolved', start: '2026-09-19T16:00:00-07:00', end: '2026-09-19T16:45:00-07:00' });
    expect(await resolveCalendarTimeIntent(db, {
      userId, latestUserText: 'next Friday at 4pm for 45 minutes', effectiveNow: new Date('2026-09-18T04:00:00.000Z'),
    })).toMatchObject({ kind: 'invalid', error: 'bad_calendar_time' });
  });

  it('refuses nonexistent and ambiguous DST civil times', () => {
    expect(resolveCivilMinute('2026-03-08', '02:30', 'America/Los_Angeles')).toEqual({ ok: false, reason: 'nonexistent' });
    expect(resolveCivilMinute('2026-11-01', '01:30', 'America/Los_Angeles')).toEqual({ ok: false, reason: 'ambiguous' });
    expect(resolveCivilMinute('2026-03-08', '03:30', 'America/Los_Angeles')).toMatchObject({ ok: true, iso: '2026-03-08T03:30:00-07:00' });
    expect(resolveCivilMinute('2026-11-01', '02:30', 'America/Los_Angeles')).toMatchObject({ ok: true, iso: '2026-11-01T02:30:00-08:00' });
  });

  it('requires explicit-offset ordered absolute timestamps', () => {
    expect(validateAbsoluteCalendarRange('2026-09-18T16:00:00', '2026-09-18T16:45:00')).toMatch(/explicit ISO/);
    expect(validateAbsoluteCalendarRange('2026-09-18T16:45:00-07:00', '2026-09-18T16:00:00-07:00')).toMatch(/end is not after/);
    expect(validateAbsoluteCalendarRange('2026-09-18T16:00:00-07:00', '2026-09-18T16:45:00-07:00')).toBeNull();
  });
});
