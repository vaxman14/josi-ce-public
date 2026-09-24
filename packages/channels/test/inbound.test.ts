// Routing an inbound update (L1.3, L1.4, L1.12).
//
// The assertion that matters most in this file is that NOTHING in a Telegram
// payload chooses an account. A hostile update can name any user id, any
// username, any chat — and the only thing that decides whose assistant answers
// is a link row a signed-in person created.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { createUser } from '../../auth/src/users.js';
import { listEvents } from '../../core/src/events.js';
import { listMessages } from '../../core/src/conversations.js';
import { mintLinkCode, redeemLinkCode, resolveChat } from '../src/telegram/linking.js';
import {
  extractAttachment, handleUpdate, hasUnsupportedMedia, parseCommand, parseStartCommand,
  threadFor, webhookSecretMatches, type InboundDeps, type TelegramUpdate,
} from '../src/telegram/inbound.js';

let db: TestDb;
let alice: string;
let bob: string;
let sent: Array<{ chatId: number; text: string; kind?: string }>;
let turns: Array<{ userId: string; threadId: string; inbound: string }>;

const DISCLOSURE = 'Sent by Josi, an AI assistant.';

function deps(over: Partial<InboundDeps> = {}): InboundDeps {
  return {
    db,
    disclosure: DISCLOSURE,
    botUsername: 'josi_bot',
    attachments: { enabled: false, maxBytes: 1024 * 1024 },
    send: async (args) => { sent.push(args); },
    runTurn: async (args) => {
      turns.push(args);
      return { reply: `echo: ${args.inbound}` };
    },
    ...over,
  };
}

function message(over: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1,
      chat: { id: 500, type: 'private' },
      from: { id: 900, is_bot: false, username: 'someone' },
      text: 'hello',
      ...over,
    },
  };
}

async function link(userId: string, chatId: number): Promise<void> {
  const minted = await mintLinkCode(db, { userId, botUsername: null });
  await redeemLinkCode(db, { code: minted.code, chatId });
}

beforeEach(async () => {
  db = await testDb();
  await ensureWorkspace(db, {});
  alice = (await createUser(db, { email: 'a@example.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@example.test', username: 'bob', role: 'member' })).id;
  sent = [];
  turns = [];
});

describe('the webhook secret (L1.12)', () => {
  it('matches only an exact value', () => {
    expect(webhookSecretMatches('abc123', 'abc123')).toBe(true);
    expect(webhookSecretMatches('abc124', 'abc123')).toBe(false);
    expect(webhookSecretMatches('abc12', 'abc123')).toBe(false);
    expect(webhookSecretMatches('abc1234', 'abc123')).toBe(false);
  });

  it('refuses a missing or non-string header without comparing', () => {
    for (const provided of [undefined, null, 42, {}, []]) {
      expect(webhookSecretMatches(provided, 'abc123')).toBe(false);
    }
  });

  it('refuses when nothing is expected, rather than matching the empty string', () => {
    // An installation with no secret configured must not accept a request that
    // also sends no secret.
    expect(webhookSecretMatches('', '')).toBe(false);
    expect(webhookSecretMatches('anything', '')).toBe(false);
  });
});

describe('idempotence', () => {
  it('a redelivered update_id is dropped', async () => {
    await link(bob, 500);
    const update = message();
    expect(await handleUpdate(deps(), update)).toBe('accepted');
    // Telegram redelivers until it gets a 2xx, and a slow model call is exactly
    // the case that produces one — so without this, the expensive path runs
    // twice and charges the cap twice.
    expect(await handleUpdate(deps(), update)).toBe('ignored');
    expect(turns).toHaveLength(1);
  });

  it('records the outcome against the update', async () => {
    await link(bob, 500);
    const update = message();
    await handleUpdate(deps(), update);
    const [row] = await db.query<{ outcome: string }>(
      `select outcome from telegram_updates where update_id = $1`, [update.update_id],
    );
    expect(row.outcome).toBe('accepted');
  });
});

describe('shape', () => {
  it('refuses a group chat outright', async () => {
    // A group has no single owner, so routing a group message to one person's
    // assistant would let everyone else in that group talk as them.
    await link(bob, -100500);
    const outcome = await handleUpdate(deps(), message({ chat: { id: -100500, type: 'supergroup' } }));
    expect(outcome).toBe('not_private');
    expect(turns).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const events = await listEvents(db, { kind: 'telegram.refused' });
    expect(events[0].payload).toMatchObject({ reason: 'not_private' });
  });

  it('ignores a message from another bot', async () => {
    await link(bob, 500);
    expect(await handleUpdate(deps(), message({ from: { id: 1, is_bot: true } }))).toBe('ignored');
    expect(turns).toHaveLength(0);
  });

  it('ignores an update with no message at all', async () => {
    expect(await handleUpdate(deps(), { update_id: 1 })).toBe('ignored');
  });

  it('answers unsupported media by name rather than going silent', async () => {
    await link(bob, 500);
    const outcome = await handleUpdate(deps(), message({ text: undefined, voice: { file_id: 'v' } }));
    expect(outcome).toBe('refused');
    expect(sent[0].text).toContain('cannot read that kind of message');
  });
});

describe('identity — nothing in the payload chooses an account', () => {
  it('an unlinked chat is refused and told how to link', async () => {
    const outcome = await handleUpdate(deps(), message());
    expect(outcome).toBe('unlinked');
    expect(turns).toHaveLength(0);
    expect(sent[0].text).toContain('not linked');
  });

  it('a linked chat reaches ITS OWN owner, whatever the payload claims', async () => {
    await link(bob, 500);
    // The update names Alice's Telegram handle and a different `from` id. Both
    // are attacker-chosen and neither is consulted.
    await handleUpdate(deps(), message({
      from: { id: 1, is_bot: false, username: 'alice' },
    }));
    expect(turns).toHaveLength(1);
    expect(turns[0].userId).toBe(bob);
  });

  it('two people on one bot get two conversations, and neither sees the other', async () => {
    await link(alice, 501);
    await link(bob, 502);

    await handleUpdate(deps(), message({ chat: { id: 501, type: 'private' }, text: 'alice here' }));
    await handleUpdate(deps(), message({ chat: { id: 502, type: 'private' }, text: 'bob here' }));

    expect(turns).toHaveLength(2);
    expect(turns[0].userId).toBe(alice);
    expect(turns[1].userId).toBe(bob);
    // Different threads, and each owned by its own person.
    expect(turns[0].threadId).not.toBe(turns[1].threadId);

    const threads = await db.query<{ id: string; owner_user_id: string }>(
      `select id, owner_user_id from threads order by created_at`,
    );
    expect(threads.map((t) => t.owner_user_id).sort()).toEqual([alice, bob].sort());

    // And the words landed in the right one.
    const aliceThread = threads.find((t) => t.owner_user_id === alice)!;
    const bodies = (await listMessages(db, { threadId: aliceThread.id })).map((m) => m.body);
    expect(bodies).toContain('alice here');
    expect(bodies.join(' ')).not.toContain('bob here');
  });

  it('an unlinked chat is refused EVEN WHEN other people are linked', async () => {
    // Found by mutation testing, and it is the worst bug this channel could
    // have. The original test used a database with no links at all, so a
    // mutation that resolved an unknown chat to "whichever link happens to be
    // first" passed every assertion — a stranger messaging the bot would have
    // been answered as somebody else, with their memory, their conversation and
    // their name on it.
    await link(alice, 601);
    await link(bob, 602);

    const outcome = await handleUpdate(deps(), message({
      chat: { id: 999, type: 'private' },
      from: { id: 999, is_bot: false, username: 'stranger' },
      text: 'who am I talking to?',
    }));

    expect(outcome).toBe('unlinked');
    expect(turns).toHaveLength(0);
    expect(sent[0].text).toContain('not linked');
    // And nothing was written into anybody's conversation.
    const messages = await db.query(`select id from messages`);
    expect(messages).toHaveLength(0);
  });

  it('a revoked link stops working on the very next message', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message());
    await db.query(`update telegram_links set status = 'revoked', revoked_at = now()`);
    const outcome = await handleUpdate(deps(), message({ text: 'still there?' }));
    expect(outcome).toBe('unlinked');
    expect(turns).toHaveLength(1);
  });
});

describe('/start linking from inside the chat', () => {
  it('redeems a code and confirms', async () => {
    const minted = await mintLinkCode(db, { userId: bob, botUsername: 'josi_bot' });
    const outcome = await handleUpdate(deps(), message({ text: `/start ${minted.code}` }));
    expect(outcome).toBe('accepted');
    expect((await resolveChat(db, 500))?.user_id).toBe(bob);
    expect(sent[0].text).toContain('now linked');
    // Linking is not a turn. Nothing was asked, so nothing is answered.
    expect(turns).toHaveLength(0);
  });

  it('a bad code gets the one indistinguishable refusal', async () => {
    const outcome = await handleUpdate(deps(), message({ text: '/start not-a-real-code' }));
    expect(outcome).toBe('refused');
    expect(sent[0].text).toContain('cannot be used');
    expect(await resolveChat(db, 500)).toBeNull();
  });

  it('a bare /start from an unlinked chat explains rather than errors', async () => {
    expect(await handleUpdate(deps(), message({ text: '/start' }))).toBe('unlinked');
    expect(sent[0].text).toContain('Settings');
  });

  it('/start on an already linked chat says so and does not re-link', async () => {
    await link(bob, 500);
    const minted = await mintLinkCode(db, { userId: alice, botUsername: null });
    const outcome = await handleUpdate(deps(), message({ text: `/start ${minted.code}` }));
    expect(outcome).toBe('accepted');
    expect(sent[0].text).toContain('already linked');
    // Alice did not take over Bob's chat.
    expect((await resolveChat(db, 500))?.user_id).toBe(bob);
  });

  it('parses the command exactly', () => {
    expect(parseStartCommand('/start abc')).toBe('abc');
    expect(parseStartCommand('/start')).toBe('');
    expect(parseStartCommand('/start@josi_bot xyz')).toBe('xyz');
    expect(parseStartCommand('hello')).toBeNull();
    expect(parseStartCommand('/startle')).toBeNull();
    // Length-capped before it goes near a lookup: a code is 27 characters and
    // anything longer is not a near miss.
    expect(parseStartCommand(`/start ${'a'.repeat(500)}`)).toBeNull();
  });
});

describe('/unlink from inside the chat', () => {
  it('works, because somebody locked out of the web app will reach for it', async () => {
    await link(bob, 500);
    const outcome = await handleUpdate(deps(), message({ text: '/unlink' }));
    expect(outcome).toBe('accepted');
    expect(await resolveChat(db, 500)).toBeNull();
    expect(sent[0].text).toContain('no longer linked');
  });

  it('an unlinked chat cannot unlink anything', async () => {
    expect(await handleUpdate(deps(), message({ text: '/unlink' }))).toBe('unlinked');
  });

  it('parses commands with a bot suffix and ignores the rest', () => {
    expect(parseCommand('/unlink')).toBe('/unlink');
    expect(parseCommand('/UNLINK@josi_bot')).toBe('/unlink');
    expect(parseCommand('/help me')).toBe('/help');
    expect(parseCommand('unlink')).toBeNull();
  });
});

describe('the reply', () => {
  it('carries the disclosure', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message());
    // M41's discipline, in a different envelope. The wording is the operator's;
    // the presence is not negotiable.
    expect(sent.map((s) => s.text).join('')).toContain('Sent by Josi, an AI assistant');
  });

  it('goes only to the originating chat', async () => {
    await link(alice, 501);
    await link(bob, 502);
    await handleUpdate(deps(), message({ chat: { id: 502, type: 'private' } }));
    expect(new Set(sent.map((s) => s.chatId))).toEqual(new Set([502]));
  });

  it('is escaped for MarkdownV2', async () => {
    await link(bob, 500);
    await handleUpdate(deps({
      runTurn: async () => ({ reply: 'Cost: $40 (approx.)' }),
    }), message());
    expect(sent[0].text).toContain('\\(approx\\.\\)');
  });

  it('is split when it is long', async () => {
    await link(bob, 500);
    await handleUpdate(deps({
      runTurn: async () => ({ reply: 'z'.repeat(9000) }),
    }), message());
    expect(sent.length).toBeGreaterThan(2);
    for (const chunk of sent) expect(chunk.text.length).toBeLessThanOrEqual(4096);
  });

  it('relays a refusal verbatim and never dresses it as an answer', async () => {
    await link(bob, 500);
    const outcome = await handleUpdate(deps({
      runTurn: async () => ({ reply: '', refusal: { message: 'No model is configured.' } }),
    }), message());
    expect(outcome).toBe('refused');
    expect(sent[0].text).toBe('No model is configured.');
    // The question is still recorded, so the conversation is not missing what
    // the person said — but no reply was invented.
    const [thread] = await db.query<{ id: string }>(`select id from threads`);
    const bodies = (await listMessages(db, { threadId: thread.id })).map((m) => m.body);
    expect(bodies).toEqual(['hello']);
  });

  it('a crashed turn answers rather than going silent, and does not throw', async () => {
    await link(bob, 500);
    const outcome = await handleUpdate(deps({
      runTurn: async () => { throw new Error('boom'); },
    }), message());
    // A webhook handler that throws makes Telegram redeliver, and redelivering
    // something that failed deterministically is a loop.
    expect(outcome).toBe('failed');
    expect(sent[0].text).toContain('Something went wrong');
  });

  it('records the exchange as an ordinary conversation', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message({ text: 'what is the time' }));
    const [thread] = await db.query<{ id: string; owner_user_id: string }>(`select * from threads`);
    expect(thread.owner_user_id).toBe(bob);
    const messages = await listMessages(db, { threadId: thread.id });
    expect(messages.map((m) => [m.direction, m.channel, m.body])).toEqual([
      ['in', 'telegram', 'what is the time'],
      ['out', 'telegram', 'echo: what is the time'],
    ]);
  });

  it('persists the typed retry target returned by the assistant', async () => {
    await link(bob, 500);
    const retry = { version: 1, kind: 'read_tool', domain: 'workspace', tool: 'list_workspace_mappings', input: {} };
    await handleUpdate(deps({ runTurn: async () => ({ reply: 'Workspace discovery failed.', retry }) }), message());
    const [thread] = await db.query<{ id: string }>(`select id from threads`);
    const messages = await listMessages(db, { threadId: thread.id });
    expect(messages.at(-1)?.meta.retry).toEqual(retry);
  });

  it('the audit log records lengths, not words', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message({ text: 'my bank pin is 1234' }));
    const events = await listEvents(db, { kind: 'thread.exchange' });
    expect(JSON.stringify(events[0].payload)).not.toContain('1234');
    expect(events[0].payload).toMatchObject({ channel: 'telegram' });
  });
});

describe('one thread per link', () => {
  it('reuses the same conversation across messages', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message({ text: 'one' }));
    await handleUpdate(deps(), message({ text: 'two' }));
    expect(await db.query(`select id from threads`)).toHaveLength(1);
    expect(turns[0].threadId).toBe(turns[1].threadId);
  });

  it('creates a new one if the conversation was deleted', async () => {
    await link(bob, 500);
    const linkRow = (await resolveChat(db, 500))!;
    const first = await threadFor(db, linkRow);
    await db.query(`delete from threads where id = $1`, [first]);
    const second = await threadFor(db, (await resolveChat(db, 500))!);
    expect(second).not.toBe(first);
  });
});

describe('rate limiting', () => {
  it('an unlinked chat holding down send is cut off, silently', async () => {
    // Silence rather than a "slow down" reply: answering a flood is
    // participating in it, and the person doing it is not reading.
    let outcome = '';
    for (let i = 0; i < 25; i += 1) {
      outcome = await handleUpdate(deps(), message({ text: `spam ${i}` }));
    }
    expect(outcome).toBe('refused');
    const events = await listEvents(db, { kind: 'telegram.rate_limited' });
    expect(events.length).toBeGreaterThan(0);
  });

  it('the allowance is per chat, so one person cannot mute another', async () => {
    await link(alice, 501);
    await link(bob, 502);
    for (let i = 0; i < 25; i += 1) {
      await handleUpdate(deps(), message({ chat: { id: 501, type: 'private' }, text: `x${i}` }));
    }
    const outcome = await handleUpdate(deps(), message({ chat: { id: 502, type: 'private' } }));
    expect(outcome).toBe('accepted');
  });
});

describe('attachments in a message', () => {
  it('are refused with a reason when the administrator has them off', async () => {
    await link(bob, 500);
    const outcome = await handleUpdate(deps(), message({
      text: undefined,
      document: { file_id: 'f', file_name: 'a.pdf', file_size: 10, mime_type: 'application/pdf' },
    }));
    expect(outcome).toBe('refused');
    expect(sent[0].text).toContain('does not accept files');
    const [row] = await db.query<{ outcome: string }>(`select outcome from telegram_attachments`);
    expect(row.outcome).toBe('attachments_disabled');
  });

  it('a refused attachment with a caption still gets its question answered', async () => {
    await link(bob, 500);
    await handleUpdate(deps(), message({
      text: undefined,
      caption: 'can you read this?',
      document: { file_id: 'f', file_name: 'a.exe', file_size: 10 },
    }));
    expect(turns).toHaveLength(1);
    expect(turns[0].inbound).toBe('can you read this?');
  });

  it('takes the largest photo size, not a thumbnail', () => {
    const attachment = extractAttachment({
      photo: [
        { file_id: 'small', file_size: 100 },
        { file_id: 'big', file_size: 90_000 },
        { file_id: 'medium', file_size: 5000 },
      ],
    } as never);
    expect(attachment?.fileId).toBe('big');
  });

  it('spots media CE cannot read', () => {
    expect(hasUnsupportedMedia({ voice: {} } as never)).toBe(true);
    expect(hasUnsupportedMedia({ video: {} } as never)).toBe(true);
    expect(hasUnsupportedMedia({ sticker: {} } as never)).toBe(true);
    expect(hasUnsupportedMedia({ text: 'hi' } as never)).toBe(false);
  });
});
