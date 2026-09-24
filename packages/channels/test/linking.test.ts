// Link codes and link rows (L1.2, L1.8).
//
// This is the trust root of the channel, so the tests are written as attacks:
// replay it, expire it, steal it, use somebody else's, take a chat that is
// already claimed, race two redemptions, revoke and try again.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { createUser } from '../../auth/src/users.js';
import { listEvents } from '../../core/src/events.js';
import {
  LINK_CODE_TTL_SECONDS, LinkError, generateLinkCode, hashLinkCode, hashesEqual,
  invalidateCodesFor, listLinksFor, mintLinkCode, pruneLinkCodes, redeemLinkCode,
  resolveChat, revokeLink,
} from '../src/telegram/linking.js';

let db: TestDb;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await testDb();
  await ensureWorkspace(db, {});
  alice = (await createUser(db, {
    email: 'alice@example.test', username: 'alice', displayName: 'Alice', role: 'super_admin',
  })).id;
  bob = (await createUser(db, {
    email: 'bob@example.test', username: 'bob', displayName: 'Bob', role: 'member',
  })).id;
});

describe('the code itself', () => {
  it('is 160 bits of CSPRNG, not something a person types', () => {
    const code = generateLinkCode();
    // 20 bytes base64url = 27 characters, no padding.
    expect(code).toMatch(/^[A-Za-z0-9_-]{27}$/);
    const many = new Set(Array.from({ length: 500 }, generateLinkCode));
    expect(many.size).toBe(500);
  });

  it('is stored only as a hash', async () => {
    const minted = await mintLinkCode(db, { userId: alice, botUsername: 'josi_bot' });
    const rows = await db.query<{ code_hash: string }>(`select code_hash from telegram_link_codes`);
    expect(rows).toHaveLength(1);
    // A dump, a screenshot, or a support ticket yields nothing redeemable.
    expect(rows[0].code_hash).not.toContain(minted.code);
    expect(rows[0].code_hash).toBe(hashLinkCode(minted.code));
    expect(rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never reaches the audit log', async () => {
    const minted = await mintLinkCode(db, { userId: alice, botUsername: 'josi_bot' });
    const events = await listEvents(db, { kind: 'telegram.link_code_minted' });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].payload)).not.toContain(minted.code);
    expect(JSON.stringify(events[0].payload)).not.toContain(hashLinkCode(minted.code));
  });

  it('produces a tappable deep link, and none when no bot is configured', async () => {
    const withBot = await mintLinkCode(db, { userId: alice, botUsername: 'josi_bot' });
    expect(withBot.deepLink).toBe(`https://t.me/josi_bot?start=${withBot.code}`);
    const without = await mintLinkCode(db, { userId: alice, botUsername: null });
    expect(without.deepLink).toBeNull();
  });

  it('compares hashes in constant time', () => {
    const a = hashLinkCode('x');
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, hashLinkCode('y'))).toBe(false);
    // Different lengths must not throw — timingSafeEqual does, and an error
    // handler that behaves differently is itself a length oracle.
    expect(hashesEqual(a, 'short')).toBe(false);
  });
});

describe('redeeming', () => {
  it('links the chat to the account that minted the code', async () => {
    const minted = await mintLinkCode(db, { userId: bob, botUsername: 'josi_bot' });
    const result = await redeemLinkCode(db, {
      code: minted.code, chatId: 555, telegramUserId: 99, telegramUsername: 'bobby',
    });
    expect(result.userId).toBe(bob);
    const link = await resolveChat(db, 555);
    expect(link?.user_id).toBe(bob);
    expect(link?.telegram_username).toBe('bobby');
    expect(link?.status).toBe('active');
  });

  it('is SINGLE USE — a replay is refused', async () => {
    const minted = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: minted.code, chatId: 1 });
    await expect(redeemLinkCode(db, { code: minted.code, chatId: 2 }))
      .rejects.toMatchObject({ reason: 'already_used' });
    // And the second chat was never created.
    expect(await resolveChat(db, 2)).toBeNull();
  });

  it('two simultaneous redemptions produce exactly one link', async () => {
    // The single-use guarantee is the conditional UPDATE, not a read-then-write.
    // pglite serialises queries, so this cannot prove genuine concurrency — what
    // it proves is that the statement is a latch rather than a check, which is
    // the property that survives a real connection pool. Phase 3 hit exactly
    // this limitation and the answer was the same: put the condition in the SQL.
    const minted = await mintLinkCode(db, { userId: bob, botUsername: null });
    const results = await Promise.allSettled([
      redeemLinkCode(db, { code: minted.code, chatId: 10 }),
      redeemLinkCode(db, { code: minted.code, chatId: 11 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const links = await db.query(`select id from telegram_links`);
    expect(links).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const minted = await mintLinkCode(db, { userId: bob, botUsername: null, ttlSeconds: 1 });
    await db.query(
      `update telegram_link_codes set expires_at = now() - interval '1 second'`,
    );
    await expect(redeemLinkCode(db, { code: minted.code, chatId: 3 }))
      .rejects.toMatchObject({ reason: 'expired' });
  });

  it('refuses a code that never existed', async () => {
    await expect(redeemLinkCode(db, { code: generateLinkCode(), chatId: 4 }))
      .rejects.toMatchObject({ reason: 'unknown_code' });
  });

  it('every refusal carries the SAME sentence, so the reason is not an oracle', async () => {
    const used = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: used.code, chatId: 20 });
    const expired = await mintLinkCode(db, { userId: alice, botUsername: null });
    await db.query(`update telegram_link_codes set expires_at = now() - interval '1 second'
                    where code_hash = $1`, [hashLinkCode(expired.code)]);

    const messages: string[] = [];
    for (const code of [used.code, expired.code, generateLinkCode()]) {
      await redeemLinkCode(db, { code, chatId: 21 }).catch((err: LinkError) => {
        messages.push(err.message);
      });
    }
    expect(messages).toHaveLength(3);
    // Telling a stranger that a code "expired" rather than "is unknown"
    // confirms the code was real. The REASON differs, for the audit log; the
    // message does not.
    expect(new Set(messages).size).toBe(1);
  });

  it('records the reason in the audit log even though the caller cannot see it', async () => {
    await redeemLinkCode(db, { code: generateLinkCode(), chatId: 30 }).catch(() => {});
    const events = await listEvents(db, { kind: 'telegram.link_refused' });
    expect(events[0].payload).toMatchObject({ reason: 'unknown_code' });
  });

  it('minting a new code kills the previous one', async () => {
    const first = await mintLinkCode(db, { userId: bob, botUsername: null });
    await mintLinkCode(db, { userId: bob, botUsername: null });
    await expect(redeemLinkCode(db, { code: first.code, chatId: 40 }))
      .rejects.toMatchObject({ reason: 'invalidated' });
  });

  it('refuses a chat that already belongs to somebody else', async () => {
    const bobs = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: bobs.code, chatId: 77 });
    const alices = await mintLinkCode(db, { userId: alice, botUsername: null });
    await expect(redeemLinkCode(db, { code: alices.code, chatId: 77 }))
      .rejects.toMatchObject({ reason: 'chat_taken' });
    // Bob still owns it. A second person cannot take over a chat by minting.
    expect((await resolveChat(db, 77))?.user_id).toBe(bob);
  });

  it('re-linking the same chat to the same person updates rather than duplicates', async () => {
    const first = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: first.code, chatId: 88, telegramUsername: 'old' });
    const second = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: second.code, chatId: 88, telegramUsername: 'new' });
    const rows = await db.query(`select id from telegram_links where chat_id = 88`);
    expect(rows).toHaveLength(1);
    expect((await resolveChat(db, 88))?.telegram_username).toBe('new');
  });

  it('the TTL is fifteen minutes', async () => {
    const minted = await mintLinkCode(db, { userId: bob, botUsername: null });
    const [row] = await db.query<{ secs: number }>(
      `select extract(epoch from (expires_at - created_at))::int as secs from telegram_link_codes`,
    );
    expect(row.secs).toBe(LINK_CODE_TTL_SECONDS);
  });
});

describe('revoking', () => {
  async function link(userId: string, chatId: number): Promise<string> {
    const minted = await mintLinkCode(db, { userId, botUsername: null });
    const result = await redeemLinkCode(db, { code: minted.code, chatId });
    return result.linkId;
  }

  it('an owner revokes their own, and the chat stops resolving', async () => {
    const id = await link(bob, 100);
    await revokeLink(db, { linkId: id, actorUserId: bob });
    expect(await resolveChat(db, 100)).toBeNull();
  });

  it('a member cannot revoke somebody else\'s, and gets a 404-shaped refusal', async () => {
    const id = await link(alice, 101);
    await expect(revokeLink(db, { linkId: id, actorUserId: bob }))
      .rejects.toMatchObject({ reason: 'not_yours' });
    // Still linked. And 'not_yours' becomes a 404 at the route, so the member
    // cannot learn that a link with that id exists at all.
    expect(await resolveChat(db, 101)).not.toBeNull();
  });

  it('a super admin can revoke anybody\'s — the one thing they may do here', async () => {
    const id = await link(bob, 102);
    await revokeLink(db, { linkId: id, actorUserId: alice, asAdmin: true });
    expect(await resolveChat(db, 102)).toBeNull();
    const events = await listEvents(db, { kind: 'telegram.unlinked' });
    expect(events[0].payload).toMatchObject({ byAdmin: true });
  });

  it('revoking also kills any outstanding code', async () => {
    const id = await link(bob, 103);
    const pending = await mintLinkCode(db, { userId: bob, botUsername: null });
    await revokeLink(db, { linkId: id, actorUserId: bob });
    // Revocation that lasts until somebody taps an old message is not
    // revocation.
    await expect(redeemLinkCode(db, { code: pending.code, chatId: 104 }))
      .rejects.toMatchObject({ reason: 'invalidated' });
  });

  it('is idempotent', async () => {
    const id = await link(bob, 105);
    await revokeLink(db, { linkId: id, actorUserId: bob });
    const again = await revokeLink(db, { linkId: id, actorUserId: bob });
    expect(again.status).toBe('revoked');
  });

  it('a revoked chat can be linked again by its owner', async () => {
    const id = await link(bob, 106);
    await revokeLink(db, { linkId: id, actorUserId: bob });
    const fresh = await mintLinkCode(db, { userId: bob, botUsername: null });
    await redeemLinkCode(db, { code: fresh.code, chatId: 106 });
    expect((await resolveChat(db, 106))?.user_id).toBe(bob);
    // Two rows now, one revoked and one active — history is kept.
    const rows = await db.query(`select status from telegram_links where chat_id = 106`);
    expect(rows).toHaveLength(2);
  });

  it('listing shows a person only their own links', async () => {
    await link(bob, 110);
    await link(alice, 111);
    const mine = await listLinksFor(db, bob);
    expect(mine).toHaveLength(1);
    expect(String(mine[0].chat_id)).toBe('110');
  });
});

describe('housekeeping', () => {
  it('prunes codes that can never be redeemed again', async () => {
    await mintLinkCode(db, { userId: bob, botUsername: null });
    await db.query(`update telegram_link_codes set created_at = now() - interval '3 days'`);
    expect(await pruneLinkCodes(db, 86_400)).toBe(1);
    expect(await db.query(`select id from telegram_link_codes`)).toHaveLength(0);
  });

  it('invalidateCodesFor touches only that person', async () => {
    await mintLinkCode(db, { userId: bob, botUsername: null });
    await mintLinkCode(db, { userId: alice, botUsername: null });
    expect(await invalidateCodesFor(db, bob)).toBe(1);
    const live = await db.query<{ user_id: string }>(
      `select user_id from telegram_link_codes where invalidated_at is null`,
    );
    expect(live).toHaveLength(1);
    expect(live[0].user_id).toBe(alice);
  });
});
