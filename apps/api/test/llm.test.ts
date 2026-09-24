// Phase 4 over the wire.
//
// The package tests prove the rules; these prove the rules are actually
// reachable through the HTTP surface, and that the surface does not leak the
// things it holds — API keys, prompts, replies, or one member's usage to
// another.
//
// No provider is contacted. `llmFetch` and `llmResolve` are injected into the
// app, so a suite that accidentally reached the network would fail rather than
// quietly bill someone.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { looksSealed } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-llm-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

// ---- the stubbed provider -------------------------------------------------
/** What the next provider call returns. Each test sets this; nothing here ever
 * opens a socket to anywhere real. */
let respond: (url: string, init: RequestInit) => Response = () => new Response('{}');
let calls: string[] = [];

const llmFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  calls.push(String(url));
  return respond(String(url), init ?? {});
}) as unknown as typeof fetch;

const llmResolve = async (hostname: string): Promise<string[]> => {
  // A small fake DNS so endpoint validation is exercised without touching a
  // resolver: the names a test uses decide what they resolve to.
  if (hostname === 'metadata.test') return ['169.254.169.254'];
  if (hostname === 'ollama') return ['172.18.0.9'];
  return ['203.0.113.10'];
};

/** A capable model, in whichever dialect was asked for.
 *
 * The vision probe step is detected by its request body carrying an image
 * block (Anthropic) or simply answered honestly (OpenAI-shaped adapter has no
 * code path that sends `images` at all today, so a "fully capable" fixture on
 * that dialect is still vision:false — which is the true, current behaviour of
 * that adapter, not a gap in the fixture). */
function capableModel(url: string, init?: RequestInit): Response {
  const anthropic = url.includes('anthropic');
  const requestBody = init?.body ? String(init.body) : '';
  const isVisionProbe = anthropic && requestBody.includes('"type":"image"');
  if (isVisionProbe) {
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: 'Red' }], usage: { input_tokens: 10, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const body = anthropic
    ? { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'tool_use', id: 't', name: 'record_number', input: { value: 7 } }], usage: { input_tokens: 10, output_tokens: 5 } }
    : {
        choices: [{ message: { content: '{"ok":true}', tool_calls: [{ id: 't', function: { name: 'record_number', arguments: '{"value":7}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- browser-shaped client ------------------------------------------------
interface Res { status: number; body: any; setCookie: string[] }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [] };
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
  const pre = await call('/api/auth/csrf');
  let jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

// Deliberately NOT shaped like a real key: the secret scanner refuses an
// `sk-` fixture, and it is right to — a repo should not contain key-shaped
// strings even as test data. What matters here is that the value is unique.
const SECRET_KEY = 'PHASE4-FIXTURE-not-a-real-credential';

/** Configure the primary provider through the API, the way an operator would. */
async function configure(over: Record<string, unknown> = {}): Promise<Res> {
  return call('/api/admin/llm/providers/primary', {
    method: 'PUT', jar: cookies.admin,
    body: { provider: 'openai', model: 'gpt-test', apiKey: SECRET_KEY, externalAcknowledged: true, ...over },
  });
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: 'admin-password-123' })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: 'alice-password-123' })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: 'bob-password-123' })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, llmFetch, llmResolve,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', 'admin-password-123');
  cookies.alice = await signIn('alice', 'alice-password-123');
  cookies.bob = await signIn('bob', 'bob-password-123');
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  calls = [];
  respond = (url, init) => capableModel(url, init);
  await db.query(`delete from llm_providers`);
  await db.query(`delete from llm_usage`);
  await db.query(`delete from llm_user_caps`);
  await db.query(`update llm_caps set monthly_cost_usd = null, monthly_tokens = null where id = true`);
  await db.query(`update security_policy set local_only = false where id = true`);
});

describe('who may configure a model', () => {
  it('refuses anonymous and member callers on every admin route', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/admin/llm'],
      ['PUT', '/api/admin/llm/providers/primary'],
      ['POST', '/api/admin/llm/providers/primary/probe'],
      ['PUT', '/api/admin/llm/local-only'],
      ['PUT', '/api/admin/llm/caps'],
      ['GET', '/api/admin/llm/usage'],
    ];
    // A CSRF token with no session: otherwise the CSRF guard would answer
    // first and the authorization check would never be reached, which is not
    // what this test is about.
    const anonJar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);

    for (const [method, path] of routes) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(path, { method, body, jar: anonJar })).status, `anon ${path}`).toBe(401);
      expect((await call(path, { method, body, jar: cookies.alice })).status, `member ${path}`).toBe(403);
    }
  });
});

describe('storing a provider', () => {
  it('seals the API key and never returns it', async () => {
    const res = await configure();
    expect(res.status).toBe(200);
    expect(res.body.provider.apiKeySet).toBe(true);

    const [row] = await db.query<{ api_key_enc: string }>(`select api_key_enc from llm_providers where role = 'primary'`);
    expect(looksSealed(row.api_key_enc)).toBe(true);
    expect(row.api_key_enc).not.toContain(SECRET_KEY);

    // Not through the config endpoint, not through the audit log.
    const dump = JSON.stringify([res.body, (await call('/api/admin/llm', { jar: cookies.admin })).body,
      await db.query(`select * from events`)]);
    expect(dump).not.toContain(SECRET_KEY);
  });

  it('never returns the CIPHERTEXT either', async () => {
    // Found by mutation M18, which added the sealed value to the DTO and passed
    // every test: asserting only that the plaintext is absent is not enough.
    // Ciphertext is still a credential — serving it hands an attacker something
    // to work on offline, and "a key is set" answers every real question.
    await configure();
    for (const path of ['/api/admin/llm', '/api/llm/status']) {
      const dump = JSON.stringify((await call(path, { jar: path.startsWith('/api/admin') ? cookies.admin : cookies.alice })).body);
      expect(dump, path).not.toMatch(/v1\.[A-Za-z0-9+/=]{10}/);
      expect(dump, path).not.toMatch(/api_?key_?(enc|ciphertext)/i);
    }
    const put = await configure({ model: 'gpt-test-2' });
    expect(JSON.stringify(put.body)).not.toMatch(/v1\.[A-Za-z0-9+/=]{10}/);
  });

  it('refuses a hosted provider without the acknowledgment', async () => {
    const res = await configure({ externalAcknowledged: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/leaves this server/);
    expect(await db.query(`select 1 from llm_providers`)).toHaveLength(0);
  });

  it('refuses a self-hosted endpoint that resolves to cloud metadata', async () => {
    const res = await configure({
      provider: 'openai_compatible', baseUrl: 'http://metadata.test/v1', apiKey: '', externalAcknowledged: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/);
  });

  it('accepts a self-hosted endpoint on the Docker network', async () => {
    const res = await configure({
      provider: 'openai_compatible', model: 'llama3', baseUrl: 'http://ollama:11434/v1',
      apiKey: '', externalAcknowledged: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.provider.external).toBe(false);
  });

  it('leaves the provider inactive until it has been probed', async () => {
    const res = await configure();
    expect(res.body.provider.active).toBe(false);
    expect(res.body.needsProbe).toBe(true);
    expect(res.body.provider.capabilities).toBeNull();
  });

  it('clears a previous probe result when the model is changed', async () => {
    await configure();
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect((await call('/api/admin/llm', { jar: cookies.admin })).body.primary.active).toBe(true);

    // A different model is a different set of capabilities. Carrying the old
    // ones over would enable features against something never tested.
    const changed = await configure({ model: 'some-other-model' });
    expect(changed.body.provider.active).toBe(false);
    expect(changed.body.provider.capabilities).toBeNull();
    expect(changed.body.provider.probeSteps).toEqual([]);
  });

  it('keeps the stored key when the key field is left empty on an update', async () => {
    await configure();
    const before = (await db.query<{ api_key_enc: string }>(`select api_key_enc from llm_providers`))[0].api_key_enc;
    await configure({ apiKey: '' });
    const after = (await db.query<{ api_key_enc: string }>(`select api_key_enc from llm_providers`))[0].api_key_enc;
    expect(after).toBe(before);
  });
});

describe('probing', () => {
  it('records what the model did and activates it', async () => {
    await configure();
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.provider.active).toBe(true);
    // Configured on the OpenAI-shaped dialect, whose adapter has no code path
    // that sends `images` yet — so a fully capable model on THIS adapter is
    // still honestly vision:false, and chat_vision is the one disabled feature.
    expect(res.body.provider.capabilities).toMatchObject({
      chat: true, structuredOutput: true, toolCalling: true, vision: false,
    });
    expect(res.body.disabledFeatures.map((d: any) => d.feature)).toEqual(['chat_vision']);
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it('activates vision when the configured model is actually shown the test image and answers correctly', async () => {
    // The Anthropic dialect's adapter DOES send `images` — configure primary
    // on that provider so the vision probe step has a real path to prove.
    await configure({ provider: 'anthropic', model: 'claude-test' });
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.provider.capabilities).toMatchObject({
      chat: true, structuredOutput: true, toolCalling: true, vision: true,
    });
    expect(res.body.disabledFeatures).toEqual([]);
  });

  it('disables exactly the tool-dependent features when the model will not call tools', async () => {
    await configure();
    respond = () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.body.provider.capabilities.toolCalling).toBe(false);
    // This stub never answers the vision probe's question correctly either
    // (it always returns the same JSON-shaped text), and this dialect's
    // adapter has no `images` code path regardless — so chat_vision is off
    // here too, honestly, alongside the tool-dependent features.
    expect(res.body.disabledFeatures.map((d: any) => d.feature).sort())
      .toEqual(['calendar_tools', 'chat_vision', 'document_search', 'email_tools']);
    const toolReasons = res.body.disabledFeatures.filter((d: any) => d.feature !== 'chat_vision');
    for (const d of toolReasons) expect(d.reason).toMatch(/tool calling/);
    // Chat still works, so the provider stays usable for what it can do.
    expect(res.body.provider.active).toBe(true);
  });

  it('leaves the provider inactive when it cannot hold a conversation', async () => {
    await configure();
    respond = () => new Response(JSON.stringify({ error: { message: 'bad key: sk-leaked' } }), { status: 401 });

    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.body.provider.active).toBe(false);
    expect(res.body.result.fatal).toBeTruthy();
    // The provider's own text can quote the request. It must not reach the UI.
    expect(JSON.stringify(res.body)).not.toContain('sk-leaked');
    // And every feature is off, with a reason.
    expect(res.body.disabledFeatures.length).toBeGreaterThan(0);
  });

  it('deactivates a provider that used to work and no longer does', async () => {
    await configure();
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    respond = () => new Response('{}', { status: 500 });
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.body.provider.active).toBe(false);
  });

  it('records what the probe itself cost, because it is real requests on a real invoice', async () => {
    await configure();
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    const rows = await db.query<{ purpose: string; input_tokens: number }>(
      `select purpose, input_tokens from llm_usage`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((r) => r.purpose === 'probe')).toBe(true);
    expect(rows.every((r) => r.input_tokens === 10)).toBe(true);
  });

  it('can still be run after the cap is reached, so a broken model can be replaced', async () => {
    await configure();
    await db.query(`update llm_caps set monthly_cost_usd = 1 where id = true`);
    await db.query(
      `insert into llm_usage (provider, model, role, cost_usd, cost_source) values ('openai','m','primary',50,'estimated')`,
    );
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.provider.active).toBe(true);
  });

  it('returns probe steps as a LIST, not a string that happens to have a length', async () => {
    // The Phase 6 browser run found the admin model page crashing on
    // `probeSteps.map is not a function`. The column had been written with
    // JSON.stringify + ::jsonb instead of the json() helper, which stores a
    // jsonb string scalar — silent in pglite, permanent in production.
    //
    // Asserting the TYPE rather than the truthiness is the point: the UI guard
    // used `?.length`, and a string has one.
    await configure();
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.provider.probeSteps)).toBe(true);
    expect(res.body.provider.probeSteps.length).toBeGreaterThan(0);
    expect(typeof res.body.provider.probeSteps[0]).toBe('object');
    expect(res.body.provider.probeSteps[0]).toHaveProperty('label');

    // And through the config endpoint, which is what the page actually reads.
    const view = await call('/api/admin/llm', { jar: cookies.admin });
    expect(Array.isArray(view.body.primary.probeSteps)).toBe(true);
    expect(typeof view.body.primary.probeSteps[0]).toBe('object');
  });

  it('refuses to probe a provider that is not configured', async () => {
    expect((await call('/api/admin/llm/providers/fallback/probe', { method: 'POST', jar: cookies.admin })).status).toBe(404);
  });

  it('refuses a made-up provider slot', async () => {
    expect((await call('/api/admin/llm/providers/tertiary/probe', { method: 'POST', jar: cookies.admin })).status).toBe(404);
  });
});

describe('Local-only mode', () => {
  it('refuses to store a hosted provider while it is on', async () => {
    await call('/api/admin/llm/local-only', { method: 'PUT', jar: cookies.admin, body: { enabled: true } });
    const res = await configure();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Local-only/);
    expect(await db.query(`select 1 from llm_providers`)).toHaveLength(0);
  });

  it('refuses to turn on while a hosted provider is already configured', async () => {
    await configure();
    const res = await call('/api/admin/llm/local-only', { method: 'PUT', jar: cookies.admin, body: { enabled: true } });
    expect(res.status).toBe(409);
    // And it did NOT half-apply: the flag is still off.
    expect((await call('/api/admin/llm', { jar: cookies.admin })).body.localOnly).toBe(false);
  });

  it('refuses to probe a hosted provider that predates the flag', async () => {
    await configure();
    // Force the flag on around the API's guard, the way a restored database or
    // a hand-edited row would.
    await db.query(`update security_policy set local_only = true where id = true`);
    const res = await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Local-only/);
    // The refusal happened before anything was sent anywhere.
    expect(calls).toHaveLength(0);
  });

  it('allows a self-hosted provider while it is on', async () => {
    await call('/api/admin/llm/local-only', { method: 'PUT', jar: cookies.admin, body: { enabled: true } });
    const res = await configure({
      provider: 'openai_compatible', model: 'llama3', baseUrl: 'http://ollama:11434/v1',
      apiKey: '', externalAcknowledged: false,
    });
    expect(res.status).toBe(200);
    expect((await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin })).body.provider.active).toBe(true);
  });
});

describe('caps', () => {
  it('rejects a zero or negative cap rather than treating it as unlimited', async () => {
    for (const value of [0, -1]) {
      const res = await call('/api/admin/llm/caps', { method: 'PUT', jar: cookies.admin, body: { monthlyCostUsd: value } });
      expect(res.status, String(value)).toBe(400);
    }
  });

  it('stores an installation cap and reports how much of it is used', async () => {
    await call('/api/admin/llm/caps', { method: 'PUT', jar: cookies.admin, body: { monthlyCostUsd: 100 } });
    await db.query(
      `insert into llm_usage (provider, model, role, input_tokens, output_tokens, cost_usd, cost_source)
       values ('openai','m','primary',10,10,60,'estimated')`,
    );
    const usage = await call('/api/admin/llm/usage', { jar: cookies.admin });
    expect(usage.body.cap.status).toBe('warn_50');
    expect(usage.body.summary.estimatedCostUsd).toBe(60);
  });

  it('sets and clears a per-member cap', async () => {
    const set = await call(`/api/admin/llm/caps/users/${ids.alice}`, {
      method: 'PUT', jar: cookies.admin, body: { monthlyCostUsd: 5 },
    });
    expect(set.status).toBe(200);
    expect(await db.query(`select 1 from llm_user_caps`)).toHaveLength(1);

    await call(`/api/admin/llm/caps/users/${ids.alice}`, { method: 'PUT', jar: cookies.admin, body: {} });
    expect(await db.query(`select 1 from llm_user_caps`)).toHaveLength(0);
  });

  it('404s a cap for a user who does not exist', async () => {
    const res = await call('/api/admin/llm/caps/users/00000000-0000-0000-0000-000000000000', {
      method: 'PUT', jar: cookies.admin, body: { monthlyCostUsd: 5 },
    });
    expect(res.status).toBe(404);
  });
});

describe('what a member is told', () => {
  it('is which features work, not how the model is configured', async () => {
    await configure();
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });

    const res = await call('/api/llm/status', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    const dump = JSON.stringify(res.body);
    for (const leak of ['gpt-test', 'openai', SECRET_KEY, 'apiKey']) {
      expect(dump, leak).not.toContain(leak);
    }
  });

  it('is their own usage, never a colleague\'s', async () => {
    await db.query(
      `insert into llm_usage (user_id, provider, model, role, input_tokens, output_tokens, cost_usd, cost_source)
       values ($1,'openai','m','primary',1000,1000,9.99,'estimated')`,
      [ids.bob],
    );
    const alice = await call('/api/llm/status', { jar: cookies.alice });
    expect(alice.body.usage.totalTokens).toBe(0);
    expect(alice.body.usage.estimatedCostUsd).toBe(0);
  });

  it('reflects their own cap, and the installation cap when that is tighter', async () => {
    await db.query(`insert into llm_user_caps (user_id, monthly_cost_usd) values ($1, 10)`, [ids.alice]);
    await db.query(
      `insert into llm_usage (user_id, provider, model, role, cost_usd, cost_source)
       values ($1,'openai','m','primary',9,'estimated')`,
      [ids.alice],
    );
    const res = await call('/api/llm/status', { jar: cookies.alice });
    expect(res.body.cap.status).toBe('warn_80');
    expect(res.body.cap.allowed).toBe(true);
  });

  it('cannot reach the admin usage report', async () => {
    expect((await call('/api/admin/llm/usage', { jar: cookies.bob })).status).toBe(403);
  });
});

describe('subscription options', () => {
  // AMENDED IN PHASE 13.3, deliberately and not quietly.
  //
  // Phase 4 asserted that all three were unavailable, and in August 2026 that
  // was correct. It stopped being correct for one of them: OpenAI documents
  // `codex exec` as a non-interactive mode of its own CLI, and delegating to
  // the operator's own signed-in binary is a supported path. So the invariant
  // is no longer "everything is refused" — it is "nothing is offered without a
  // real path, and nothing is refused with a vague excuse".
  //
  // The detail of the OpenAI path lives in apps/api/test/subscription.test.ts.
  it('never says "coming soon" — every entry gives a real reason', async () => {
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    expect(res.body.subscriptionOptions.length).toBeGreaterThan(0);
    for (const option of res.body.subscriptionOptions) {
      expect(option.reason, option.id).not.toMatch(/coming soon|not yet|future release/i);
      expect(option.reason.length, option.id).toBeGreaterThan(60);
    }
  });

  it('offers a provider only when there is one to offer', async () => {
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    for (const option of res.body.subscriptionOptions) {
      // An "available" entry with no provider id would be a control that
      // cannot do anything, which is the placeholder-as-working failure.
      if (option.available) expect(option.provider, option.id).toBeTruthy();
      else expect(option.provider, option.id).toBeNull();
    }
  });

  it('does not mention Copilot at all any more', async () => {
    // It used to appear as a permanently-unavailable entry. A choice that can
    // never be chosen is noise, so it was dropped entirely (2026-09-02).
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const byId = Object.fromEntries(res.body.subscriptionOptions.map((o: any) => [o.id, o]));
    expect(byId.copilot_subscription).toBeUndefined();
  });

  it('offers Claude through the first-party CLI on a CE build', async () => {
    // This used to assert the opposite. What changed is the reading of
    // Anthropic's terms, not the standard of evidence: the offered path runs
    // the unmodified Claude Code binary and Anthropic's own sign-in, which is
    // the arrangement they document. FI-006.
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const byId = Object.fromEntries(res.body.subscriptionOptions.map((o: any) => [o.id, o]));
    expect(byId.claude_subscription.available).toBe(true);
    expect(byId.claude_subscription.provider).toBe('anthropic_subscription');
  });

  it('cannot be configured by naming one as a provider', async () => {
    // These are OPTION IDS, not provider kinds. Naming one as a provider must
    // still fail — including for Claude, whose provider kind is
    // `anthropic_subscription` and whose screen label is not routable.
    for (const provider of ['claude_subscription', 'chatgpt_subscription', 'copilot_subscription']) {
      const res = await configure({ provider });
      expect(res.status, provider).toBe(400);
    }
  });
});

describe('the admin usage report', () => {
  it('shows who spent what, and nothing about what they said', async () => {
    await db.query(
      `insert into llm_usage (user_id, provider, model, role, input_tokens, output_tokens, cost_usd, cost_source, purpose)
       values ($1,'openai','m','primary',100,50,1.25,'estimated','assistant_chat')`,
      [ids.bob],
    );
    const res = await call('/api/admin/llm/usage', { jar: cookies.admin });
    const row = res.body.perUser.find((r: any) => r.user_id === ids.bob);
    expect(row).toMatchObject({ username: 'bob', calls: 1 });
    expect(Number(row.tokens)).toBe(150);
    // The schema has nowhere to put a prompt, and the report has no field for
    // one. Asserting the exact key set is what keeps the second half true: a
    // later `select l.*` would add fields and fail here.
    expect(Object.keys(row).sort()).toEqual(
      ['calls', 'estimated_cost_usd', 'reported_cost_usd', 'tokens', 'user_id', 'username'],
    );
  });

  it('keeps reported and estimated cost apart', async () => {
    await db.query(
      `insert into llm_usage (provider, model, role, cost_usd, cost_source) values
         ('openai','m','primary',1,'reported'),
         ('openai','m','primary',2,'estimated'),
         ('openai_compatible','llama','primary',0,'none')`,
    );
    const { summary } = (await call('/api/admin/llm/usage', { jar: cookies.admin })).body;
    expect(summary.reportedCostUsd).toBe(1);
    expect(summary.estimatedCostUsd).toBe(2);
    expect(summary.selfHostedCalls).toBe(1);
    expect(summary).not.toHaveProperty('totalCostUsd');
  });
});
