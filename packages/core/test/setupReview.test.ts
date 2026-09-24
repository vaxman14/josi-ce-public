// LB6 — the review screen tells the truth, or it does not render.
//
// The screen this replaces derived everything from "does a row exist". A
// provider key that had never been used and one that worked produced identical
// output: `status: 'configured'`. Worse, the connector line read "configured —
// accounts are connected once connector support ships" while connector support
// had shipped, so the screen was reassuring about something it had not checked
// and wrong about something it had.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  REVIEW_LABELS, blocksCompletion, getVerifications, recordVerification,
  reviewStatusFor, summarizeReview,
  type ReviewItemInput, type ReviewStatus, type Verification,
} from '../src/index.js';

const verification = (status: Verification['status'], over: Partial<Verification> = {}): Verification => ({
  item: 'llm', status, category: null, detail: null, target: null,
  checked_at: '2026-09-01T00:00:00Z', ...over,
});

const item = (over: Partial<ReviewItemInput> = {}): ReviewItemInput => ({
  key: 'llm', label: 'Language model', required: true, configured: true, verification: null, ...over,
});

describe('LB6.2 — every item is exactly one of the five states', () => {
  const cases: Array<[string, ReviewItemInput, ReviewStatus]> = [
    ['a test that passed', item({ verification: verification('passed') }), 'configured_and_tested'],
    ['a test that failed', item({ verification: verification('failed') }), 'configured_but_failed'],
    ['a step deliberately skipped', item({ required: false, configured: false, verification: verification('skipped') }), 'skipped'],
    ['something this build cannot do', item({ unavailableReason: 'Not available in this edition.' }), 'unavailable'],
    ['a required step not reached', item({ configured: false, verification: null }), 'required'],
    ['an optional step nobody touched', item({ required: false, configured: false, verification: null }), 'skipped'],
  ];

  for (const [name, input, expected] of cases) {
    it(`calls ${name} "${REVIEW_LABELS[expected]}"`, () => {
      expect(reviewStatusFor(input)).toBe(expected);
    });
  }

  it('never calls a saved-but-untested item "tested"', () => {
    // The exact defect. A row exists, nothing was contacted, and the old screen
    // called that configured and moved on.
    expect(reviewStatusFor(item({ configured: true, verification: null }))).toBe('required');
  });

  it('lets unavailability win over everything, so setup stays finishable', () => {
    // A required item that cannot exist on this build must not read as
    // outstanding work, or the wizard can never be completed.
    const impossible = item({
      required: true, configured: false, unavailableReason: 'Not available in this edition.',
    });
    expect(reviewStatusFor(impossible)).toBe('unavailable');
    expect(blocksCompletion('unavailable', true)).toBe(false);
  });

  it('lets a recorded outcome win over the mere existence of configuration', () => {
    expect(reviewStatusFor(item({ configured: true, verification: verification('failed') })))
      .toBe('configured_but_failed');
  });
});

describe('LB6.5 — a failed required item blocks completion', () => {
  it('blocks on a required failure', () => {
    expect(blocksCompletion('configured_but_failed', true)).toBe(true);
  });

  it('blocks on a required item that was never done', () => {
    expect(blocksCompletion('required', true)).toBe(true);
  });

  it('does not block on an optional failure, but does not hide it either', () => {
    expect(blocksCompletion('configured_but_failed', false)).toBe(false);
    const summary = summarizeReview([
      item({ key: 'llm', verification: verification('passed') }),
      item({ key: 'smtp', label: 'Email sending', required: false, verification: verification('failed') }),
    ]);
    expect(summary.canComplete).toBe(true);
    // Visible, and still described as a failure rather than downgraded to
    // "skipped" — which would mean "I decided not to", and nobody did.
    expect(summary.counts.configured_but_failed).toBe(1);
    expect(summary.items.find((i) => i.key === 'smtp')?.statusLabel).toBe('Configured but failed');
  });

  it('never blocks on a skipped or unavailable item', () => {
    for (const status of ['skipped', 'unavailable'] as const) {
      expect(blocksCompletion(status, true), status).toBe(false);
    }
  });

  it('refuses completion while anything required is outstanding', () => {
    const summary = summarizeReview([
      item({ key: 'llm', verification: verification('passed') }),
      item({ key: 'owner', label: 'Your account', configured: false }),
    ]);
    expect(summary.canComplete).toBe(false);
    expect(summary.blocking.map((b) => b.key)).toEqual(['owner']);
  });
});

describe('LB6.6 — the screen cannot contradict itself', () => {
  it('derives the headline from the same items it lists', () => {
    const summary = summarizeReview([
      item({ key: 'llm', verification: verification('failed') }),
    ]);
    // The old screen could say "everything is configured" above a list of
    // things that had never been contacted, because the sentence and the list
    // came from different places.
    expect(summary.headline).toContain('Language model');
    expect(summary.headline).toMatch(/before setup can finish/);
    expect(summary.canComplete).toBe(false);
  });

  it('does not claim readiness while something blocks', () => {
    const summary = summarizeReview([item({ key: 'llm', configured: false })]);
    expect(summary.headline).not.toMatch(/ready to finish/i);
  });

  it('does not claim everything is tested when something was skipped', () => {
    const summary = summarizeReview([
      item({ key: 'llm', verification: verification('passed') }),
      item({ key: 'smtp', label: 'Email sending', required: false, verification: verification('skipped') }),
    ]);
    expect(summary.canComplete).toBe(true);
    expect(summary.headline).toMatch(/skipped/);
    expect(summary.headline).toMatch(/stay on your checklist/);
  });

  it('counts every item exactly once', () => {
    const summary = summarizeReview([
      item({ key: 'a', verification: verification('passed') }),
      item({ key: 'b', verification: verification('failed'), required: false }),
      item({ key: 'c', required: false, configured: false }),
      item({ key: 'd', unavailableReason: 'no' }),
      item({ key: 'e', configured: false }),
    ]);
    const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(5);
    expect(summary.items).toHaveLength(5);
  });
});

describe('LB6.3 / LB4.6 — what is recorded, and what is not', () => {
  let db: TestDb;
  let admin: string;

  beforeEach(async () => {
    db = await testDb();
    admin = (await createUser(db, { email: 'a@ce.test', username: 'a', role: 'super_admin' })).id;
  });

  it('stores an attempt and its outcome', async () => {
    await recordVerification(db, {
      item: 'smtp', status: 'passed', target: 'ops@example.test',
      detail: 'A test message was delivered.', actorUserId: admin,
    });
    const found = (await getVerifications(db)).get('smtp');
    expect(found?.status).toBe('passed');
    expect(found?.target).toBe('ops@example.test');
  });

  it('replaces an earlier outcome rather than accumulating rows', async () => {
    await recordVerification(db, { item: 'llm', status: 'failed', category: 'authentication' });
    await recordVerification(db, { item: 'llm', status: 'passed', target: 'gpt-4.1' });
    const all = await getVerifications(db);
    expect(all.size).toBe(1);
    expect(all.get('llm')?.status).toBe('passed');
    expect(all.get('llm')?.category).toBeNull();
  });

  it('audits the attempt as metadata, without the operator-facing detail', async () => {
    await recordVerification(db, {
      item: 'llm', status: 'failed', category: 'authentication',
      detail: 'The provider rejected the credential for account ops@example.test.',
    });
    const [event] = await db.query<{ payload: any }>(
      `select payload from events where kind = 'setup.verified'`,
    );
    expect(event.payload.item).toBe('llm');
    expect(event.payload.status).toBe('failed');
    expect(event.payload.category).toBe('authentication');
    // The audit log is metadata only; the detail line is for the screen.
    expect(JSON.stringify(event.payload)).not.toContain('ops@example.test');
  });

  it('records a skip as a skip, not as a pass and not as a failure', async () => {
    await recordVerification(db, { item: 'smtp', status: 'skipped', detail: 'Skipped during setup.' });
    const found = (await getVerifications(db)).get('smtp');
    expect(found?.status).toBe('skipped');
    expect(reviewStatusFor(item({ key: 'smtp', required: false, configured: false, verification: found! })))
      .toBe('skipped');
  });

  it('refuses an outcome that is not one of the three', async () => {
    await expect(
      db.query(`insert into setup_verifications (item, status) values ('llm', 'probably_fine')`),
    ).rejects.toThrow();
  });
});
