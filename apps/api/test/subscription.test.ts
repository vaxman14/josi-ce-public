// Subscription authentication over the wire, and the edition boundary that
// keeps it out of a hosted build (L3, L4.3).
//
// The hosted half is the point. No hosted build exists to try, so the only way
// to know a hosted artefact would refuse is to compute a hosted profile and
// drive the real routers with it. Both apps are mounted here: one CE, one
// hosted, on two ports, from the same source.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { computeProfile } from '@josi-ce/core';
import { loadStoredProvider, type SpawnRunner } from '@josi-ce/llm';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { requireCapability } from '../src/http/authz.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-sub-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 19).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const cookies: Record<string, string> = {};

let runnerCalls: Array<Parameters<SpawnRunner>[0]> = [];
let holdFirstProbe: Promise<void> | null = null;
let onProbeEntered: (() => void) | null = null;
const codexRunner: SpawnRunner = async (args) => {
  runnerCalls.push(args);
  const gate = holdFirstProbe;
  if (gate) { holdFirstProbe = null; onProbeEntered?.(); await gate; }
  return {
    code: 0,
    stdout: JSON.stringify({ type: 'agent_message', message: 'Answered by Codex.' }),
    stderr: '',
    timedOut: false,
  };
};

interface Res { status: number; body: any }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined || method === 'GET' ? undefined : JSON.stringify(opts.body),
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

const PW = { admin: 'admin-password-123', alice: 'alice-password-123' };

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin });
  await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice });

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'https://josi.example', masterKeyCheck: { path: keyPath },
    codexRunner,
    llmResolve: async () => ['203.0.113.10'],
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  runnerCalls = [];
  holdFirstProbe = null;
  onProbeEntered = null;
  await db.query(`delete from llm_providers`);
  await db.query(`delete from llm_usage`);
  await db.query(`delete from rate_limits`);
  await db.query(`update security_policy set local_only = false where id = true`);
});

// ------------------------------------------------------- the CE build (real)

describe('what a CE build offers (L3.7)', () => {
  it('offers the OpenAI path as available, and says exactly what it costs', async () => {
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const chatgpt = res.body.subscriptionOptions.find((o: any) => o.id === 'chatgpt_subscription');
    expect(chatgpt.available).toBe(true);
    expect(chatgpt.provider).toBe('openai_subscription');
    // The limits are in the product, not only in the docs.
    expect(chatgpt.reason).toContain('per installation rather than per person');
    // Tools were live-verified over the MCP harness on 2026-09-02; the copy
    // must not still claim the path cannot act.
    expect(chatgpt.reason).toContain('Tools work on this path');
    expect(chatgpt.reason).not.toContain('cannot call tools');
    expect(chatgpt.reason).toContain('never sees, stores or forwards your login');
  });

  it('offers Anthropic through the first-party CLI, and says what that means (L3.5)', async () => {
    // The previous version of this test asserted a blanket refusal citing a
    // policy read in April 2026. That reading was wrong in one direction:
    // what Anthropic forbids is a third party implementing Claude.ai login or
    // intermediating credentials, not shipping their unmodified CLI and
    // letting the user sign in through their own flow. FI-006.
    //
    // The honesty requirements did not move. The reason must still say what
    // the operator is agreeing to, and must still never say "coming soon".
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const claude = res.body.subscriptionOptions.find((o: any) => o.id === 'claude_subscription');
    expect(claude.available).toBe(true);
    expect(claude.provider).toBe('anthropic_subscription');
    expect(claude.reason).toMatch(/never sees, stores or forwards your login/);
    expect(claude.reason).toMatch(/per installation/);
    expect(claude.reason).toMatch(/Tools work on\s+this path/);
    expect(claude.reason).not.toMatch(/cannot call tools/);
    expect(claude.reason).not.toMatch(/coming soon/i);
  });

  it('does not offer Copilot at all', async () => {
    // Dropped entirely (2026-09-02): it only ever appeared as a permanently
    // unavailable entry, which is noise, not information.
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const copilot = res.body.subscriptionOptions.find((o: any) => o.id === 'copilot_subscription');
    expect(copilot).toBeUndefined();
  });

  it('reports the edition, so a screen can explain a refusal', async () => {
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    expect(res.body.edition.edition).toBe('ce');
    expect(res.body.edition.capabilities).toContain('subscription_auth');
  });

  it('a member cannot see or change any of it', async () => {
    expect((await call('/api/admin/llm', { jar: cookies.alice })).status).toBe(403);
  });
});

describe('configuring it (L3.4)', () => {
  const save = (body: Record<string, unknown>) =>
    call('/api/admin/llm/providers/primary', { method: 'PUT', jar: cookies.admin, body });

  it('saves without a key, and stores none', async () => {
    const res = await save({
      provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.query<{
      api_key_enc: string | null; subscription_command: string; model: string; activated_at: string | null;
    }>(
      `select api_key_enc, subscription_command, model, activated_at from llm_providers where role = 'primary'`,
    );
    expect(row.api_key_enc).toBeNull();
    expect(row.subscription_command).toBe('codex');
    expect(row.model).toBe('gpt-5-codex');
    expect(row.activated_at).toBeNull(); // A choice is not active until the real probe succeeds.
  });

  it('REFUSES an API key rather than ignoring it', async () => {
    // A route that takes a credential under the word "subscription" is the
    // misrepresentation this whole feature exists not to commit.
    const res = await save({
      provider: 'openai_subscription', model: 'gpt-5-codex',
      externalAcknowledged: true, apiKey: 'some-key-value-here',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no API key to give');
    expect(res.body.error).toContain('billed per call');
  });

  it('does not carry an existing key across when a slot is switched to it', async () => {
    await save({
      provider: 'openai', model: 'gpt-4o', externalAcknowledged: true, apiKey: 'first-key-value',
    });
    const before = await db.query<{ api_key_enc: string | null }>(
      `select api_key_enc from llm_providers where role = 'primary'`,
    );
    expect(before[0].api_key_enc).not.toBeNull();

    await save({ provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true });
    const after = await db.query<{ api_key_enc: string | null }>(
      `select api_key_enc from llm_providers where role = 'primary'`,
    );
    // An empty key field normally means "leave it alone". Here it must mean
    // "there is none", or the row would carry a key the constraint forbids.
    expect(after[0].api_key_enc).toBeNull();
  });

  it('the database refuses the shape too, not just the route', async () => {
    await save({ provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true });
    // A constraint is a promise the route cannot break by being refactored.
    await expect(db.query(
      `update llm_providers set api_key_enc = 'v1.a.b.c' where role = 'primary'`,
    )).rejects.toThrow();
  });

  it('still requires the external acknowledgement, because the bytes still leave', async () => {
    const res = await save({ provider: 'openai_subscription', model: 'gpt-5-codex' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('leaves this server');
  });

  it('Local-only refuses it, exactly as it refuses a hosted provider', async () => {
    await db.query(`update security_policy set local_only = true where id = true`);
    const res = await save({
      provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Local-only');
  });

  // ---- Round-2 item 6: ChatGPT → Claude used to die on the DB constraint,
  // carrying the Codex model and CLI into the Claude row on the way down.

  it('accepts the Claude subscription — the constraint admits anthropic_subscription', async () => {
    const res = await save({ provider: 'anthropic_subscription', externalAcknowledged: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.query<{ provider: string; api_key_enc: string | null }>(
      `select provider, api_key_enc from llm_providers where role = 'primary'`,
    );
    expect(row.provider).toBe('anthropic_subscription');
    expect(row.api_key_enc).toBeNull();
  });

  it('does not carry the previous provider\u2019s model or CLI into the new row', async () => {
    // The exact sequence from the live failure: ChatGPT plan active, then
    // switch to Claude. The failing row was provider=anthropic_subscription,
    // model=gpt-5-codex, cli=codex — two thirds of it somebody else's config.
    await save({ provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true });
    const res = await save({ provider: 'anthropic_subscription', externalAcknowledged: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [row] = await db.query<{ model: string; subscription_command: string }>(
      `select model, subscription_command from llm_providers where role = 'primary'`,
    );
    expect(row.model).toBe('');               // the plan's own model, not Codex's
    expect(row.subscription_command).toBe('claude');  // Anthropic's CLI, not codex
  });

  it('allows an empty model on both subscription kinds — the CLI chooses', async () => {
    const chatgpt = await save({ provider: 'openai_subscription', externalAcknowledged: true });
    expect(chatgpt.status).toBe(200);
    const [automatic] = await db.query<{ model: string }>(
      `select model from llm_providers where role = 'primary'`,
    );
    expect(automatic.model).toBe('');
    const claude = await save({ provider: 'anthropic_subscription', externalAcknowledged: true });
    expect(claude.status).toBe(200);
    // A NON-subscription provider still needs a name.
    const openai = await save({ provider: 'openai', apiKey: 'k-value-here', externalAcknowledged: true });
    expect(openai.status).toBe(400);
    expect(openai.body.error).toContain('model name');
  });

  it('the database refuses a key on the Claude row too', async () => {
    await save({ provider: 'anthropic_subscription', externalAcknowledged: true });
    await expect(db.query(
      `update llm_providers set api_key_enc = 'v1.a.b.c' where role = 'primary'`,
    )).rejects.toThrow();
  });

  it('records an operator-supplied binary path', async () => {
    await save({
      provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true,
      subscriptionCommand: '/opt/codex/bin/codex',
    });
    const [row] = await db.query<{ subscription_command: string }>(
      `select subscription_command from llm_providers where role = 'primary'`,
    );
    expect(row.subscription_command).toBe('/opt/codex/bin/codex');
  });
});

describe('using it (L3.2)', () => {
  beforeEach(async () => {
    await call('/api/admin/llm/providers/primary', {
      method: 'PUT', jar: cookies.admin,
      body: { provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true },
    });
  });

  it('the probe runs the binary rather than making a request', async () => {
    const res = await call('/api/admin/llm/providers/primary/probe', {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(runnerCalls.length).toBeGreaterThan(0);
    expect(runnerCalls[0].command).toBe('codex');
    expect(runnerCalls[0].args).toContain('exec');
  });

  it('retains the full database timestamp for the probe change guard', async () => {
    const stored = await loadStoredProvider(db, 'primary');
    const [row] = await db.query<{ exact: string }>(
      `select updated_at::text as exact from llm_providers where role = $1`, ['primary'],
    );
    expect(stored?.updated_at).toBe(row.exact);
  });

  it('an older probe cannot activate a newly saved model', async () => {
    let release!: () => void;
    holdFirstProbe = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    onProbeEntered = started;
    const oldProbe = call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    try {
      await entered;
      const saved = await call('/api/admin/llm/providers/primary', {
        method: 'PUT', jar: cookies.admin,
        body: { provider: 'openai_subscription', model: 'replacement-model', externalAcknowledged: true },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    } finally {
      release();
    }
    const result = await oldProbe;
    expect(result.status).toBe(409);
    const [row] = await db.query<{ model: string; activated_at: string | null; probed_at: string | null }>(
      `select model, activated_at, probed_at from llm_providers where role = 'primary'`,
    );
    expect(row.model).toBe('replacement-model');
    expect(row.activated_at).toBeNull();
    expect(row.probed_at).toBeNull();
  });

  it('the probe finds tool calling absent, so dependent features stay off', async () => {
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    const res = await call('/api/admin/llm', { jar: cookies.admin });
    const disabled = res.body.disabledFeatures.map((d: any) => d.feature);
    // Josi can talk on this path; it cannot act. Said by the product, not only
    // by the docs.
    expect(disabled).toContain('calendar_tools');
    expect(disabled).toContain('email_tools');
  });

  it('no API key reaches the child environment', async () => {
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    for (const invocation of runnerCalls) {
      expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
      expect(invocation.env.DATABASE_URL).toBeUndefined();
      expect(invocation.env.MASTER_KEY_FILE).toBeUndefined();
    }
  });

  it('usage is recorded as a subscription charge with no invented figure', async () => {
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    const rows = await db.query<{ cost_source: string; cost_usd: string; input_tokens: number }>(
      `select cost_source, cost_usd, input_tokens from llm_usage`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cost_source).toBe('subscription');
      expect(Number(row.cost_usd)).toBe(0);
      expect(row.input_tokens).toBe(0);
    }
  });

  it('the usage summary labels it rather than calling it free', async () => {
    await call('/api/admin/llm/providers/primary/probe', { method: 'POST', jar: cookies.admin });
    // The installation-wide view. A probe is a system call with no user
    // attached, so it deliberately does not appear in one person's own
    // `/llm/status` — which is the correct scoping and worth not "fixing".
    const res = await call('/api/admin/llm/usage', { jar: cookies.admin });
    expect(res.body.summary.subscriptionCalls).toBeGreaterThan(0);
    expect(res.body.summary.notes.join(' ')).toContain('ChatGPT plan');
    expect(res.body.summary.notes.join(' ')).not.toContain('No provider charge');
    // And nothing was billed or estimated.
    expect(res.body.summary.estimatedCostUsd).toBe(0);
    expect(res.body.summary.reportedCostUsd).toBe(0);
  });
});

// -------------------------------------------------- the hosted build (proof)

describe('a hosted build of this same source cannot enable it (L3.6, L4.3)', () => {
  const hosted = computeProfile({ stamp: 'hosted', env: {} });

  it('has no capability to offer', () => {
    expect(hosted.capabilities).toEqual([]);
  });

  it('the route guard answers 404 — not 403, which would confirm it exists', async () => {
    const guard = requireCapability('subscription_auth', hosted);
    let status = 0;
    let nexted = false;
    guard(
      {} as never,
      { status(code: number) { status = code; return { json() {} }; } } as never,
      () => { nexted = true; },
    );
    expect(status).toBe(404);
    expect(nexted).toBe(false);
  });

  it('the CE guard lets it through, so the test above is not vacuous', () => {
    const ce = computeProfile({ stamp: 'ce', env: {} });
    let nexted = false;
    requireCapability('subscription_auth', ce)(
      {} as never,
      { status() { return { json() {} }; } } as never,
      () => { nexted = true; },
    );
    expect(nexted).toBe(true);
  });

  it('no environment variable turns the boundary around', () => {
    for (const env of [
      { JOSI_EDITION: 'ce' },
      { JOSI_CAPABILITIES: 'subscription_auth' },
      { JOSI_ENABLE_SUBSCRIPTION_AUTH: 'true' },
      { JOSI_DISABLED_CAPABILITIES: '' },
    ]) {
      expect(computeProfile({ stamp: 'hosted', env }).capabilities, JSON.stringify(env)).toEqual([]);
    }
  });

  it('the provider factory refuses even when the route is bypassed entirely', async () => {
    // The layer that catches a row somebody inserted with psql: no HTTP
    // involved, no guard, straight into the builder.
    const { codexCliProvider } = await import('@josi-ce/llm');
    const { CapabilityUnavailable } = await import('@josi-ce/core');
    // On this CE build the factory succeeds — which is what makes the
    // hosted-profile assertions above meaningful rather than a tautology.
    expect(() => codexCliProvider({ model: 'm', runner: codexRunner })).not.toThrow();
    expect(new CapabilityUnavailable('subscription_auth', 'hosted').message)
      .toContain('no setting can add it');
  });
});
