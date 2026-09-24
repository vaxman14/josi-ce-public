// Parental Controls, at the level of the decisions themselves.
//
// The HTTP suite (apps/api/test/parentalControls.test.ts) attacks the routes.
// This one attacks the three pieces of reasoning underneath them, because each
// is the kind of thing that is easy to get subtly wrong and hard to notice:
//
//   1. A LICENCE. What must be true before a paid module exists, and every way
//      it can stop being true — unsigned, edited, expired, revoked, or a
//      database carried to a different installation.
//   2. A TIMETABLE. Which minute of whose week it is, across timezones and
//      across midnight, and what "the next time this opens" means.
//   3. THE DECISION. `checkChildAccess`, which is the function every channel
//      and every route ends up asking.
import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { ensureWorkspace, getInstallId } from '../src/workspace.js';
import {
  activateEntitlement, entitlementStatus, readLicense, revokeEntitlement,
} from '../src/entitlements.js';
import {
  ScheduleError, checkChildAccess, createLink, endLink, getControls, localWeekPosition,
  minutesUsedToday, nextOpening, normalizeWindows, parentalAuthority, recordChildActivity,
  setControls, usageSummary,
} from '../src/parental.js';

const keys = generateKeyPairSync('ed25519');
/** The publisher's key as a build would carry it: raw 32 bytes, base64. */
const PUBLISHER_KEY = keys.publicKey.export({ type: 'spki', format: 'der' })
  .subarray(12).toString('base64');

interface Claim {
  v?: number; licenseId?: string; module?: string; issuedTo?: string;
  installId?: string | null; issuedAt?: string; expiresAt?: string | null;
}

function license(claim: Claim, signWith = keys.privateKey): string {
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signature = sign(null, Buffer.from(`josi-lic.1.${payload}`, 'utf8'), signWith)
    .toString('base64url');
  return `josi-lic.1.${payload}.${signature}`;
}

const GOOD = (over: Claim = {}): Claim => ({
  v: 1,
  licenseId: 'JOSI-PC-0001',
  module: 'parental_controls',
  issuedTo: 'The Example Household',
  installId: null,
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: null,
  ...over,
});

let db: TestDb;
const ids: Record<string, string> = {};

beforeEach(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.parent = (await createUser(db, { email: 'p@ce.test', username: 'parent', role: 'super_admin' })).id;
  ids.child = (await createUser(db, { email: 'c@ce.test', username: 'child', role: 'member' })).id;
  ids.other = (await createUser(db, { email: 'o@ce.test', username: 'other', role: 'member' })).id;
});

/** Turns the module on. Most tests need it on to be testing anything. */
async function entitle(over: Claim = {}): Promise<void> {
  const result = await activateEntitlement(db, {
    module: 'parental_controls',
    token: license(GOOD(over)),
    publicKey: PUBLISHER_KEY,
    actorUserId: ids.parent,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

// ---------------------------------------------------------------- 1. licence

describe('a paid module exists only against a licence somebody signed', () => {
  it('accepts one the publisher signed', () => {
    const verdict = readLicense(license(GOOD()), PUBLISHER_KEY);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claim.issuedTo).toBe('The Example Household');
  });

  it('refuses one signed by somebody else', () => {
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const verdict = readLicense(license(GOOD(), impostor), PUBLISHER_KEY);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('refuses one whose payload was edited after signing', () => {
    // The exact attack: take a real licence, extend it by a year, keep the
    // signature. The signature covers the payload bytes, so it stops matching.
    const original = license(GOOD({ expiresAt: '2026-02-01T00:00:00.000Z' }));
    const [prefix, version, , signature] = original.split('.');
    const edited = Buffer.from(JSON.stringify(GOOD({ expiresAt: '2099-01-01T00:00:00.000Z' })))
      .toString('base64url');
    const verdict = readLicense(`${prefix}.${version}.${edited}.${signature}`, PUBLISHER_KEY);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('refuses everything when the build carries no publisher key', () => {
    // A source build stamps none, so it cannot be sold a module. The message
    // says that rather than pretending the licence was wrong.
    const verdict = readLicense(license(GOOD()), null);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe('no_publisher_key');
      expect(verdict.message).toMatch(/cannot check a licence/i);
    }
  });

  it('refuses a module this version does not have', () => {
    const verdict = readLicense(license(GOOD({ module: 'mind_reading' })), PUBLISHER_KEY);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unknown_module');
  });

  it('is absent on a fresh installation, and absent means not entitled', async () => {
    const status = await entitlementStatus(db, 'parental_controls');
    expect(status.state).toBe('absent');
    expect(status.entitled).toBe(false);
  });

  it('stops being entitled once it expires, with no job to run', async () => {
    await entitle({ expiresAt: '2030-01-01T00:00:00.000Z' });
    expect((await entitlementStatus(db, 'parental_controls')).entitled).toBe(true);
    const later = new Date('2030-01-02T00:00:00.000Z');
    const status = await entitlementStatus(db, 'parental_controls', { now: later });
    expect(status.state).toBe('expired');
    expect(status.entitled).toBe(false);
  });

  it('refuses to activate one that has already expired', async () => {
    const result = await activateEntitlement(db, {
      module: 'parental_controls',
      token: license(GOOD({ expiresAt: '2020-01-01T00:00:00.000Z' })),
      publicKey: PUBLISHER_KEY,
      actorUserId: ids.parent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
    expect((await entitlementStatus(db, 'parental_controls')).state).toBe('absent');
  });

  it('does not travel with a copied database', async () => {
    // A licence that names an installation is re-checked against THIS one on
    // every read, so restoring the backup somewhere else leaves the row and
    // takes the entitlement.
    await entitle({ installId: await getInstallId(db) });
    expect((await entitlementStatus(db, 'parental_controls')).entitled).toBe(true);
    await db.query(`update install_identity set install_id = gen_random_uuid() where id = true`);
    const status = await entitlementStatus(db, 'parental_controls');
    expect(status.state).toBe('wrong_installation');
    expect(status.entitled).toBe(false);
  });

  it('refuses a licence issued to a different installation', async () => {
    const result = await activateEntitlement(db, {
      module: 'parental_controls',
      token: license(GOOD({ installId: '11111111-1111-1111-1111-111111111111' })),
      publicKey: PUBLISHER_KEY,
      actorUserId: ids.parent,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_installation');
  });

  it('can be switched off again, and remembers that it was on', async () => {
    await entitle();
    await revokeEntitlement(db, { module: 'parental_controls', actorUserId: ids.parent });
    const status = await entitlementStatus(db, 'parental_controls');
    expect(status.state).toBe('revoked');
    expect(status.entitled).toBe(false);
    expect(status.issuedTo).toBe('The Example Household');
  });

  it('records activation and refusal in the trail, and never the token', async () => {
    await activateEntitlement(db, {
      module: 'parental_controls', token: 'not-a-licence', publicKey: PUBLISHER_KEY, actorUserId: ids.parent,
    });
    await entitle();
    const events = await db.query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from events where kind like 'entitlement.%' order by id`,
    );
    expect(events.map((e) => e.kind)).toEqual(['entitlement.refused', 'entitlement.activated']);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain('josi-lic');
  });
});

// -------------------------------------------------------------- 2. timetable

describe('the timetable is read in the child’s own week', () => {
  it('places a moment in the right local weekday and minute', () => {
    // 03:30 UTC on Monday is still Sunday evening in Los Angeles.
    const moment = new Date('2026-09-07T03:30:00.000Z');
    expect(localWeekPosition(moment, 'UTC')).toMatchObject({ weekday: 1, minute: 210 });
    const la = localWeekPosition(moment, 'America/Los_Angeles');
    expect(la.weekday).toBe(0);
    expect(la.minute).toBe(20 * 60 + 30);
  });

  it('falls back to UTC rather than throwing on a timezone nobody has', () => {
    expect(localWeekPosition(new Date('2026-09-07T03:30:00.000Z'), 'Mars/Olympus').weekday).toBe(1);
  });

  it('refuses a window that ends before it starts, and says what to do instead', () => {
    expect(() => normalizeWindows([{ weekday: 1, startMinute: 1200, endMinute: 60 }]))
      .toThrow(ScheduleError);
    try {
      normalizeWindows([{ weekday: 1, startMinute: 1200, endMinute: 60 }]);
    } catch (err) {
      expect((err as Error).message).toMatch(/one window on each day/);
    }
  });

  it('refuses two windows that overlap on one day', () => {
    expect(() => normalizeWindows([
      { weekday: 3, startMinute: 480, endMinute: 720 },
      { weekday: 3, startMinute: 600, endMinute: 900 },
    ])).toThrow(/overlap/);
  });

  it('accepts the same hours on two different days', () => {
    expect(normalizeWindows([
      { weekday: 3, startMinute: 480, endMinute: 720 },
      { weekday: 4, startMinute: 480, endMinute: 720 },
    ])).toHaveLength(2);
  });

  it('says when the next window opens, in words', () => {
    const windows = [
      { weekday: 1, startMinute: 7 * 60, endMinute: 8 * 60 },
      { weekday: 1, startMinute: 16 * 60, endMinute: 19 * 60 },
      { weekday: 3, startMinute: 16 * 60, endMinute: 19 * 60 },
    ];
    expect(nextOpening(windows, { weekday: 1, minute: 6 * 60 })).toBe('07:00 today');
    expect(nextOpening(windows, { weekday: 1, minute: 9 * 60 })).toBe('16:00 today');
    expect(nextOpening(windows, { weekday: 1, minute: 20 * 60 })).toBe('16:00 on Wednesday');
    expect(nextOpening(windows, { weekday: 0, minute: 20 * 60 })).toBe('07:00 tomorrow');
  });

  it('says nothing rather than inventing a time when there are no windows', () => {
    expect(nextOpening([], { weekday: 2, minute: 100 })).toBeNull();
  });
});

// ------------------------------------------------------------- 3. the decision

describe('who may talk to Josi, and who may look', () => {
  it('grants nothing at all while the module is not entitled', async () => {
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, scheduleEnabled: true, windows: [],
    });
    // A timetable that would block everything, and a link that would grant
    // everything. Neither does anything, because nobody bought the module.
    expect(await parentalAuthority(db, { parentUserId: ids.parent, childUserId: ids.child })).toBe(false);
    const decision = await checkChildAccess(db, { userId: ids.child });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('module_inert');
  });

  it('grants the linked adult, and nobody else', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    expect(await parentalAuthority(db, { parentUserId: ids.parent, childUserId: ids.child })).toBe(true);
    // The other direction is not authority either: a child is not their
    // parent's guardian.
    expect(await parentalAuthority(db, { parentUserId: ids.child, childUserId: ids.parent })).toBe(false);
    expect(await parentalAuthority(db, { parentUserId: ids.other, childUserId: ids.child })).toBe(false);
  });

  it('ends with the relationship, taking the timetable with it', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, { childUserId: ids.child, actorUserId: ids.parent, dailyLimitMinutes: 30 });
    await recordChildActivity(db, { childUserId: ids.child, channel: 'web' });
    expect(await endLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent })).toBe(true);
    expect(await parentalAuthority(db, { parentUserId: ids.parent, childUserId: ids.child })).toBe(false);
    expect(await getControls(db, ids.child)).toBeNull();
    // And the record of when they were using Josi, which was collected to
    // enforce a rule that no longer exists.
    const [minutes] = await db.query<{ n: string }>(
      `select count(*) as n from child_activity_minutes where child_user_id = $1`, [ids.child],
    );
    expect(Number(minutes.n)).toBe(0);
    // A limit nobody may see or change is a limit nobody is responsible for.
    expect((await checkChildAccess(db, { userId: ids.child })).reason).toBe('not_managed');
  });

  it('allows a brand-new managed account with nothing set', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    const decision = await checkChildAccess(db, { userId: ids.child });
    expect(decision).toMatchObject({ allowed: true, managed: true });
  });

  it('closes outside the agreed hours, and says when it opens', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, timezone: 'UTC', scheduleEnabled: true,
      windows: normalizeWindows([{ weekday: 1, startMinute: 16 * 60, endMinute: 19 * 60 }]),
    });
    // Monday 09:00 UTC: a window exists today, later.
    const monday = new Date('2026-09-07T09:00:00.000Z');
    const shut = await checkChildAccess(db, { userId: ids.child, now: monday });
    expect(shut.allowed).toBe(false);
    expect(shut.reason).toBe('outside_schedule');
    expect(shut.opensAgain).toBe('16:00 today');

    const open = await checkChildAccess(db, { userId: ids.child, now: new Date('2026-09-07T17:00:00.000Z') });
    expect(open.allowed).toBe(true);
  });

  it('a day with no window is a day with no access, when the timetable is on', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, scheduleEnabled: true,
      windows: normalizeWindows([{ weekday: 1, startMinute: 0, endMinute: 1440 }]),
    });
    // Tuesday.
    expect((await checkChildAccess(db, { userId: ids.child, now: new Date('2026-09-08T12:00:00.000Z') })).allowed)
      .toBe(false);
  });

  it('counts a minute once however many messages are in it', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    const at = new Date('2026-09-07T10:00:30.000Z');
    for (let i = 0; i < 5; i += 1) {
      await recordChildActivity(db, { childUserId: ids.child, channel: 'web', at });
    }
    expect(await minutesUsedToday(db, { childUserId: ids.child, timezone: 'UTC', now: at })).toBe(1);
  });

  it('cuts the day in the child’s timezone, not the server’s', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    // 23:30 UTC on the 7th is already 08:30 on the 8th in Tokyo, so a minute
    // spent then belongs to tomorrow for a child living there.
    const at = new Date('2026-09-07T23:30:00.000Z');
    await recordChildActivity(db, { childUserId: ids.child, channel: 'web', at });
    expect(await minutesUsedToday(db, { childUserId: ids.child, timezone: 'UTC', now: at })).toBe(1);
    // Still the 7th in Tokyo at 12:00 UTC — the minute above is not in it.
    expect(await minutesUsedToday(db, {
      childUserId: ids.child, timezone: 'Asia/Tokyo', now: new Date('2026-09-07T12:00:00.000Z'),
    })).toBe(0);
  });

  it('stops at the daily limit and starts again the next day', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, timezone: 'UTC', dailyLimitMinutes: 5,
    });
    const day = '2026-09-07T';
    for (let i = 0; i < 5; i += 1) {
      await recordChildActivity(db, { childUserId: ids.child, channel: 'web', at: new Date(`${day}10:0${i}:00.000Z`) });
    }
    const spent = await checkChildAccess(db, { userId: ids.child, now: new Date(`${day}10:06:00.000Z`) });
    expect(spent.allowed).toBe(false);
    expect(spent.reason).toBe('daily_limit');
    expect(spent).toMatchObject({ usedMinutes: 5, limitMinutes: 5 });

    const tomorrow = await checkChildAccess(db, { userId: ids.child, now: new Date('2026-09-08T09:00:00.000Z') });
    expect(tomorrow.allowed).toBe(true);
  });

  it('refuses a limit nobody could live with, rather than storing it', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await expect(setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, dailyLimitMinutes: 1,
    })).rejects.toThrow(ScheduleError);
  });

  it('summarises days and counts, in the child’s timezone', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await recordChildActivity(db, { childUserId: ids.child, channel: 'web', at: new Date('2026-09-07T10:00:00.000Z') });
    await recordChildActivity(db, { childUserId: ids.child, channel: 'telegram', at: new Date('2026-09-07T10:01:00.000Z') });
    const summary = await usageSummary(db, {
      childUserId: ids.child, timezone: 'UTC', days: 7, now: new Date('2026-09-07T23:00:00.000Z'),
    });
    expect(summary.totalMinutes).toBe(2);
    expect(summary.days).toHaveLength(1);
    expect(summary.days[0].channels.sort()).toEqual(['telegram', 'web']);
  });

  it('writes the fields that changed and never their values', async () => {
    await entitle();
    await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, dailyLimitMinutes: 45, timezone: 'Europe/Berlin',
    });
    const [event] = await db.query<{ payload: { fields: string[] } }>(
      `select payload from events where kind = 'parental.controls_updated' order by id desc limit 1`,
    );
    expect(event.payload.fields.sort()).toEqual(['dailyLimitMinutes', 'timezone']);
    expect(JSON.stringify(event.payload)).not.toContain('45');
    expect(JSON.stringify(event.payload)).not.toContain('Berlin');
  });
});
