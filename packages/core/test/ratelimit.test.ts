// Rate limiting the expensive endpoints.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers.js';
import { LIMITS, consume, peek, pruneRateLimits } from '../src/ratelimit.js';

let db: TestDb;

beforeAll(async () => { db = await testDb(); });
beforeEach(async () => { await db.query(`delete from rate_limits`); });

const small = { bucket: 'test_bucket', max: 3, windowSeconds: 60 };

describe('rate limiting', () => {
  it('refuses once the allowance is spent, per subject', async () => {
    for (let i = 0; i < small.max; i += 1) {
      const v = await consume(db, { limit: small, subject: 'alice' });
      expect(v.ok, `attempt ${i + 1}`).toBe(true);
    }
    const over = await consume(db, { limit: small, subject: 'alice' });
    expect(over.ok).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.retryAfterSeconds).toBeGreaterThan(0);

    // Per subject, never global. A global counter means one person holding down
    // a button denies the feature to everybody — which is the outage the limit
    // was meant to prevent.
    const other = await consume(db, { limit: small, subject: 'bob' });
    expect(other.ok).toBe(true);
  });

  it('counts attempts, not failures', async () => {
    // Unlike sign-in, which forgets on success. What is being limited here is
    // work, and a successful expensive request costs exactly as much as a
    // failed one.
    await consume(db, { limit: small, subject: 'alice' });
    await consume(db, { limit: small, subject: 'alice' });
    const v = await peek(db, { limit: small, subject: 'alice' });
    expect(v.remaining).toBe(1);
  });

  it('starts a fresh window once the old one has passed', async () => {
    for (let i = 0; i < small.max; i += 1) await consume(db, { limit: small, subject: 'alice' });
    expect((await consume(db, { limit: small, subject: 'alice' })).ok).toBe(false);

    await db.query(
      `update rate_limits set window_started_at = now() - interval '2 minutes'
       where subject = 'alice'`,
    );
    const after = await consume(db, { limit: small, subject: 'alice' });
    expect(after.ok).toBe(true);
    expect(after.remaining).toBe(small.max - 1);
  });

  it('peeking does not spend the allowance', async () => {
    await peek(db, { limit: small, subject: 'alice' });
    await peek(db, { limit: small, subject: 'alice' });
    expect((await peek(db, { limit: small, subject: 'alice' })).remaining).toBe(small.max);
    expect(await db.query(`select 1 from rate_limits`)).toHaveLength(0);
  });

  it('is a single statement, so two concurrent requests cannot both slip through', async () => {
    // A read-then-write would let both callers see the same count. Firing the
    // whole allowance plus one at once must still refuse exactly one.
    const verdicts = await Promise.all(
      Array.from({ length: small.max + 1 }, () => consume(db, { limit: small, subject: 'race' })),
    );
    expect(verdicts.filter((v) => v.ok)).toHaveLength(small.max);
    expect(verdicts.filter((v) => !v.ok)).toHaveLength(1);
  });

  it('names its buckets, so a route cannot invent an unlimited one', () => {
    for (const [name, limit] of Object.entries(LIMITS)) {
      expect(limit.bucket, name).toBeTruthy();
      expect(limit.max, name).toBeGreaterThan(0);
      expect(limit.windowSeconds, name).toBeGreaterThan(0);
    }
    // The expensive ones the plan cares about.
    expect(LIMITS.backup.max).toBeLessThanOrEqual(10);
    expect(LIMITS.diagnostics.max).toBeLessThanOrEqual(10);
  });

  it('prunes rows outside every window', async () => {
    await consume(db, { limit: small, subject: 'alice' });
    await db.query(`update rate_limits set window_started_at = now() - interval '3 days'`);
    expect(await pruneRateLimits(db)).toBe(1);
    expect(await db.query(`select 1 from rate_limits`)).toHaveLength(0);
  });
});
