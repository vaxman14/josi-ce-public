// The expanded provider catalogue, from the installer's side.
//
// The admin Model page was catalogue-driven before the wizard was, which made
// the first choice narrower than every later one: an operator could point a
// finished installation at Bedrock or Vertex, but could not get through setup
// without picking one of five hardcoded providers and typing a single "API
// key". A provider whose credential is a key pair, a service account or a
// region had no way to be configured during installation at all.
//
// These tests are written against that gap: the wizard is sent the same
// catalogue the admin page is sent, and the model step reads credentials by the
// catalogue's own field definitions rather than by a fixed field name.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { looksSealed } from '@josi-ce/core';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-provider-eco-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 5).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;

interface Res { status: number; body: any }

let jar = '';
async function call(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jar) headers.cookie = jar;
  const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const sendsBody = method !== 'GET' && method !== 'HEAD' && opts.body !== undefined;
  const res = await fetch(`${base}${path}`, {
    method, headers, body: sendsBody ? JSON.stringify(opts.body) : undefined, redirect: 'manual',
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const first = raw.split(';')[0];
    const [name] = first.split('=');
    const rest = jar.split('; ').filter((c) => c && !c.startsWith(`${name}=`));
    jar = [...rest, first].join('; ');
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

// Every provider in this file is reached over a network this suite does not
// have. Discovery failing is the normal case here and is deliberately NOT
// treated as evidence against a model — see `assertModelIsOffered`, which is
// permissive precisely so an air-gapped installation can still be configured.
const llmFetch: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
const llmResolve = async () => ['93.184.216.34'];

const OWNER = { email: 'o@ce.test', username: 'owner', password: 'a-long-enough-password' };

/** Drives the wizard up to, but not into, the model step. */
async function wizardToLlm() {
  const steps: Array<[string, unknown]> = [
    ['host_checks', {}],
    ['owner', OWNER],
    ['domain', { domain: 'josi.example.test', tlsMode: 'bundled_caddy' }],
  ];
  for (const [step, body] of steps) {
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

describe('the installer is offered the same catalogue as the admin page', () => {
  it('sends the catalogue with the wizard state', async () => {
    const res = await call('/api/setup/state');
    expect(res.status).toBe(200);
    const catalog = res.body.providerCatalog as Array<Record<string, any>>;
    expect(Array.isArray(catalog)).toBe(true);

    // The specific point of the item: not the old five. The wizard used to
    // hardcode openai_compatible, openai, anthropic and xai plus two
    // subscriptions, while the server already accepted every kind below.
    const kinds = catalog.map((p) => p.kind);
    for (const kind of [
      'openai_compatible', 'openai', 'anthropic', 'xai', 'deepseek', 'qwen', 'mistral', 'moonshot',
      'zhipu', 'openrouter', 'minimax', 'gemini', 'cohere', 'bedrock', 'azure_ai', 'vertex_ai',
      'ernie', 'hunyuan',
    ]) {
      expect(kinds, `${kind} must be offered during installation`).toContain(kind);
    }
  });

  it('describes each provider well enough to draw a form for it', async () => {
    const res = await call('/api/setup/state');
    const catalog = res.body.providerCatalog as Array<Record<string, any>>;

    const bedrock = catalog.find((p) => p.kind === 'bedrock');
    expect(bedrock).toBeTruthy();
    // A key pair and a region, not an "API key". This is the shape the old
    // single-field wizard could not express.
    const bedrockFields = (bedrock!.fields as Array<Record<string, any>>).map((f) => f.key);
    expect(bedrockFields).toContain('region');
    expect(bedrockFields).toContain('accessKeyId');
    expect(bedrockFields).toContain('secretAccessKey');
    // Bedrock's endpoint is derived from the region, so the form must not draw
    // an address box for it.
    expect(bedrock!.baseUrlMode).toBe('none');

    // Azure names deployments rather than models, and the form says which.
    const azure = catalog.find((p) => p.kind === 'azure_ai');
    expect(azure!.modelNoun).toBe('deployment');
    expect(azure!.baseUrlMode).toBe('required');

    // Nothing in the catalogue is a credential, and every field carries the
    // flag the form needs to render a password box.
    for (const provider of catalog) {
      expect(Object.keys(provider)).not.toContain('apiKey');
      for (const field of provider.fields as Array<Record<string, any>>) {
        expect(typeof field.secret).toBe('boolean');
        expect(typeof field.required).toBe('boolean');
      }
    }
  });
});

describe('the model step reads credentials by the catalogue', () => {
  it('names every missing required field rather than asking for "an API key"', async () => {
    await wizardToLlm();
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: {
        provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        externalAcknowledged: true,
      },
    });
    expect(res.status).toBe(400);
    // The old rule said "an API key is required for this provider", which named
    // a field Bedrock does not have.
    expect(res.body.error).not.toMatch(/an API key is required/i);
    expect(res.body.error).toMatch(/region/i);
    expect(res.body.error).toMatch(/access key id/i);
    expect(await db.query(`select * from llm_providers`)).toHaveLength(0);
  });

  it('refuses an endpoint address for a provider whose endpoint is derived', async () => {
    await wizardToLlm();
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: {
        provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-east-1', accessKeyId: 'not-a-real-access-key-id',
        secretAccessKey: 'not-a-real-secret-value-for-tests',
        baseUrl: 'https://example.invalid/v1', externalAcknowledged: true,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not take an endpoint address/i);
    expect(await db.query(`select * from llm_providers`)).toHaveLength(0);
  });

  it('stores every secret field in one sealed envelope and the settings beside it', async () => {
    await wizardToLlm();
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: {
        provider: 'bedrock', model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        region: 'us-east-1',
        // Deliberately not credential-shaped: the pre-commit scanner rejects
        // anything that looks real, and what matters here is only that several
        // distinct secret fields survive the round trip.
        accessKeyId: 'not-a-real-access-key-id',
        secretAccessKey: 'not-a-real-secret-value-for-tests',
        externalAcknowledged: true,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const rows = await db.query<{
      provider: string; model: string; base_url: string | null;
      api_key_enc: string | null; provider_config: unknown;
    }>(`select provider, model, base_url, api_key_enc, provider_config from llm_providers`);
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('bedrock');
    // Derived endpoint: nothing stored, rather than a guess written down.
    expect(rows[0].base_url).toBeNull();
    // The key pair is sealed, never in the clear, and never in provider_config.
    expect(looksSealed(rows[0].api_key_enc!)).toBe(true);
    expect(rows[0].api_key_enc).not.toMatch(/not-a-real-access-key-id/);

    const config = typeof rows[0].provider_config === 'string'
      ? JSON.parse(rows[0].provider_config as string)
      : rows[0].provider_config as Record<string, unknown>;
    // The region is a setting, so it is readable; the secrets are not in here.
    expect(config.region).toBe('us-east-1');
    expect(JSON.stringify(config)).not.toMatch(/not-a-real-secret-value-for-tests/);
    expect(JSON.stringify(config)).not.toMatch(/not-a-real-access-key-id/);
  });

  it('still refuses a provider this build does not offer', async () => {
    await wizardToLlm();
    const res = await call('/api/setup/steps/llm', {
      method: 'POST',
      body: { provider: 'not_a_provider', model: 'x', externalAcknowledged: true },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/choose a model provider/i);
  });
});

describe('discovery during installation carries the whole credential', () => {
  it('accepts a multi-field credential and reports what it could not reach', async () => {
    await wizardToLlm();
    const res = await call('/api/setup/models', {
      method: 'POST',
      body: {
        provider: 'bedrock', region: 'us-east-1',
        accessKeyId: 'not-a-real-access-key-id',
        secretAccessKey: 'not-a-real-secret-value-for-tests',
      },
    });
    // The route answers rather than throwing: the network is unavailable in
    // this suite, and "I could not check" is a different answer from "that is
    // wrong". What matters is that the request shape was understood at all.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('models');
    expect(res.body).toHaveProperty('fromCatalog');
  });
});
