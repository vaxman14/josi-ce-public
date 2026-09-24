// Telegram over the wire (L1.1, L1.8, L1.9, L1.10, L1.12).
//
// The unit suites prove the logic. This one proves the HTTP surface, which is
// where the access-control mistakes live: a route mounted on the wrong router,
// a DTO built with a spread, a webhook that answers before it checks a header.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, openSealed, seal } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import express from 'express';
import { createApp } from '../src/app.js';
import { adminTelegramRoutes } from '../src/http/telegramRoutes.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-telegram-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 41);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const KEY = new MasterKey(KEY_BYTES);

const TOKEN = '123456789:AAHtestTOKENvaluethatislongenough00';

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** Every request the app would have made to Telegram, so a test can assert
 * both what was sent and that nothing else was. */
let botCalls: Array<{ method: string; body: any }> = [];
let botBehaviour: (method: string) => { status: number; body: unknown } = () => ({
  status: 200, body: { ok: true, result: { id: 777, is_bot: true, username: 'josi_test_bot' } },
});

const telegramFetch: typeof fetch = async (url, init) => {
  const method = String(url).split('/').pop() ?? '';
  botCalls.push({ method, body: JSON.parse(String((init as RequestInit)?.body ?? '{}')) });
  const { status, body } = botBehaviour(method);
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
};

interface Res { status: number; body: any }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    // fetch refuses a body on GET/HEAD, and the RBAC sweep below drives every
    // route with the same `{}` body regardless of verb.
    body: opts.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await fetch(`${base}/api/auth/csrf`);
  const jar = mergeJar(undefined, pre.headers.getSetCookie?.() ?? []);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', cookie: jar,
      'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? ''),
    },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.headers.getSetCookie?.() ?? []);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

/** The webhook secret is generated server-side and never returned by any route,
 * so a test that needs it reads it the way the app does — through the master
 * key. That is itself an assertion: if a route ever started returning it, this
 * helper would be unnecessary and the leak test below would fail. */
async function webhookSecret(): Promise<string> {
  const [row] = await db.query<{ webhook_secret_enc: string }>(
    `select webhook_secret_enc from telegram_config where id = true`,
  );
  return openSealed<{ secret: string }>(KEY, row.webhook_secret_enc).secret;
}

/** A model that answers, so a routing test exercises a real turn rather than
 * the "no model configured" refusal. The provider itself is stubbed at the
 * fetch layer; what is under test here is that the turn runs as the right
 * person and the answer goes to the right chat. */
async function configureModel(): Promise<void> {
  await db.query(`delete from llm_providers`);
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,false,false,8000)`,
    [seal(KEY, { apiKey: 'k' })],
  );
}

async function configureBot(): Promise<void> {
  const res = await call('/api/admin/telegram/token', {
    method: 'POST', jar: cookies.admin, body: { token: TOKEN },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  await call('/api/admin/telegram/enabled', {
    method: 'POST', jar: cookies.admin, body: { enabled: true },
  });
}

async function linkChat(jar: string, chatId: number): Promise<string> {
  const minted = await call('/api/telegram/link-code', { method: 'POST', jar });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const res = await postWebhook({
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: 1, chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, username: `tg${chatId}` },
      text: `/start ${minted.body.code}`,
    },
  }, await webhookSecret());
  expect(res.status).toBe(200);
  return minted.body.code;
}

async function postWebhook(update: unknown, secret?: string): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  const res = await fetch(`${base}/telegram/webhook`, {
    method: 'POST', headers, body: JSON.stringify(update), redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false,
    appUrl: 'https://josi.example',
    masterKeyCheck: { path: keyPath },
    telegramFetch,
    // No backoff in a test: the retry policy is proven in the unit suite.
    telegramRetry: { maxAttempts: 1, sleep: async () => {} },
    // A model that answers instantly, so routing is what is under test.
    llmFetch: async () => new Response(JSON.stringify({
      id: 'x', model: 'test', choices: [{ message: { role: 'assistant', content: 'a reply' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    llmResolve: async () => ['203.0.113.10'],
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  botCalls = [];
  botBehaviour = () => ({
    status: 200, body: { ok: true, result: { id: 777, is_bot: true, username: 'josi_test_bot' } },
  });
  await db.query(`delete from rate_limits`);
  await db.query(`delete from llm_usage`);
  await db.query(`delete from telegram_updates`);
  await db.query(`delete from telegram_outbound`);
  await db.query(`delete from telegram_attachments`);
  await db.query(`delete from telegram_link_codes`);
  await db.query(`delete from telegram_links`);
  await db.query(`delete from messages`);
  await db.query(`delete from threads`);
  await db.query(
    `update telegram_config set enabled = false, bot_token_enc = null, webhook_secret_enc = null,
       bot_id = null, bot_username = null, webhook_url = null, webhook_set_at = null,
       probed_at = null, probe_ok = null, probe_error = null,
       attachments_enabled = false, max_attachment_bytes = 5242880
     where id = true`,
  );
});

describe('RBAC — the admin surface is administrators only (L1.9)', () => {
  const ADMIN_ROUTES: Array<[string, string]> = [
    ['GET', '/api/admin/telegram'],
    ['POST', '/api/admin/telegram/token'],
    ['POST', '/api/admin/telegram/probe'],
    ['POST', '/api/admin/telegram/webhook'],
    ['POST', '/api/admin/telegram/enabled'],
    ['POST', '/api/admin/telegram/attachments'],
    ['DELETE', '/api/admin/telegram'],
    ['GET', '/api/admin/telegram/links'],
    ['GET', '/api/admin/telegram/health'],
  ];

  it('a member is refused on every one of them', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await call(path, { method, jar: cookies.alice, body: {} });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it('an anonymous caller is refused on every one of them', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const res = await call(path, { method, body: {} });
      expect([401, 403], `${method} ${path}`).toContain(res.status);
    }
  });

  it('a member may reach their own linking surface', async () => {
    expect((await call('/api/telegram', { jar: cookies.alice })).status).toBe(200);
  });

  it('the admin router carries its OWN guard, not the one on the /admin prefix', async () => {
    // Found by mutation testing. With `/admin/telegram` mounted after
    // `/admin`, a member's request was refused by adminRoutes' guard and never
    // reached this router — so removing this router's own `requireSuperAdmin`
    // changed nothing observable, and the sweep above passed for the wrong
    // reason. The mount order is fixed; this asserts the guard directly, so it
    // stays proven whatever the mounting does next.
    const solo = express();
    solo.use(express.json());
    solo.use((req, _res, next) => {
      // A member, attached the way `attachUser` would.
      (req as unknown as { user: unknown }).user = {
        id: ids.alice, role: 'member', username: 'alice', session_id: 's',
      };
      next();
    });
    solo.use('/admin/telegram', adminTelegramRoutes({
      db, masterKey: { path: keyPath }, fetchImpl: telegramFetch, appUrl: 'https://josi.example',
    }));
    const server2 = solo.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server2.once('listening', () => r()));
    const port = (server2.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/telegram`);
      expect(res.status).toBe(403);
    } finally {
      await new Promise<void>((r) => server2.close(() => r()));
    }
  });
});

describe('setting up the bot (L1.1)', () => {
  it('refuses something that is not a BotFather token, without spending a request', async () => {
    const res = await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: 'hunter2' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('BotFather');
    expect(botCalls).toHaveLength(0);
  });

  it('proves the token against getMe and stores what the provider said', async () => {
    const res = await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: TOKEN },
    });
    expect(res.status).toBe(201);
    expect(botCalls.map((c) => c.method)).toEqual(['getMe']);
    expect(res.body.botUsername).toBe('josi_test_bot');
    // Setting a token is one decision; turning the channel on is another.
    expect(res.body.enabled).toBe(false);
  });

  it('stores NOTHING when the token is rejected', async () => {
    botBehaviour = () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    const res = await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: TOKEN },
    });
    expect(res.status).toBe(400);
    const [row] = await db.query<{ bot_token_enc: string | null; probe_ok: boolean }>(
      `select bot_token_enc, probe_ok from telegram_config where id = true`,
    );
    // A credential kept because it might work later is how a bot silently
    // never runs. The failure is recorded; the token is not.
    expect(row.bot_token_enc).toBeNull();
    expect(row.probe_ok).toBe(false);
  });

  it('seals the token, and never hands the ciphertext to the admin screen', async () => {
    await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: TOKEN },
    });
    const [row] = await db.query<{ bot_token_enc: string }>(
      `select bot_token_enc from telegram_config where id = true`,
    );
    expect(row.bot_token_enc).not.toContain(TOKEN);
    expect(openSealed<{ token: string }>(KEY, row.bot_token_enc).token).toBe(TOKEN);

    const view = await call('/api/admin/telegram', { jar: cookies.admin });
    const serialised = JSON.stringify(view.body);
    // Ciphertext is still a credential — Phase 4's M18 and Phase 7 both shipped
    // this mistake once each. A boolean answers every legitimate question.
    expect(serialised).not.toContain(row.bot_token_enc);
    expect(serialised).not.toContain(TOKEN);
    expect(view.body.telegram.tokenSet).toBe(true);
  });

  it('never returns the webhook secret to anybody', async () => {
    await configureBot();
    const secret = await webhookSecret();
    expect(secret.length).toBeGreaterThan(20);
    for (const path of ['/api/admin/telegram', '/api/admin/telegram/links', '/api/telegram']) {
      const res = await call(path, { jar: cookies.admin });
      expect(JSON.stringify(res.body), path).not.toContain(secret);
    }
  });

  it('refuses to turn the channel on before a token has passed a test', async () => {
    const res = await call('/api/admin/telegram/enabled', {
      method: 'POST', jar: cookies.admin, body: { enabled: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('bot token');
  });

  it('refuses to turn the channel on when a STORED token has failed its test', async () => {
    // Found by mutation testing. The existing test enabled with no token at
    // all, so the earlier "set a bot token first" branch answered and the probe
    // check was never reached — a mutation that dropped it survived.
    //
    // The state is reachable: a token that worked is later revoked in
    // BotFather, the admin presses Test, and the row keeps its token with
    // probe_ok = false. Enabling then would put a dead bot live.
    await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: TOKEN },
    });
    botBehaviour = () => ({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    const probe = await call('/api/admin/telegram/probe', { method: 'POST', jar: cookies.admin });
    expect(probe.body.ok).toBe(false);

    const res = await call('/api/admin/telegram/enabled', {
      method: 'POST', jar: cookies.admin, body: { enabled: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('has not passed a test');
    const [row] = await db.query<{ enabled: boolean }>(
      `select enabled from telegram_config where id = true`,
    );
    expect(row.enabled).toBe(false);
  });

  it('mints a fresh webhook secret when the token is replaced', async () => {
    await configureBot();
    const first = await webhookSecret();
    await call('/api/admin/telegram/token', {
      method: 'POST', jar: cookies.admin, body: { token: TOKEN },
    });
    // If the token was rotated because it leaked, the value that authenticates
    // inbound deliveries must not be the one that was in place while it leaked.
    expect(await webhookSecret()).not.toBe(first);
  });

  it('registers the webhook at the installation\'s own HTTPS address', async () => {
    await configureBot();
    const res = await call('/api/admin/telegram/webhook', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://josi.example/telegram/webhook');
    const setWebhook = botCalls.find((c) => c.method === 'setWebhook');
    expect(setWebhook?.body.secret_token).toBe(await webhookSecret());
    expect(setWebhook?.body.allowed_updates).toEqual(['message']);
  });

  it('removing the bot clears the credential even when Telegram cannot be reached', async () => {
    await configureBot();
    botBehaviour = () => { throw new Error('network down'); };
    const res = await call('/api/admin/telegram', { method: 'DELETE', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.webhookDeleted).toBe(false);
    const [row] = await db.query<{ bot_token_enc: string | null; enabled: boolean }>(
      `select bot_token_enc, enabled from telegram_config where id = true`,
    );
    // "We could not tell Telegram to stop" must not leave a usable token behind.
    expect(row.bot_token_enc).toBeNull();
    expect(row.enabled).toBe(false);
  });
});

describe('the webhook authenticates itself (L1.12)', () => {
  it('is invisible while the channel is off', async () => {
    const res = await postWebhook({ update_id: 1 }, 'anything');
    expect(res.status).toBe(404);
  });

  it('refuses a request with no secret header', async () => {
    await configureBot();
    const res = await postWebhook({
      update_id: 2, message: { chat: { id: 1, type: 'private' }, text: 'hi' },
    });
    expect(res.status).toBe(404);
    // Nothing was parsed for meaning, so no update was claimed.
    expect(await db.query(`select update_id from telegram_updates`)).toHaveLength(0);
  });

  it('refuses a wrong secret, and records the probe', async () => {
    await configureBot();
    const res = await postWebhook({ update_id: 3 }, 'not-the-secret');
    expect(res.status).toBe(404);
    const events = await db.query<{ kind: string }>(
      `select kind from events where kind = 'telegram.webhook_rejected'`,
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('accepts the right secret', async () => {
    await configureBot();
    const res = await postWebhook({
      update_id: 4, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'hi' },
    }, await webhookSecret());
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unlinked');
  });

  it('needs no CSRF token, because it is not on the API router', async () => {
    // The point of mounting it outside `/api`: it needs no exemption from CSRF
    // or the setup gate, because it was never behind them. An exemption is a
    // hole a later route copies by accident.
    await configureBot();
    const res = await postWebhook({ update_id: 5 }, await webhookSecret());
    expect(res.status).toBe(200);
  });

  it('answers 200 even for an update it could not handle, so Telegram stops', async () => {
    await configureBot();
    const res = await postWebhook({ update_id: 6, message: { chat: { id: 2, type: 'channel' } } },
      await webhookSecret());
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('not_private');
  });
});

describe('linking from the web app (L1.2)', () => {
  it('refuses to mint a code while the channel is off', async () => {
    const res = await call('/api/telegram/link-code', { method: 'POST', jar: cookies.alice });
    expect(res.status).toBe(409);
  });

  it('mints a code and a deep link, exactly once', async () => {
    await configureBot();
    const res = await call('/api/telegram/link-code', { method: 'POST', jar: cookies.alice });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{27}$/);
    expect(res.body.deepLink).toBe(`https://t.me/josi_test_bot?start=${res.body.code}`);
    // Nothing reads it back. The database has only a hash.
    const status = await call('/api/telegram', { jar: cookies.alice });
    expect(JSON.stringify(status.body)).not.toContain(res.body.code);
  });

  it('the person sees their own link afterwards', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9001);
    const res = await call('/api/telegram', { jar: cookies.alice });
    expect(res.body.links).toHaveLength(1);
    expect(res.body.links[0].status).toBe('active');
    expect(res.body.links[0].chatId).toBe('9001');
  });

  it('one person cannot see another\'s links', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9002);
    const res = await call('/api/telegram', { jar: cookies.bob });
    expect(res.body.links).toEqual([]);
  });
});

describe('per-user routing over the wire (L1.3)', () => {
  it('two linked people get two conversations, each their own', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9101);
    await linkChat(cookies.bob, 9102);
    const secret = await webhookSecret();

    await postWebhook({
      update_id: 7001,
      message: { chat: { id: 9101, type: 'private' }, from: { id: 9101 }, text: 'alice speaking' },
    }, secret);
    await postWebhook({
      update_id: 7002,
      message: { chat: { id: 9102, type: 'private' }, from: { id: 9102 }, text: 'bob speaking' },
    }, secret);

    const threads = await db.query<{ id: string; owner_user_id: string }>(
      `select id, owner_user_id from threads`,
    );
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((t) => t.owner_user_id))).toEqual(new Set([ids.alice, ids.bob]));

    const aliceThread = threads.find((t) => t.owner_user_id === ids.alice)!;
    const bodies = await db.query<{ body: string }>(
      `select body from messages where thread_id = $1`, [aliceThread.id],
    );
    expect(bodies.map((b) => b.body).join(' ')).toContain('alice speaking');
    expect(bodies.map((b) => b.body).join(' ')).not.toContain('bob speaking');
  });

  it('a reply is sent to the originating chat and carries the disclosure (L1.4)', async () => {
    await configureModel();
    await configureBot();
    await linkChat(cookies.alice, 9103);
    botCalls = [];
    await postWebhook({
      update_id: 7003,
      message: { chat: { id: 9103, type: 'private' }, from: { id: 9103 }, text: 'hello' },
    }, await webhookSecret());

    const sends = botCalls.filter((c) => c.method === 'sendMessage');
    expect(sends.length).toBeGreaterThan(0);
    expect(new Set(sends.map((s) => s.body.chat_id))).toEqual(new Set([9103]));
    expect(sends.map((s) => s.body.text).join('')).toContain('AI assistant');
    expect(sends[0].body.parse_mode).toBe('MarkdownV2');
  });
});

describe('unlinking and revoking (L1.8)', () => {
  it('a person unlinks their own chat and it stops working', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9201);
    const status = await call('/api/telegram', { jar: cookies.alice });
    const linkId = status.body.links[0].id;

    expect((await call(`/api/telegram/links/${linkId}`, {
      method: 'DELETE', jar: cookies.alice,
    })).status).toBe(200);

    const res = await postWebhook({
      update_id: 7101,
      message: { chat: { id: 9201, type: 'private' }, from: { id: 9201 }, text: 'still there?' },
    }, await webhookSecret());
    expect(res.body.outcome).toBe('unlinked');
  });

  it('a member cannot unlink somebody else\'s, and gets a 404 rather than a 403', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9202);
    const status = await call('/api/telegram', { jar: cookies.alice });
    const linkId = status.body.links[0].id;
    // 403 would confirm that a colleague has a link with that id.
    expect((await call(`/api/telegram/links/${linkId}`, {
      method: 'DELETE', jar: cookies.bob,
    })).status).toBe(404);
    expect((await call('/api/telegram', { jar: cookies.alice })).body.links[0].status).toBe('active');
  });

  it('a super admin can revoke anybody\'s', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9203);
    const links = await call('/api/admin/telegram/links', { jar: cookies.admin });
    expect((await call(`/api/admin/telegram/links/${links.body.links[0].id}`, {
      method: 'DELETE', jar: cookies.admin,
    })).status).toBe(200);
    expect((await call('/api/telegram', { jar: cookies.alice })).body.links[0].status).toBe('revoked');
  });
});

describe('the administrator sees plumbing, never mail (L1.9, L1.10)', () => {
  it('the link list has no chat id and no message text', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9301);
    await postWebhook({
      update_id: 7201,
      message: { chat: { id: 9301, type: 'private' }, from: { id: 9301 }, text: 'my salary is 90000' },
    }, await webhookSecret());

    const res = await call('/api/admin/telegram/links', { jar: cookies.admin });
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('90000');
    // Knowing the chat id would let an administrator who also holds the bot
    // token message a colleague's private Telegram AS Josi.
    expect(serialised).not.toContain('9301');
    expect(res.body.links[0].owner_user_id).toBe(ids.alice);
    expect(res.body.links[0].status).toBe('active');
  });

  it('the health view is counts and categories', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9302);
    await postWebhook({
      update_id: 7202,
      message: { chat: { id: 9302, type: 'private' }, from: { id: 9302 }, text: 'hello there' },
    }, await webhookSecret());

    const res = await call('/api/admin/telegram/health', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.outbound.sent).toBeGreaterThan(0);
    expect(res.body.inbound.accepted).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('hello there');
  });

  it('no audit event carries a word of a message', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9303);
    await postWebhook({
      update_id: 7203,
      message: { chat: { id: 9303, type: 'private' }, from: { id: 9303 }, text: 'the passphrase is opensesame' },
    }, await webhookSecret());

    const events = await db.query<{ kind: string; payload: unknown }>(
      `select kind, payload from events where kind like 'telegram.%' or kind = 'thread.exchange'`,
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(JSON.stringify(event.payload), event.kind).not.toContain('opensesame');
    }
  });

  it('no audit event and no stored row carries the bot token (L1.7)', async () => {
    await configureBot();
    await call('/api/admin/telegram/probe', { method: 'POST', jar: cookies.admin });
    const events = await db.query<{ payload: unknown }>(`select payload from events`);
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain(TOKEN);
    }
    const outbound = await db.query(`select * from telegram_outbound`);
    expect(JSON.stringify(outbound)).not.toContain(TOKEN);
  });
});

describe('failures are categories, not provider text (L1.7)', () => {
  it('a rejected probe reports a category and no description', async () => {
    await configureBot();
    botBehaviour = (method) => (method === 'getMe'
      ? { status: 401, body: { ok: false, description: `Unauthorized: bot${TOKEN} is invalid` } }
      : { status: 200, body: { ok: true, result: true } });

    const res = await call('/api/admin/telegram/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.category).toBe('unauthorized');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it('a person who blocked the bot has their link revoked rather than retried', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9401);
    botBehaviour = (method) => (method === 'sendMessage'
      ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }
      : { status: 200, body: { ok: true, result: { id: 777, is_bot: true, username: 'josi_test_bot' } } });

    await postWebhook({
      update_id: 7301,
      message: { chat: { id: 9401, type: 'private' }, from: { id: 9401 }, text: 'hello' },
    }, await webhookSecret());

    // Retrying a chat that will fail identically forever turns one person's
    // decision into a steady stream against the installation's rate limit.
    expect((await call('/api/telegram', { jar: cookies.alice })).body.links[0].status).toBe('revoked');
    const [row] = await db.query<{ error_category: string }>(
      `select error_category from telegram_outbound where state = 'failed' limit 1`,
    );
    expect(row.error_category).toBe('blocked_by_user');
  });
});

describe('attachments over the wire (L1.6)', () => {
  it('are refused while the administrator has them off', async () => {
    await configureBot();
    await linkChat(cookies.alice, 9501);
    await postWebhook({
      update_id: 7401,
      message: {
        chat: { id: 9501, type: 'private' }, from: { id: 9501 },
        document: { file_id: 'f', file_name: 'notes.pdf', file_size: 100, mime_type: 'application/pdf' },
      },
    }, await webhookSecret());
    const [row] = await db.query<{ outcome: string }>(`select outcome from telegram_attachments`);
    expect(row.outcome).toBe('attachments_disabled');
  });

  it('the administrator cannot set a ceiling above what Telegram will serve', async () => {
    const res = await call('/api/admin/telegram/attachments', {
      method: 'POST', jar: cookies.admin, body: { enabled: true, maxBytes: 50 * 1024 * 1024 },
    });
    expect(res.status).toBe(400);
  });

  it('an over-size file is refused with the ceiling named', async () => {
    await configureBot();
    await call('/api/admin/telegram/attachments', {
      method: 'POST', jar: cookies.admin, body: { enabled: true, maxBytes: 1024 },
    });
    await linkChat(cookies.alice, 9502);
    botCalls = [];
    await postWebhook({
      update_id: 7402,
      message: {
        chat: { id: 9502, type: 'private' }, from: { id: 9502 },
        document: { file_id: 'f', file_name: 'big.pdf', file_size: 999_999, mime_type: 'application/pdf' },
      },
    }, await webhookSecret());

    const [row] = await db.query<{ outcome: string }>(`select outcome from telegram_attachments`);
    expect(row.outcome).toBe('too_large');
    // Refused before a byte moved: no getFile was ever issued.
    expect(botCalls.filter((c) => c.method === 'getFile')).toHaveLength(0);
  });
});

// ------------------------------------------------------------ webhook replay

describe('webhook replay (T-48)', () => {
  it('processes a redelivered update exactly once', async () => {
    // Telegram redelivers when it does not see a timely 200 — a slow turn, a
    // restart mid-request, an ordinary retry. Handling it twice sends the
    // person two replies to one message and bills the model twice.
    await configureModel();
    await configureBot();
    await linkChat(cookies.alice, 9301);
    const secret = await webhookSecret();
    const update = {
      update_id: 7301,
      message: { chat: { id: 9301, type: 'private' }, from: { id: 9301 }, text: 'only once please' },
    };

    botCalls = [];
    const first = await postWebhook(update, secret);
    expect(first.status).toBe(200);
    const firstSends = botCalls.filter((c) => c.method === 'sendMessage').length;
    expect(firstSends).toBeGreaterThan(0);

    botCalls = [];
    const replay = await postWebhook(update, secret);
    // Answered, so Telegram stops retrying — but nothing happened again.
    expect(replay.status).toBe(200);
    expect(botCalls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);

    const stored = await db.query<{ update_id: string }>(
      `select update_id from telegram_updates where update_id = 7301`,
    );
    expect(stored, 'recorded once').toHaveLength(1);

    const inbound = await db.query<{ id: string }>(
      `select id from messages where body like '%only once please%'`,
    );
    expect(inbound, 'the message is not duplicated').toHaveLength(1);
  });

  it('does not let a replay of somebody else’s update reach them', async () => {
    // The update id is an attacker-supplied integer. Replaying one that was
    // already handled must not re-run it, and a fabricated one for an unlinked
    // chat must not be handled at all.
    await configureBot();
    await linkChat(cookies.alice, 9302);
    const secret = await webhookSecret();

    const forged = await postWebhook({
      update_id: 7302,
      message: { chat: { id: 999999, type: 'private' }, from: { id: 999999 }, text: 'let me in' },
    }, secret);
    expect(forged.body.outcome).not.toBe('handled');

    const threads = await db.query<{ id: string }>(`select id from threads`);
    const bodies = await db.query<{ body: string }>(
      `select body from messages where body like '%let me in%'`,
    );
    expect(bodies, 'nothing was stored for an unlinked chat').toHaveLength(0);
    void threads;
  });

  it('still refuses a replay that arrives without the webhook secret', async () => {
    // Replay protection is not a substitute for authenticating the caller.
    await configureBot();
    await linkChat(cookies.alice, 9303);
    const update = {
      update_id: 7303,
      message: { chat: { id: 9303, type: 'private' }, from: { id: 9303 }, text: 'hello' },
    };
    await postWebhook(update, await webhookSecret());

    const res = await postWebhook(update, 'not-the-secret');
    expect(res.status).toBe(404);
  });
});
