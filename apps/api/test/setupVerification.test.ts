// LB4 + LB6 over the wire — setup tests what it configures, and cannot finish
// while something required does not work.
//
// The wizard used to say so itself, in its own comments: "No message is sent",
// "No OAuth flow is started and no account is connected". It then reported
// every one of those steps as configured, and `/complete` accepted the
// installation. The only thing that had been established was that the fields
// parsed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-verify-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64'));

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

// ---------------------------------------------------------------- the stubs
//
// Each is a knob the tests turn, so a suite can make the model answer, refuse
// with a specific category, or fail to be reached at all.

let llmBehaviour: 'ok' | 'unauthorized' | 'quota' | 'empty' | 'unreachable' = 'ok';
const llmFetch: typeof fetch = async (url, init) => {
  if (String(url).endsWith('/models')) {
    return new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }), { status: 200 });
  }
  if (llmBehaviour === 'unreachable') throw new Error('ECONNREFUSED');
  if (llmBehaviour === 'unauthorized') {
    return new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 });
  }
  if (llmBehaviour === 'quota') {
    return new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), { status: 429 });
  }
  const request = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[]; response_format?: unknown; messages?: Array<{ content?: unknown }> };
  const prompt = JSON.stringify(request.messages ?? []);
  const message = request.tools?.length
    ? { content: '', tool_calls: [{ id: 'probe', type: 'function', function: { name: 'record_number', arguments: '{"value":7}' } }] }
    : { content: llmBehaviour === 'empty' ? '' : request.response_format ? '{"ok":true}' : /color is this image/i.test(prompt) ? 'red' : /Ignore the text above/i.test(prompt) ? 'ok' : 'ready' };
  return new Response(JSON.stringify({
    choices: [{ message }],
    usage: { prompt_tokens: 5, completion_tokens: 1 },
  }), { status: 200 });
};
const llmResolve = async () => ['93.184.216.34'];

let connectorBehaviour: 'ok' | 'bad_client' = 'ok';
const connectorFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({ error: connectorBehaviour === 'ok' ? 'invalid_grant' : 'invalid_client' }),
    { status: connectorBehaviour === 'ok' ? 400 : 401 },
  );

let mailFails = false;
const sent: Array<{ to: string[] }> = [];
const mailTransport = {
  async send(m: { to: string[] }) {
    if (mailFails) throw Object.assign(new Error('refused'), { category: 'auth' });
    sent.push({ to: m.to });
    return { messageId: 'x' };
  },
};

const OWNER = { email: 'o@ce.test', username: 'owner', password: 'a-long-enough-password' };

/** Drives the wizard to a named step without going past it. */
async function wizardTo(stopBefore: string) {
  const steps: Array<[string, unknown]> = [
    ['host_checks', {}],
    ['owner', OWNER],
    ['domain', { domain: 'josi.example.test', tlsMode: 'bundled_caddy' }],
    ['llm', { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-key-0001', externalAcknowledged: true }],
    ['smtp', { skip: true }],
    ['security', {}],
    ['telemetry', {}],
    ['review', {}],
  ];
  for (const [step, body] of steps) {
    if (step === stopBefore) return;
    const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body });
    expect(res.status, `${step}: ${JSON.stringify(res.body)}`).toBe(200);
    if(step==='owner')expect((await call('/api/setup/vault-recovery-confirmed',{method:'POST',body:{}})).status).toBe(200);
    // The model page now owns its test. A helper that continues beyond it has
    // to prove the model there, just like a real browser. Tests that stop at
    // SMTP deliberately retain the unverified state so they can exercise the
    // verification endpoint itself.
    if (step === 'llm' && stopBefore !== 'smtp') {
      const verified = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
      expect(verified.status, JSON.stringify(verified.body)).toBe(200);
      expect(verified.body.status).toBe('passed');
    }
  }
}

beforeEach(async () => {
  db = await testDb();
  llmBehaviour = 'ok';
  connectorBehaviour = 'ok';
  mailFails = false;
  sent.length = 0;
  jar = 'josi_csrf=test-token';
  await db.query(`update setup_state set csrf_seed = null where id = true`).catch(() => undefined);
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
    llmFetch, llmResolve, connectorFetch, mailTransport,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('LB4.1 — the model step makes a real request', () => {
  it('passes only when a model actually answers', async () => {
    await wizardTo('smtp');
    const res = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('passed');
    // The model that answered is recorded, so "tested" is checkable.
    expect(res.body.target).toBe('gpt-4o-mini');
  });

  it('a pass carries through: the provider is activated, not just annotated', async () => {
    // Round-2 item 2. The wizard said "passed", setup completed, and the admin
    // Model page then said "not tested" and asked for the same test again —
    // the product refusing to trust its own check. A passing verification is a
    // real chat that really happened, so the chat capability is recorded and
    // the provider activated. The complete onboarding probe records tools too.
    await wizardTo('smtp');
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    const [row] = await db.query<{
      activated_at: string | null; probed_at: string | null;
      cap_chat: boolean | null; cap_tool_calling: boolean | null;
    }>(`select activated_at, probed_at, cap_chat, cap_tool_calling from llm_providers where role = 'primary'`);
    expect(row.cap_chat).toBe(true);
    expect(row.probed_at).not.toBeNull();
    expect(row.activated_at).not.toBeNull();
    expect(row.cap_tool_calling).toBe(true);
  });

  it('a failing verification activates nothing', async () => {
    await wizardTo('smtp');
    llmBehaviour = 'unauthorized';
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    const [row] = await db.query<{ activated_at: string | null }>(
      `select activated_at from llm_providers where role = 'primary'`,
    );
    expect(row.activated_at).toBeNull();
  });

  it('fails, and says which kind of failure it was', async () => {
    await wizardTo('smtp');
    llmBehaviour = 'unauthorized';
    const res = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(res.body.status).toBe('failed');
    expect(res.body.category).toBe('authentication');
    expect(res.body.detail).toMatch(/rejected the credential/i);
    // The provider's short code is repeated; its prose never is.
    expect(res.body.detail).toContain('invalid_api_key');
  });

  it('distinguishes a spent account from a rate limit', async () => {
    await wizardTo('smtp');
    llmBehaviour = 'quota';
    const res = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(res.body.category).toBe('billing');
  });

  it('refuses a model that answers with nothing', async () => {
    // A 200 is not an answer. A misconfigured proxy returns a well-formed
    // response with no content, and accepting that means accepting a model
    // that says nothing to anybody.
    await wizardTo('smtp');
    llmBehaviour = 'empty';
    const res = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(res.body.status).toBe('failed');
    expect(res.body.detail).toMatch(/usable basic reply/i);
  });

  it('reports an unreachable provider as a network failure', async () => {
    await wizardTo('smtp');
    llmBehaviour = 'unreachable';
    const res = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(res.body.category).toBe('network');
  });
});

describe('LB4.4 / LB6.5 — a required failure blocks completion', () => {
  it('refuses to finish while the model has never been tested', async () => {
    await wizardTo('smtp');
    const next = await call('/api/setup/steps/smtp', { method: 'POST', body: { skip: true } });
    expect(next.status).toBe(409);
    expect(next.body.expected).toBe('llm');
    const res = await call('/api/setup/complete', { method: 'POST', body: {} });
    expect(res.status).toBe(409);
    expect(res.body.expected).toBe('llm');
    // And setup is still open, not half-closed.
    expect((await call('/api/setup/state')).body.completed).toBe(false);
  });

  it('refuses to finish while the model test is failing', async () => {
    await wizardTo('__none__');
    llmBehaviour = 'unauthorized';
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    const res = await call('/api/setup/complete', { method: 'POST', body: {} });
    expect(res.status).toBe(409);
    expect(res.body.expected).toBe('llm');
    const review = await call('/api/setup/review');
    expect(review.body.blocking[0].status).toBe('configured_but_failed');
  });

  it('finishes once it passes — the same installation, one test later', async () => {
    await wizardTo('__none__');
    llmBehaviour = 'unauthorized';
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(409);

    // LB4.5's rerun control: the same endpoint, no credentials re-entered.
    llmBehaviour = 'ok';
    const retried = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect(retried.body.status).toBe('passed');

    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(200);
  });

  it('does not let an optional failure block anything', async () => {
    await wizardTo('smtp');
    expect((await call('/api/setup/verify/llm', { method: 'POST', body: {} })).body.status).toBe('passed');
    mailFails = true;
    const smtp = await call('/api/setup/steps/smtp', {
      method: 'POST',
      body: {
        system: {
          host: 'smtp.example.test', port: 587, security: 'starttls',
          username: 'u', password: 'p', fromName: 'Josi', fromAddress: 'no@example.test',
        },
        communications: { copyFromSystem: true, fromName: 'Josi', fromAddress: 'j@example.test' },
        testTo: 'admin@example.test',
      },
    });
    expect(smtp.status).toBe(200);
    expect(smtp.body.verification.status).toBe('failed');

    await call('/api/setup/steps/security', { method: 'POST', body: {} });
    await call('/api/setup/steps/telemetry', { method: 'POST', body: {} });
    await call('/api/setup/steps/review', { method: 'POST', body: {} });
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });

    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(200);
  });
});

describe('LB4.3 — the OAuth applications left the wizard', () => {
  // These used to register a Google or Microsoft application during setup and
  // handshake it against the provider. Neither can happen at installation
  // time: both providers require an HTTPS redirect on a real domain name, and
  // the installation being set up is reachable only on the LAN. The step could
  // therefore only ever explain itself and offer "continue without them", so it
  // was removed rather than left as a knowingly unusable screen.
  //
  // The handshake itself is not gone — `verifyOAuthClient` still backs the
  // admin Connectors page, which is where an application is registered once a
  // domain exists.

  it('is not offered as a verifiable setup item', async () => {
    await wizardTo('__none__');
    for (const item of ['connector_google', 'connector_microsoft']) {
      const res = await call(`/api/setup/verify/${item}`, { method: 'POST', body: {} });
      expect(res.status, item).toBe(404);
    }
  });

  it('leaves no application registered by the wizard', async () => {
    await wizardTo('__none__');
    expect(await db.query(`select * from oauth_clients`)).toHaveLength(0);
  });
});

describe('LB6.3 — the review carries no secret', () => {
  it('returns no credential, ciphertext or password in any form', async () => {
    await wizardTo('smtp');
    mailFails = false;
    await call('/api/setup/steps/smtp', {
      method: 'POST',
      body: {
        system: {
          host: 'smtp.example.test', port: 587, security: 'starttls',
          username: 'u', password: 'the-smtp-password-value',
          fromName: 'Josi', fromAddress: 'no@example.test',
        },
        communications: { copyFromSystem: true, fromName: 'Josi', fromAddress: 'j@example.test' },
        testTo: 'admin@example.test',
      },
    });
    await call('/api/setup/steps/connectors', {
      method: 'POST', body: { google: { clientId: 'the-client-id', clientSecret: 'the-client-secret-value' } },
    });

    const body = JSON.stringify((await call('/api/setup/review')).body);
    for (const secret of ['fake-key-0001', 'the-smtp-password-value', 'the-client-secret-value']) {
      expect(body, secret).not.toContain(secret);
    }
    // And no sealed blob either — an operator confirming their choices has no
    // use for ciphertext and it is one paste away from a support ticket.
    expect(body).not.toMatch(/"v1\./);
  });

  it('names an item exactly one status, from the fixed set', async () => {
    await wizardTo('__none__');
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    const body = (await call('/api/setup/review')).body;
    const allowed = [
      'configured_and_tested', 'configured_but_failed', 'skipped', 'unavailable', 'required',
    ];
    for (const item of body.items) {
      expect(allowed, `${item.key} -> ${item.status}`).toContain(item.status);
      expect(item.statusLabel).toBeTruthy();
    }
  });
});

describe('LB6.4 — a step holding configuration can be corrected', () => {
  it('lets the configuration steps be submitted again while setup is open', async () => {
    await wizardTo('__none__');
    // Two rather than three: `connectors` was revisable until Google and
    // Microsoft left the wizard entirely.
    for (const [step, body] of [
      ['llm', { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'fake-key-0002', externalAcknowledged: true }],
      ['smtp', { skip: true }],
    ] as const) {
      const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body });
      expect(res.status, step).toBe(200);
      if (step === 'llm') {
        const verified = await call('/api/setup/verify/llm', { method: 'POST', body: {} });
        expect(verified.body.status).toBe('passed');
      }
    }
  });

  it('re-tests on the way through, so a correction is proven rather than assumed', async () => {
    await wizardTo('__none__');
    llmBehaviour = 'unauthorized';
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect((await call('/api/setup/review')).body.canComplete).toBe(false);

    // A corrected key, submitted through the same step.
    llmBehaviour = 'ok';
    await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'a-working-key', externalAcknowledged: true },
    });
    // The step stores; the verification is what clears the block.
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect((await call('/api/setup/review')).body.canComplete).toBe(true);
  });

  it('still refuses to replay the steps that are not configuration', async () => {
    // The reason `already_completed` exists. `owner` creates the single super
    // admin, and `telemetry` records a consent — a step that can be submitted
    // twice is a consent that can be flipped by a replayed request.
    await wizardTo('__none__');
    for (const [step, body] of [
      ['owner', { ...OWNER, email: 'attacker@ce.test', username: 'attacker' }],
      ['domain', { domain: 'evil.example.test', tlsMode: 'bundled_caddy' }],
      ['security', {}],
      ['telemetry', { enabled: true }],
    ] as const) {
      const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body });
      expect(res.status, step).toBe(409);
      expect(res.body.error, step).toMatch(/already done/i);
    }

    // And none of it took effect.
    const users = await db.query<{ email: string }>(`select email from users`);
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('o@ce.test');
    const telemetry = await db.query<{ enabled: boolean }>(`select enabled from telemetry_state where id = true`);
    expect(telemetry[0].enabled).toBe(false);
  });

  it('refuses everything once setup is finished, revisable or not', async () => {
    await wizardTo('__none__');
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(200);
    for (const step of ['llm', 'smtp', 'owner']) {
      const res = await call(`/api/setup/steps/${step}`, { method: 'POST', body: { skip: true } });
      expect(res.status, step).toBe(404);
    }
  });
});

describe('LB2 — the ChatGPT subscription path is offered in the wizard', () => {
  it('offers it on a CE build, with the honest reason for each option that is not on offer', async () => {
    await wizardTo('llm');
    const res = await call('/api/setup/subscription');
    expect(res.status).toBe(200);

    const chatgpt = res.body.options.find((o: any) => o.provider === 'openai_subscription');
    expect(chatgpt.available).toBe(true);
    expect(chatgpt.reason).toMatch(/never sees, stores or forwards your login/i);

    // Claude is offered on the same terms and through the same kind of path:
    // the vendor's own CLI, the vendor's own sign-in, no credential in Josi.
    const claude = res.body.options.find((o: any) => o.id === 'claude_subscription');
    expect(claude.available).toBe(true);
    expect(claude.provider).toBe('anthropic_subscription');
    expect(claude.reason).toMatch(/never sees, stores or forwards your login/i);
    expect(claude.reason).toMatch(/Claude Code/);

    // Copilot is not offered at all any more — not even as an unavailable
    // entry. A choice that can never be chosen is noise (dropped 2026-09-02).
    expect(res.body.options.find((o: any) => o.id === 'copilot_subscription')).toBeUndefined();

    // The rule that never moved: an unavailable option states a reason, and
    // "coming soon" is a guess rather than a reason.
    for (const option of res.body.options) {
      expect(option.reason, option.id).not.toMatch(/coming soon/i);
    }

    // Both CLIs are reported separately, because an installation can have
    // either, both or neither signed in.
    expect(res.body).toHaveProperty('cli');
    expect(res.body).toHaveProperty('claudeCli');
  });

  it('reports the CLI honestly when it is not in this environment', async () => {
    // Control the executable boundary explicitly. Relying on the developer's
    // machine not to have Codex installed made this test pass or fail based on
    // the host rather than the product behaviour it claims to prove.
    const originalPath = process.env.PATH;
    process.env.PATH = '/josi-test-no-executables';
    try {
      await wizardTo('llm');
      const res = await call('/api/setup/subscription');
      expect(res.body.cli.installed).toBe(false);
      expect(res.body.cli.detail).toMatch(/not present|could not be run/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('refuses an API key on the subscription path', async () => {
    // A key here would bill an API account while the product called it a
    // subscription. Refused at the route as well as by a database constraint.
    await wizardTo('llm');
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: {
        provider: 'openai_subscription', model: 'gpt-5-codex',
        // Deliberately not key-shaped: the pre-commit scanner rejects anything
        // that looks like a real credential, including in a fixture, and it is
        // right to. What matters here is that a key is present at all.
        apiKey: 'not-a-real-key-and-must-be-refused', externalAcknowledged: true,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must not be given an API key/i);
    expect(await db.query(`select * from llm_providers`)).toHaveLength(0);
  });

  it('refuses to store the provider while the CLI is not signed in', async () => {
    // Saving a provider that cannot answer is exactly the "configured but
    // never checked" shape this whole blocker is about.
    //
    // Point the CLI at an empty home, for the same reason the PATH test above
    // controls its own boundary: with CODEX_HOME unset the child inherits HOME
    // and reads the developer's real ~/.codex, so on any machine that is signed
    // in to Codex the route correctly returned 200 and this test failed for a
    // fact about the host rather than about the product.
    const emptyCodexHome = mkdtempSync(join(tmpdir(), 'josi-ce-codex-empty-'));
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = emptyCodexHome;
    try {
      await wizardTo('llm');
      const res = await call('/api/setup/steps/llm', {
        method: 'POST',
        body: { provider: 'openai_subscription', model: 'gpt-5-codex', externalAcknowledged: true },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sign in first/i);
      expect(await db.query(`select * from llm_providers`)).toHaveLength(0);
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('mounts the sign-in routes behind the edition capability, not behind a guard', async () => {
    // LB2.8's outermost layer. A hosted build's route table must not contain
    // them at all — "absent" rather than "refused", so a hosted artefact does
    // not confirm the capability exists to be asked for.
    const fs = await import('node:fs');
    const source = fs.readFileSync(new URL('../src/setup/setupRoutes.ts', import.meta.url), 'utf8');
    const mounted = source.indexOf("hasCapability('subscription_auth')");
    const routes = source.indexOf("'/subscription/login'");
    expect(mounted, 'the routes must be inside a capability check').toBeGreaterThan(0);
    expect(routes).toBeGreaterThan(mounted);
    // And the provider list the step validates against is the shared one whose
    // hosted behaviour is already proven in the subscription suite.
    expect(source).toContain('savableProviders()');
  });

  it('never reads a credential store to find a login', async () => {
    const fs = await import('node:fs');
    const sources = [
      '../src/setup/setupRoutes.ts',
      '../../../packages/llm/src/providers/codexLogin.ts',
      '../../../packages/llm/src/providers/codexCli.ts',
    ].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');

    // Comments name these in order to say they are never touched.
    const code = sources.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    for (const forbidden of ['auth.json', 'keychain', 'cookies', 'Login Data', 'readFile']) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('the verify endpoint is not a way around the wizard', () => {
  it('404s a name that is not something setup configured', async () => {
    await wizardTo('smtp');
    for (const item of ['owner', 'security', '../../etc/passwd', 'telemetry']) {
      const res = await call(`/api/setup/verify/${encodeURIComponent(item)}`, { method: 'POST', body: {} });
      expect(res.status, item).toBe(404);
    }
  });

  it('is gone once setup is finished', async () => {
    await wizardTo('__none__');
    await call('/api/setup/verify/llm', { method: 'POST', body: {} });
    expect((await call('/api/setup/complete', { method: 'POST', body: {} })).status).toBe(200);
    expect((await call('/api/setup/verify/llm', { method: 'POST', body: {} })).status).toBe(404);
    expect((await call('/api/setup/models', { method: 'POST', body: { provider: 'openai' } })).status).toBe(404);
  });
});

describe('LB3 over the wire — the model list comes from the account', () => {
  it('serves what the provider returned, and no catalogue of its own', async () => {
    await wizardTo('llm');
    const res = await call('/api/setup/models', {
      method: 'POST', body: { provider: 'openai', apiKey: 'fake-key-0002' },
    });
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: any) => m.id)).toEqual(['gpt-4o-mini']);
    for (const invented of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(JSON.stringify(res.body)).not.toContain(invented);
    }
  });

  it('never echoes the key it was given', async () => {
    await wizardTo('llm');
    const res = await call('/api/setup/models', {
      method: 'POST', body: { provider: 'openai', apiKey: 'super-secret-key-value' },
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key-value');
  });

  it('refuses a model the account was not offered', async () => {
    await wizardTo('llm');
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: {
        provider: 'openai', model: 'gpt-5.6-sol',
        apiKey: 'fake-key-0003', externalAcknowledged: true,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not offer/i);
    expect(await db.query(`select * from llm_providers`)).toHaveLength(0);
  });
});
