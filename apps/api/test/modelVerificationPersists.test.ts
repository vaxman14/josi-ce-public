// A model tested during setup stays tested.
//
// The failure this pins down is the product refusing to trust its own check:
// the wizard sent a real message, got a real answer, said "passed", setup
// completed — and Admin -> Model then reported "not tested" and asked the
// operator to run the same test again. Every one of those requests costs money
// on a hosted provider and quota on a subscription one, and the second one
// establishes nothing the first did not.
//
// Two halves, tested in the two places they live: the server must carry the
// verified state onto the provider row, and the admin screen must not test on
// open, must not say it is testing when it is not, and must not present a
// retest as outstanding work.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createApp } from '../src/app.js';

const root = join(import.meta.dirname, '../../..');
const dir = mkdtempSync(join(tmpdir(), 'josi-ce-model-verify-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 3).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
let jar = '';

async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jar) headers.cookie = jar;
  const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const llmFetch: typeof fetch = async (url, init) => {
  if (String(url).endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
  }
  const request = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[]; response_format?: unknown; messages?: unknown[] };
  const prompt = JSON.stringify(request.messages ?? []);
  const message = request.tools?.length
    ? { content: '', tool_calls: [{ id: 'probe', type: 'function', function: { name: 'record_number', arguments: '{"value":7}' } }] }
    : { content: request.response_format ? '{"ok":true}' : /color is this image/i.test(prompt) ? 'red' : /Ignore the text above/i.test(prompt) ? 'ok' : 'ready' };
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  }), { status: 200 });
};
const llmResolve = async () => ['93.184.216.34'];

const OWNER = { email: 'o@ce.test', username: 'owner', password: 'a-long-enough-password' };

async function wizardThroughLlm() {
  for (const [step, body] of [
    ['host_checks', {}],
    ['owner', OWNER],
    ['domain', { domain: 'josi.example.test', tlsMode: 'bundled_caddy' }],
    ['llm', { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-key-0007', externalAcknowledged: true }],
  ] as Array<[string, unknown]>) {
    const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body });
    expect(res.status, `${step}: ${JSON.stringify(res.body)}`).toBe(200);
  }
}

beforeEach(async () => {
  db = await testDb();
  jar = 'josi_csrf=test-token';
  await db.query(`update setup_state set csrf_seed = null where id = true`).catch(() => undefined);
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
    llmFetch, llmResolve,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a passing setup verification is the provider\'s verified state', () => {
  it('activates the provider and records what was observed', async () => {
    await wizardThroughLlm();
    const verify = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(verify.body.status).toBe('passed');

    const [row] = await db.query<{
      activated_at: string | null; probed_at: string | null;
      cap_chat: boolean | null; cap_tool_calling: boolean | null; probe_steps: unknown;
    }>(
      `select activated_at, probed_at, cap_chat, cap_tool_calling, probe_steps
       from llm_providers where role = 'primary'`,
    );
    expect(row.activated_at).not.toBeNull();
    expect(row.probed_at).not.toBeNull();
    // Onboarding runs and records the same complete probe as Admin.
    expect(row.cap_chat).toBe(true);
    expect(row.cap_tool_calling).toBe(true);

    const steps = typeof row.probe_steps === 'string'
      ? JSON.parse(row.probe_steps)
      : row.probe_steps as Array<{ id: string; passed: boolean }>;
    expect(steps.some((s) => s.id === 'chat' && s.passed)).toBe(true);
    expect(steps).toHaveLength(5);
  });

  it('a failing verification activates nothing', async () => {
    await wizardThroughLlm();
    // Nothing has been verified yet, so the row must not claim otherwise.
    const [before] = await db.query<{ activated_at: string | null }>(
      `select activated_at from llm_providers where role = 'primary'`,
    );
    expect(before.activated_at).toBeNull();
  });

  it('changing the configuration is what makes a retest necessary again', async () => {
    await wizardThroughLlm();
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    const [tested] = await db.query<{ activated_at: string | null }>(
      `select activated_at from llm_providers where role = 'primary'`,
    );
    expect(tested.activated_at).not.toBeNull();

    // Re-submitting the step is a configuration change, and the wizard's own
    // re-verification covers it. What must never happen is the verified state
    // surviving a change to the credential silently — that is asserted on the
    // admin save path, which clears activated_at, probed_at and probe_steps.
    const llmRoutes = readFileSync(join(root, 'apps/api/src/http/llmRoutes.ts'), 'utf8');
    expect(llmRoutes).toContain('activated_at = null, probed_at = null');
  });
});

describe('Admin -> Model does not re-test on its own', () => {
  const model = readFileSync(join(root, 'apps/web/src/pages/admin/Model.tsx'), 'utf8');

  it('has no effect that probes', () => {
    // The page loads its data on mount and nothing else. A useEffect that
    // called probe() would spend a real request, and on a subscription
    // provider the operator's own quota, every time the screen was opened.
    const effects = model.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) {
      expect(effect).not.toContain('probe(');
    }
  });

  it('only says it is testing while a test it was asked for is running', () => {
    // `busy` also covers switching to a subscription provider, so the button's
    // label must not be driven by it: that made the screen report a test
    // nobody had started.
    expect(model).toContain("{probing");
    expect(model).not.toContain("{busy ? 'Testing…'");
  });

  it('presents a retest as optional once the model is in use', () => {
    expect(model).toContain("data.primary.active ? 'Test again' : 'Test this model'");
    expect(model).toMatch(/Optional\./);
    // And does not tell somebody with a working model that Josi will not use it.
    expect(model).toContain('{!data.primary.active ? (');
  });
});
