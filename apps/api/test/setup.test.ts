// The setup wizard.
//
// These routes are unauthenticated by necessity — they run before any account
// exists — which makes them the most attackable surface in the product. The
// tests are written from that angle: skip a step, replay a step, forge a step
// name, race the owner creation, race completion, come back after completion,
// and try to smuggle authority through the request body.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { getVaultSecret, loadMasterKey, looksSealed, openSealed } from '@josi-ce/core';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-setup-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 9).toString('base64'));
const missingKeyPath = join(dir, 'absent.key');

let server: Server;
let base: string;
let db: TestDb;

interface Res { status: number; body: any }

/** A browser-shaped client. Setup routes are unauthenticated but still behind
 * CSRF, so the token is fetched and echoed exactly as the real client must. */
let jar = '';
async function call(path: string, opts: { method?: string; body?: unknown; csrf?: string | null; setupToken?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jar) headers.cookie = jar;
  if (opts.csrf !== null) {
    const token = opts.csrf ?? /josi_csrf=([^;]+)/.exec(jar)?.[1];
    if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  }
  if (opts.setupToken) headers['x-josi-setup-token'] = opts.setupToken;
  const method = opts.method ?? 'GET';
  // fetch refuses a body on GET/HEAD. Callers pass one uniformly when sweeping
  // a mixed list of routes, so it is dropped here rather than at every site.
  const sendsBody = method !== 'GET' && method !== 'HEAD' && opts.body !== undefined;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: sendsBody ? JSON.stringify(opts.body) : undefined,
    redirect: 'manual',
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const first = raw.split(';')[0];
    const name = first.slice(0, first.indexOf('='));
    const rest = jar.split('; ').filter((c) => c && !c.startsWith(`${name}=`));
    jar = [...rest, first].join('; ');
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Most state-machine tests seed a stable pair directly; the browser bootstrap
 * endpoint itself is covered separately below. */
function seedCsrf(): void {
  jar = 'josi_csrf=setup-test-token';
}

const OWNER = {
  email: 'owner@example.test',
  username: 'owner',
  displayName: 'The Owner',
  password: 'a-long-enough-password',
};

const SMTP_BODY = {
  system: {
    host: 'smtp.example.test', port: 587, security: 'starttls',
    username: 'system@example.test', password: 'system-smtp-password',
    fromName: 'Josi', fromAddress: 'noreply@example.test',
  },
  communications: { copyFromSystem: true, fromName: 'Josi', fromAddress: 'josi@example.test' },
  // LB4.2: configuring mail means sending one, to an address the administrator
  // names. The only alternative is `skip`.
  testTo: 'owner@example.test',
};

/** Every message this suite "sends". Nothing leaves the process. */
const sentMail: Array<{ to: string[]; subject: string; text: string }> = [];
const mailTransport = {
  async send(message: { to: string[]; subject: string; text: string }) {
    sentMail.push({ to: message.to, subject: message.subject, text: message.text });
    return { messageId: `test-${sentMail.length}` };
  },
};

/** Drives the wizard up to (not including) `stopBefore`. */
async function runWizard(stopBefore?: string): Promise<void> {
  const steps: Array<[string, unknown]> = [
    ['host_checks', {}],
    ['owner', OWNER],
    ['domain', { domain: 'josi.example.test', tlsMode: 'bundled_caddy' }],
    ['llm', { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-llm-key-DO-NOT-USE-0001', externalAcknowledged: true }],
    ['smtp', SMTP_BODY],
    ['security', { folderMappingEnabled: true }],
    ['telemetry', {}],
    ['review', {}],
  ];
  for (const [step, body] of steps) {
    if (step === stopBefore) return;
    const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body });
    expect(res.status, `${step}: ${JSON.stringify(res.body)}`).toBe(200);
    if(step==='owner')expect((await call('/api/setup/vault-recovery-confirmed',{method:'POST',body:{}})).status).toBe(200);

    // The model is the one REQUIRED thing that has to be shown to work, so
    // completion is refused until it has been. Tests that only want a finished
    // wizard get that here; the gate itself is asserted separately below.
    if (step === 'llm') {
      const verified = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
      expect(verified.status, `verify/llm: ${JSON.stringify(verified.body)}`).toBe(200);
      expect(verified.body.status, JSON.stringify(verified.body)).toBe('passed');
    }
  }
}

/** The wizard now asks providers what models an account may use, and tests what
 * it configured. Neither may reach the internet from a unit suite, so both
 * seams are stubbed here — the same way every other subsystem's are.
 *
 * The model list deliberately contains exactly the identifiers these tests
 * submit. A test that stores `gpt-4o-mini` is asserting the step's behaviour,
 * not OpenAI's catalogue. */
const STUB_MODELS = ['gpt-4o-mini', 'claude', 'llama3'];

const llmFetch: typeof fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith('/models')) {
    return new Response(JSON.stringify({ data: STUB_MODELS.map((id) => ({ id })) }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }
  // A chat completion, for the verify step.
  void init;
  return new Response(JSON.stringify({
    choices: [{ message: { content: 'ready' } }],
    usage: { prompt_tokens: 6, completion_tokens: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

/** Every hostname resolves to one public address, so the SSRF layer permits the
 * request and the stub above answers it. */
const llmResolve = async () => ['93.184.216.34'];

/** Google's and Microsoft's token endpoints.
 *
 * `invalid_grant` is the PASSING answer: the client credential was accepted and
 * the deliberately-bogus authorization code was not. See verifyOAuthClient. */
const connectorFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: 'invalid_grant' }), {
    status: 400, headers: { 'Content-Type': 'application/json' },
  });

async function startServer(masterKey: { path: string } | false = { path: keyPath }): Promise<void> {
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: masterKey,
    llmFetch, llmResolve, mailTransport, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stopServer(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  db = await testDb();
  seedCsrf();
  await startServer();
});
afterAll(async () => { await stopServer().catch(() => undefined); });
// Each test gets a fresh database and server; close the previous one.
afterEach(async () => { await stopServer().catch(() => undefined); });

// ---------------------------------------------------------------- 1 + 2
describe('an unconfigured installation exposes only the wizard', () => {
  it('serves the setup routes', async () => {
    const state = await call('/api/setup/state');
    expect(state.status).toBe(200);
    expect(state.body.completed).toBe(false);
    expect(state.body.nextStep).toBe('host_checks');
  });

  it('keeps the model step current until its five-part verification passes', async () => {
    await runWizard('llm');
    const saved = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-llm-key-DO-NOT-USE-0001', externalAcknowledged: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.nextStep).toBe('llm');
    const state = await call('/api/setup/state');
    expect(state.body.nextStep).toBe('llm');
    expect(state.body.completedSteps).not.toContain('llm');
    const skipped = await call('/api/setup/steps/smtp', { method: 'POST', body: { skip: true } });
    expect(skipped.status).toBe(409);
    expect(skipped.body.expected).toBe('llm');

    expect((await call('/api/setup/verify/llm', { method: 'POST', body: {} })).status).toBe(200);
    expect((await call('/api/setup/state')).body.nextStep).toBe('smtp');
  });

  it('binds first-admin setup to the installer handoff token', async () => {
    const handoff = 'browser-installer-handoff-token-1234567890';
    await stopServer();
    const app = createApp(db, {
      cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
      llmFetch, llmResolve, mailTransport, connectorFetch,
      setupTokenSha256: createHash('sha256').update(handoff).digest('hex'),
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect((await call('/api/setup/state')).status).toBe(404);
    expect((await call('/api/setup/state', { setupToken: 'wrong-token' })).status).toBe(404);
    expect((await call('/api/setup/state', { setupToken: handoff })).status).toBe(200);
    expect((await call('/api/setup/steps/owner', {
      method: 'POST', body: OWNER, setupToken: handoff,
    })).status).toBe(409); // host checks remain mandatory; the token grants no shortcut.
  });

  it('imports the browser installer address and does not ask for it twice', async () => {
    const previous = {
      configured: process.env.JOSI_INSTALLER_CONFIGURED,
      mode: process.env.JOSI_ACCESS_MODE,
      appUrl: process.env.APP_URL,
    };
    process.env.JOSI_INSTALLER_CONFIGURED = '1';
    process.env.JOSI_ACCESS_MODE = 'lan';
    process.env.APP_URL = 'http://192.168.50.20:8088';
    try {
      const state = await call('/api/setup/state');
      expect(state.status).toBe(200);
      expect(state.body.completedSteps).toContain('domain');
      expect(state.body.nextStep).toBe('host_checks');
      const [deployment] = await db.query<{ domain: string; tls_mode: string }>(
        `select domain, tls_mode from deployment_config where id = true`,
      );
      expect(deployment).toEqual({ domain: '192.168.50.20', tls_mode: 'bundled_caddy' });
    } finally {
      if (previous.configured === undefined) delete process.env.JOSI_INSTALLER_CONFIGURED;
      else process.env.JOSI_INSTALLER_CONFIGURED = previous.configured;
      if (previous.mode === undefined) delete process.env.JOSI_ACCESS_MODE;
      else process.env.JOSI_ACCESS_MODE = previous.mode;
      if (previous.appUrl === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous.appUrl;
    }
  });

  it('refuses every non-setup API route', async () => {
    for (const path of [
      '/api/auth/me', '/api/connections',
      '/api/admin/users', '/api/admin/workspace', '/api/admin/events', '/api/admin/connections',
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(503);
      expect(res.body.setupRequired, path).toBe(true);
    }
  });

  it('issues the CSRF pair the browser needs to submit the first setup step', async () => {
    const res = await call('/api/auth/csrf');
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(jar).toContain('josi_csrf=');
  });

  it('refuses non-setup writes too, not just reads', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST', body: { identifier: 'x', password: 'y' },
    });
    expect(res.status).toBe(503);
  });

  it('keeps health and readiness available for orchestration, and only those', async () => {
    // The container healthcheck must work before setup, or the stack never
    // becomes healthy and an operator cannot reach the wizard at all.
    expect((await call('/health')).status).toBe(200);
    const ready = await call('/ready');
    expect([200, 503]).toContain(ready.status);
    // The exemption list is exactly one prefix. Nothing else slipped in.
    const { SETUP_EXEMPT_PREFIXES } = await import('../src/http/setupGate.js');
    expect([...SETUP_EXEMPT_PREFIXES]).toEqual(['/setup']);
  });
});

// -------------------------------------------------------------------- 3
describe('the state machine cannot be driven by the client', () => {
  it('refuses a step that is not next', async () => {
    const res = await call('/api/setup/steps/owner', { method: 'POST', body: OWNER });
    expect(res.status).toBe(409);
    expect(res.body.expected).toBe('host_checks');
    expect((await db.query(`select id from users`)).length).toBe(0);
  });

  it('refuses skipping ahead to review or completion', async () => {
    await runWizard('domain'); // host_checks + owner done
    expect((await call('/api/setup/steps/review', { method: 'POST', body: {} })).status).toBe(409);
    const complete = await call('/api/setup/complete', { method: 'POST', body: {} });
    expect(complete.status).toBe(409);
    expect(complete.body.expected).toBe('domain');
  });

  it('refuses a forged step name', async () => {
    for (const forged of ['../complete', 'OWNER', 'owner ', 'root', '__proto__', '']) {
      const res = await call(`/api/setup/steps/${encodeURIComponent(forged)}`, { method: 'POST', body: {} });
      expect([404, 409], forged).toContain(res.status);
    }
  });

  it('refuses replaying a completed step', async () => {
    await runWizard('owner');
    expect((await call('/api/setup/steps/host_checks', { method: 'POST', body: {} })).status).toBe(409);
  });

  it('ignores authority fields smuggled in the body', async () => {
    await runWizard('owner');
    const res = await call('/api/setup/steps/owner', {
      method: 'POST',
      body: {
        ...OWNER,
        role: 'member',                    // must not change the created role
        id: '00000000-0000-0000-0000-000000000001',
        completed: true,                   // must not finish setup
        completedSteps: [...['host_checks', 'owner', 'domain', 'llm', 'smtp', 'security', 'telemetry', 'review']],
        install_id: '11111111-1111-1111-1111-111111111111',
        nextStep: 'review',
      },
    });
    expect(res.status).toBe(200);

    const users = await db.query<{ role: string; id: string }>(`select role, id from users`);
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('super_admin');
    expect(users[0].id).not.toBe('00000000-0000-0000-0000-000000000001');

    const state = await db.query<{ completed: boolean; completed_steps: string[]; install_id: string | null }>(
      `select completed, completed_steps, install_id from setup_state where id = true`,
    );
    expect(state[0].completed).toBe(false);
    expect(state[0].completed_steps).toEqual(['host_checks', 'owner']);
    expect(state[0].install_id).toBeNull();
  });

  it('rejects malformed input per step without recording the step', async () => {
    await runWizard('owner');
    const bad = [
      { password: 'short' },
      { email: 'not-an-email', username: 'u', password: 'a-long-enough-password' },
      { email: 'a@b.test', username: '', password: 'a-long-enough-password' },
    ];
    for (const body of bad) {
      expect((await call('/api/setup/steps/owner', { method: 'POST', body })).status).toBe(400);
    }
    expect((await db.query(`select id from users`)).length).toBe(0);
    const state = await db.query<{ completed_steps: string[] }>(`select completed_steps from setup_state where id = true`);
    expect(state[0].completed_steps).toEqual(['host_checks']);
  });

  it('validates the domain without claiming a certificate was obtained', async () => {
    await runWizard('domain');
    for (const domain of ['http://x.test', 'not a host', '../etc', 'a..b.test']) {
      expect((await call('/api/setup/steps/domain', { method: 'POST', body: { domain } })).status, domain).toBe(400);
    }
    expect((await call('/api/setup/steps/domain', { method: 'POST', body: { domain: 'josi.example.test' } })).status).toBe(200);
    const rows = await db.query<{ certificate_verified_at: string | null }>(
      `select certificate_verified_at from deployment_config where id = true`,
    );
    // No ACME challenge happened, so nothing may claim one did.
    expect(rows[0].certificate_verified_at).toBeNull();
  });

  it('accepts a literal LAN IP as an installation address', async () => {
    await runWizard('domain');
    const res = await call('/api/setup/steps/domain', {
      method: 'POST', body: { domain: '192.168.1.50', tlsMode: 'bundled_caddy' },
    });
    expect(res.status).toBe(200);
    const [deployment] = await db.query<{ domain: string; certificate_verified_at: string | null }>(
      `select domain, certificate_verified_at from deployment_config where id = true`,
    );
    expect(deployment).toEqual({ domain: '192.168.1.50', certificate_verified_at: null });
  });
});

// -------------------------------------------------------------------- 4
describe('resume', () => {
  it('survives a restart and resumes at the first incomplete step', async () => {
    await runWizard('llm'); // host_checks, owner, domain
    await stopServer();
    await startServer();    // a new process against the same database
    seedCsrf();

    const state = await call('/api/setup/state');
    expect(state.body.nextStep).toBe('llm');
    expect(state.body.completedSteps).toEqual(['host_checks', 'owner', 'domain']);

    // Accepted data survived.
    const users = await db.query<{ email: string }>(`select email from users`);
    expect(users[0].email).toBe(OWNER.email);
    const dep = await db.query<{ domain: string }>(`select domain from deployment_config where id = true`);
    expect(dep[0].domain).toBe('josi.example.test');

    // And the wizard continues from there rather than starting over.
    expect((await call('/api/setup/steps/host_checks', { method: 'POST', body: {} })).status).toBe(409);
  });
});

// -------------------------------------------------------------------- 5 + 7
describe('concurrency and replay', () => {
  it('creates exactly one super admin under concurrent duplicate submissions', async () => {
    await runWizard('owner');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('/api/setup/steps/owner', { method: 'POST', body: OWNER })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const users = await db.query<{ role: string }>(`select role from users`);
    expect(users).toHaveLength(1);
  });

  it('records a step once even when submitted concurrently', async () => {
    await runWizard('owner');
    await Promise.all(Array.from({ length: 4 }, () => call('/api/setup/steps/owner', { method: 'POST', body: OWNER })));
    const state = await db.query<{ completed_steps: string[] }>(`select completed_steps from setup_state where id = true`);
    expect(state[0].completed_steps.filter((s) => s === 'owner')).toHaveLength(1);
  });

  it('has a single-use completion latch, proven directly', async () => {
    // The route's early `if (completed) return 404` would mask the SQL guard,
    // and pglite serialises queries so an HTTP-level race cannot reach it
    // either. So the latch is exercised on its own: whichever caller wins gets
    // a row, every later caller gets null.
    const { sealSetupOnce } = await import('../src/setup/setupRoutes.js');
    const { getInstallId } = await import('@josi-ce/core');
    await runWizard();
    const installId = await getInstallId(db);

    const first = await sealSetupOnce(db, installId);
    expect(first).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect(await sealSetupOnce(db, installId)).toBeNull();
    }
    const rows = await db.query<{ completed: boolean }>(`select completed from setup_state where id = true`);
    expect(rows[0].completed).toBe(true);
  });

  it('completes exactly once under repeated finishers', async () => {
    await runWizard();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('/api/setup/complete', { method: 'POST', body: {} })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(4);
    const [workspace] = await db.query<{ name: string; settings: Record<string, unknown> }>(
      `select name, settings from workspace where id = true`,
    );
    expect(workspace).toBeTruthy();
    expect(workspace.name).not.toBe('');
    expect(workspace.settings.publicAddress).toBe('josi.example.test');
  });

  it('cannot be replayed into a second super admin after completion', async () => {
    await runWizard();
    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(200);

    // Every route that could conceivably re-open it.
    for (const [path, method] of [
      ['/api/setup/state', 'GET'], ['/api/setup/host-checks', 'GET'], ['/api/setup/review', 'GET'],
      ['/api/setup/steps/owner', 'POST'], ['/api/setup/complete', 'POST'],
    ] as const) {
      const res = await call(path, { method, body: OWNER });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    const users = await db.query<{ role: string }>(`select role from users`);
    expect(users.filter((u) => u.role === 'super_admin')).toHaveLength(1);
  });

  it('cannot be reopened by a restart', async () => {
    await runWizard();
    await call('/api/setup/complete', { method: 'POST', body: {} });
    await stopServer();
    await startServer();
    seedCsrf();
    expect((await call('/api/setup/state')).status).toBe(404);
    // and the application is now available
    expect((await call('/api/auth/csrf')).status).toBe(200);
  });

  it('cannot be reopened by writing to the database the way a client would', async () => {
    await runWizard();
    await call('/api/setup/complete', { method: 'POST', body: {} });
    // The one-super-admin index still holds regardless of setup state.
    await expect(
      db.query(`insert into users (email, username, role) values ('x@y.test','x','super_admin')`),
    ).rejects.toThrow();
  });
});

// -------------------------------------------------------------------- 6
describe('after completion', () => {
  it('makes setup routes 404 and the application available', async () => {
    await runWizard();
    await call('/api/setup/complete', { method: 'POST', body: {} });
    expect((await call('/api/setup/state')).status).toBe(404);
    // 404, not 403 and not a redirect: after setup those routes do not exist.
    expect((await call('/api/setup/state')).body).toEqual({ error: 'not found' });
    expect((await call('/api/auth/me')).status).toBe(401); // reachable, unauthenticated
  });
});

// -------------------------------------------------------------------- 8
describe('the master key', () => {
  it('fails closed and stores no plaintext when it is missing', async () => {
    await stopServer();
    await startServer({ path: missingKeyPath });
    seedCsrf();

    // host_checks reports the failure and refuses to advance.
    const checks = await call('/api/setup/host-checks');
    expect(checks.body.blocking).toContain('master_key');
    expect((await call('/api/setup/steps/host_checks', { method: 'POST', body: {} })).status).toBe(409);

    // Even reaching a secret-bearing step directly stores nothing.
    await db.query(`update setup_state set completed_steps = array['host_checks','owner','domain'] where id = true`);
    const llm = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-llm-key-DO-NOT-USE-0002', externalAcknowledged: true },
    });
    expect(llm.status).toBe(503);
    const rows = await db.query(`select * from llm_providers`);
    expect(rows).toHaveLength(0);

    // and no plaintext anywhere in the database
    const dump = JSON.stringify(await db.query(`select * from setup_state`));
    expect(dump).not.toContain('fake-llm-key-DO-NOT-USE-0002');
  });
});

// -------------------------------------------------------------------- 9 + 14
describe('secrets', () => {
  it('are encrypted at rest and never returned', async () => {
    await runWizard();

    const llm = await db.query<{ api_key_enc: string }>(`select api_key_enc from llm_providers`);
    expect(looksSealed(llm[0].api_key_enc)).toBe(true);
    expect(llm[0].api_key_enc).not.toContain('fake-llm-key-DO-NOT-USE-0001');

    const smtp = await db.query<{ password_enc: string | null }>(
      `select password_enc from smtp_profiles where kind = 'system'`,
    );
    expect(looksSealed(smtp[0].password_enc)).toBe(true);
    expect(smtp[0].password_enc).not.toContain('system-smtp-password');

    // Nothing sensitive anywhere in the whole database.
    const everything = JSON.stringify(
      await Promise.all([
        db.query(`select * from llm_providers`),
        db.query(`select * from smtp_profiles`),
        db.query(`select * from setup_state`),
        db.query(`select * from setup_host_checks`),
        db.query(`select * from users`),
        db.query(`select * from events`),
      ]),
    );
    for (const secret of ['fake-llm-key-DO-NOT-USE-0001', 'system-smtp-password', OWNER.password]) {
      expect(everything, secret).not.toContain(secret);
    }
  });

  it('never appear in the review summary', async () => {
    await runWizard();
    const review = await call('/api/setup/review');
    expect(review.status).toBe(200);
    const text = JSON.stringify(review.body);
    for (const secret of ['fake-llm-key-DO-NOT-USE-0001', 'system-smtp-password', OWNER.password]) {
      expect(text, secret).not.toContain(secret);
    }
    // Not even the ciphertext, which an operator has no use for.
    expect(text).not.toMatch(/^.*v1\.[A-Za-z0-9+/=]{10,}/s);
    // It says THAT a secret is set.
    expect(review.body.summary.llm.apiKeySet).toBe(true);
    expect(review.body.summary.smtp.find((p: any) => p.kind === 'system').passwordSet).toBe(true);
  });

  it('says what was tested and what was not, and never both about one thing', async () => {
    // This replaces an assertion on two status strings that were the defect:
    // `llm.status` read "configured — activated when model support ships" and
    // the connector line read "accounts are connected once connector support
    // ships", long after both had shipped. Neither reflected anything that had
    // been checked.
    await runWizard();
    const body = (await call('/api/setup/review')).body;

    const byKey = new Map<string, any>(body.items.map((i: any) => [i.key, i]));
    // Verified during the wizard, by a real request.
    expect(byKey.get('llm').status).toBe('configured_and_tested');
    // Configured AND sent to, because the SMTP step now sends.
    expect(byKey.get('smtp').status).toBe('configured_and_tested');
    // Google and Microsoft are not installation-time items at all now, so
    // there is nothing here to report as skipped.
    expect(byKey.has('connector_google')).toBe(false);
    expect(byKey.has('connector_microsoft')).toBe(false);

    // The headline is computed from those items, so it cannot disagree with
    // them the way a hardcoded reassurance could.
    expect(body.canComplete).toBe(true);
    expect(body.headline).not.toMatch(/skipped/);

    expect(body.summary.deployment.certificateVerified).toBe(false);
    expect(body.summary.reminders.join(' ')).toMatch(/master key/i);
  });
});

// ------------------------------------------------------------------- 10
describe('external LLM acknowledgment', () => {
  beforeEach(async () => { await runWizard('llm'); });

  it('refuses a hosted provider without an explicit acknowledgment', async () => {
    for (const ack of [undefined, false, 'true', 1, {}, null]) {
      const res = await call('/api/setup/steps/llm', {
        method: 'POST',
        body: { provider: 'anthropic', model: 'claude', apiKey: 'fake-llm-key-DO-NOT-USE-0003', externalAcknowledged: ack },
      });
      expect(res.status, String(ack)).toBe(400);
      expect(res.body.error).toMatch(/leaves this server/i);
    }
    expect((await db.query(`select * from llm_providers`))).toHaveLength(0);
  });

  it('accepts it with the acknowledgment, and records when it was given', async () => {
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'anthropic', model: 'claude', apiKey: 'fake-llm-key-DO-NOT-USE-0003', externalAcknowledged: true },
    });
    expect(res.status).toBe(200);
    const rows = await db.query<{ external_acknowledged: boolean; external_acknowledged_at: string | null }>(
      `select external_acknowledged, external_acknowledged_at from llm_providers`,
    );
    expect(rows[0].external_acknowledged).toBe(true);
    expect(rows[0].external_acknowledged_at).not.toBeNull();
  });

  it('does not demand it for a self-hosted endpoint', async () => {
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'openai_compatible', model: 'llama3', baseUrl: 'http://ollama.local:11434/v1' },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a self-hosted endpoint with no or a malformed base URL', async () => {
    for (const baseUrl of [undefined, '', 'not-a-url', 'ftp://x.test']) {
      const res = await call('/api/setup/steps/llm', {
        method: 'POST', body: { provider: 'openai_compatible', model: 'llama3', baseUrl },
      });
      expect(res.status, String(baseUrl)).toBe(400);
    }
  });

  it('reuses nobody’s session and reads nobody’s credential store', async () => {
    // This replaces a Phase 4 assertion that the wizard mentioned
    // "subscription" nowhere at all. That was the right test when no compliant
    // subscription path existed; Phase 13.3 built one — the operator's own
    // first-party Codex CLI, run as a subprocess under their own login — and
    // LB2 requires the wizard to offer it. So the blanket ban is gone.
    //
    // What has NOT changed, and is what the old test was really protecting, is
    // that Josi never helps itself to a credential somebody else stored. That
    // is asserted here directly, over the whole setup surface, rather than by
    // banning a word.
    const fs = await import('node:fs');
    const sources = ['setupRoutes.ts', 'verifySteps.ts', 'steps.ts', 'hostChecks.ts']
      .map((f) => fs.readFileSync(new URL(`../src/setup/${f}`, import.meta.url), 'utf8'))
      .join('\n');

    for (const forbidden of [
      'auth.json',        // the Codex CLI's own credential file
      '.codex/',
      'session_key',
      'sessionKey',
      'keychain',
      'security find-generic-password',
      'cookies.sqlite',
      'Cookies',
      'Login Data',
      'localStorage',
    ]) {
      expect(sources, `setup must never read ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ------------------------------------------------------------------- 11
describe('the two SMTP profiles', () => {
  it('normalizes and validates Google app passwords before SMTP authentication', async () => {
    await runWizard('smtp');
    const body = structuredClone(SMTP_BODY);
    body.system.host = 'smtp.gmail.com';
    body.system.password = 'abcd efgh ijkl mnop';
    const saved = await call('/api/setup/steps/smtp', { method: 'POST', body });
    expect(saved.status).toBe(200);
    const [profile] = await db.query<{ password_enc: string }>(
      `select password_enc from smtp_profiles where kind = 'system'`,
    );
    expect(openSealed<{ vaultItemId:string }>(loadMasterKey({ path: keyPath }),profile.password_enc).vaultItemId).toBeTruthy();
    const [owner]=await db.query<{id:string}>(`select id from users where role='super_admin'`);
    expect((await getVaultSecret(db,loadMasterKey({path:keyPath}),{ownerUserId:owner.id,service:'smtp',slot:'system'})).reveal()).toContain('abcdefghijklmnop');

    const malformed = structuredClone(body);
    malformed.system.password = 'abcd efgh ijkl mno';
    const rejected = await call('/api/setup/steps/smtp', { method: 'POST', body: malformed });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/exactly 16/i);
  });

  it('is optional and writes no placeholder configuration when skipped', async () => {
    await runWizard('smtp');
    const res = await call('/api/setup/steps/smtp', { method: 'POST', body: { skip: true } });
    expect(res.status).toBe(200);
    expect(await db.query(`select * from smtp_profiles`)).toHaveLength(0);
    const state = await call('/api/setup/state');
    // Google and Microsoft used to sit here as step 6. They are registered
    // after installation now, so security follows email directly.
    expect(state.body.nextStep).toBe('security');
  });

  it('creates two distinct profiles without duplicating the password', async () => {
    await runWizard();
    const rows = await db.query<{ kind: string; copy_from_system: boolean; password_enc: string | null; from_address: string; host: string | null }>(
      `select kind, copy_from_system, password_enc, from_address, host from smtp_profiles order by kind`,
    );
    expect(rows).toHaveLength(2);

    const comms = rows.find((r) => r.kind === 'communications')!;
    const system = rows.find((r) => r.kind === 'system')!;

    // Distinct sender identities…
    expect(system.from_address).toBe('noreply@example.test');
    expect(comms.from_address).toBe('josi@example.test');
    // …one copy of the credential.
    expect(system.password_enc).toBeTruthy();
    expect(comms.password_enc).toBeNull();
    expect(comms.copy_from_system).toBe(true);
    expect(comms.host).toBeNull();
  });

  it('supports a fully separate communications server', async () => {
    await runWizard('smtp');
    const res = await call('/api/setup/steps/smtp', {
      method: 'POST',
      body: {
        system: SMTP_BODY.system,
        communications: {
          copyFromSystem: false, host: 'smtp2.example.test', port: 465, security: 'tls',
          username: 'josi@example.test', password: 'a-different-password',
          fromName: 'Josi', fromAddress: 'josi@example.test',
        },
        testTo: 'owner@example.test',
      },
    });
    expect(res.status).toBe(200);
    const rows = await db.query<{ kind: string; password_enc: string | null }>(
      `select kind, password_enc from smtp_profiles order by kind`,
    );
    const [comms, system] = [rows.find((r) => r.kind === 'communications')!, rows.find((r) => r.kind === 'system')!];
    expect(looksSealed(comms.password_enc)).toBe(true);
    // Two different secrets produce two different ciphertexts.
    expect(comms.password_enc).not.toBe(system.password_enc);
  });

  it('sends exactly one test message, to the address the administrator named', async () => {
    // The inverse of what this test used to assert. It checked that setup sent
    // nothing — which was true, and was the defect: mail was reported as
    // configured without anybody having established that it worked.
    sentMail.length = 0;
    await runWizard();

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toEqual(['owner@example.test']);
    expect(sentMail[0].subject).toBe('Josi test message');
    // Nothing about the installation travels in it.
    expect(sentMail[0].text).not.toMatch(/password|secret|key|token/i);

    const verification = await db.query<{ status: string; target: string }>(
      `select status, target from setup_verifications where item = 'smtp'`,
    );
    expect(verification[0].status).toBe('passed');
    expect(verification[0].target).toBe('owner@example.test');
  });

  it('refuses to store mail configuration without sending or skipping', async () => {
    await runWizard('smtp');
    const { testTo, ...withoutAddress } = SMTP_BODY;
    void testTo;
    const res = await call('/api/setup/steps/smtp', { method: 'POST', body: withoutAddress });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/without sending one/i);
    expect(await db.query(`select * from smtp_profiles`)).toHaveLength(0);
  });

  it('keeps the credentials when the send fails, and records the failure', async () => {
    // Failing to deliver is not a reason to make somebody retype an SMTP
    // password. Mail is optional, so the failure does not block completion —
    // it is recorded, and the review screen shows it as failed rather than
    // silently as skipped.
    await runWizard('smtp');
    const failing = {
      async send() { throw Object.assign(new Error('nope'), { category: 'auth' }); },
    };
    await stopServer();
    const app = createApp(db, {
      cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
      llmFetch, llmResolve, connectorFetch, mailTransport: failing,
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const res = await call('/api/setup/steps/smtp', { method: 'POST', body: SMTP_BODY });
    expect(res.status).toBe(200);
    expect(res.body.verification.status).toBe('failed');
    expect(res.body.verification.category).toBe('auth');
    expect(await db.query(`select * from smtp_profiles`)).toHaveLength(2);

    const review = (await call('/api/setup/review')).body;
    const smtp = review.items.find((i: any) => i.key === 'smtp');
    expect(smtp.status).toBe('configured_but_failed');
    expect(smtp.verification.target).toBe('owner@example.test');
    // Optional, so it does not stop the installation being finished.
    expect(smtp.blocking).toBe(false);
  });
});

// ------------------------------------------------------------------- 12
describe('Google and Microsoft are not part of installation', () => {
  // They were step 6, and on the LAN-only installation every operator starts
  // with, the step could not be completed: neither provider accepts an HTTPS
  // redirect on a bare address, so the screen could only explain itself and
  // offer "continue without them". A step whose sole outcome is being skipped
  // is not a step. Registration moved to the admin Connectors page, which is
  // reachable once a domain exists.

  it('is not a step the wizard knows about', async () => {
    const res = await call('/api/setup/state');
    const ids = (res.body.steps as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain('connectors');
    expect(ids).toEqual([
      'host_checks', 'owner', 'domain', 'llm', 'smtp', 'security', 'telemetry', 'review',
    ]);
  });

  it('refuses a submission to the step, like any other unknown name', async () => {
    await runWizard('smtp');
    const res = await call('/api/setup/steps/connectors', {
      method: 'POST', body: { skip: true },
    });
    // The route rejects a name that is not a step at all, exactly as it would
    // for any invented one.
    expect(res.status).toBe(404);
    expect(await db.query(`select * from oauth_clients`)).toHaveLength(0);
  });

  it('does not carry the applications in the review summary', async () => {
    await runWizard();
    const res = await call('/api/setup/review');
    const keys = (res.body.items as Array<{ key: string }>).map((i) => i.key);
    expect(keys).not.toContain('connector_google');
    expect(keys).not.toContain('connector_microsoft');
    // What remains is exactly what setup actually configures.
    expect(keys).toEqual(['llm', 'smtp']);
  });

  it('no longer serves the wizard-only callback guidance', async () => {
    await runWizard('smtp');
    const res = await call('/api/setup/connector-guidance');
    expect(res.status).toBe(404);
  });
});

// ------------------------------------------------------------------- 13
describe('telemetry is off unless affirmatively enabled', () => {
  const cases: Array<[string, unknown]> = [
    ['omitted', {}],
    ['false', { enabled: false }],
    ['string true', { enabled: 'true' }],
    ['number 1', { enabled: 1 }],
    ['string yes', { enabled: 'yes' }],
    ['object', { enabled: {} }],
    ['array', { enabled: [true] }],
    ['null', { enabled: null }],
  ];

  for (const [label, body] of cases) {
    it(`stays off when enabled is ${label}`, async () => {
      await runWizard('telemetry');
      expect((await call('/api/setup/steps/telemetry', { method: 'POST', body })).status).toBe(200);
      const rows = await db.query<{ enabled: boolean; opted_in_at: string | null }>(
        `select enabled, opted_in_at from telemetry_state where id = true`,
      );
      expect(rows[0].enabled).toBe(false);
      expect(rows[0].opted_in_at).toBeNull();
    });
  }

  it('turns on only for a literal true, and records when', async () => {
    await runWizard('telemetry');
    expect((await call('/api/setup/steps/telemetry', { method: 'POST', body: { enabled: true } })).status).toBe(200);
    const rows = await db.query<{ enabled: boolean; opted_in_at: string | null }>(
      `select enabled, opted_in_at from telemetry_state where id = true`,
    );
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].opted_in_at).not.toBeNull();
  });

  it('cannot be enabled without recording consent, even directly in the database', async () => {
    await expect(
      db.query(`update telemetry_state set enabled = true, opted_in_at = null where id = true`),
    ).rejects.toThrow();
  });

  it('transmits no telemetry during setup, whatever else it contacts', async () => {
    // This used to assert that setupRoutes.ts contained no `fetch(` and no
    // external URL at all. That was a fair proxy when the wizard contacted
    // nothing — and it stopped being one when LB4 made the wizard test what it
    // configures, because now it deliberately calls model providers, mail
    // servers and OAuth token endpoints.
    //
    // So the assertion is narrowed to what it was actually protecting: no
    // telemetry leaves during setup. The endpoints the wizard MAY reach are
    // enumerated, and anything else is a failure.
    const fs = await import('node:fs');
    const sources = ['setupRoutes.ts', 'verifySteps.ts', 'steps.ts', 'hostChecks.ts']
      .map((f) => fs.readFileSync(new URL(`../src/setup/${f}`, import.meta.url), 'utf8'))
      .join('\n');

    // No telemetry client, no analytics, no phone-home of any shape.
    for (const forbidden of [/telemetry.*(post|send|fetch)/i, /analytics/i, /josi\.(com|io|dev)/i]) {
      expect(sources, String(forbidden)).not.toMatch(forbidden);
    }

    // Every absolute URL the setup surface names, checked against a list.
    // Comments are stripped first: they discuss endpoints in order to explain
    // why the code does not call them, and an example of what NOT to build is
    // not a call.
    const code = sources
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    const urls = [...code.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0].toLowerCase());
    const allowed = [
      // Endpoints the server calls.
      'https://api.openai.com', 'https://api.x.ai', 'https://api.anthropic.com',
      // Links the browser is offered so an administrator can open the console
      // they need. The server never requests these; they are hrefs.
      'https://console.cloud.google.com', 'https://entra.microsoft.com',
    ];
    for (const url of urls) {
      expect(allowed.some((a) => url.startsWith(a)), `setup names an unexpected endpoint: ${url}`).toBe(true);
    }

    // And the telemetry row itself stays off through a whole wizard run.
    await runWizard();
    const rows = await db.query<{ enabled: boolean }>(`select enabled from telemetry_state where id = true`);
    expect(rows[0].enabled).toBe(false);
  });
});

// ------------------------------------------------------- host checks
describe('host checks', () => {
  it('report actionable results without leaking host internals', async () => {
    const res = await call('/api/setup/host-checks');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    // No paths, no versions, no byte counts, no hostnames.
    expect(text).not.toMatch(/\/(usr|var|home|root|tmp)\//);
    expect(text).not.toMatch(/v?\d+\.\d+\.\d+/);
    expect(text).not.toMatch(/\d{6,}/);
    expect(text).not.toContain(keyPath);
    for (const c of res.body.checks) {
      expect(['pass', 'warn', 'fail']).toContain(c.status);
      expect(c.detail.length).toBeGreaterThan(10);
    }
  });

  it('blocks completion on a mandatory failure but not on a warning', async () => {
    const res = await call('/api/setup/host-checks');
    const warns = res.body.checks.filter((c: any) => c.status === 'warn');
    for (const w of warns) expect(res.body.blocking).not.toContain(w.id);
  });
});

// ------------------------------------------------------- install identity
describe('install identity', () => {
  it('binds completion to the stored random identity, never to client input', async () => {
    await runWizard();
    await call('/api/setup/complete', { method: 'POST', body: { install_id: 'attacker-chosen' } });
    const rows = await db.query<{ install_id: string }>(`select install_id from setup_state where id = true`);
    const identity = await db.query<{ install_id: string }>(`select install_id from install_identity where id = true`);
    expect(rows[0].install_id).toBe(identity[0].install_id);
    expect(rows[0].install_id).not.toBe('attacker-chosen');
    expect(rows[0].install_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
