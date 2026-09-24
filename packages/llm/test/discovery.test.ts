// LB3 — the model list comes from the account, not from this repository.
//
// What was here before: a hardcoded catalog in the web app offering
// `gpt-5.6`, `gpt-5.6-terra` and `gpt-5.6-luna` to every installation. Nobody
// had checked that an account could call them, and an operator who chose one
// found out at the first real request — after setup had already said the model
// was configured.
import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  categorizeFailure, discoverModels, discoveryError, explainCategory, humanizeModelId,
  safeErrorCode,
} from '../src/index.js';

/** A fetch that answers once with whatever is given. */
function stub(status: number, body: unknown, capture?: { url?: string; headers?: Headers }) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = String(url);
      capture.headers = new Headers(init?.headers as HeadersInit);
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// Discovery talks to real hostnames, so the SSRF layer's DNS resolution is
// stubbed to a public address. Nothing is sent anywhere: fetchImpl is a stub.
const resolve = async () => ['93.184.216.34'];
const base = { timeoutMs: 1000, resolve };

describe('LB3.3 — the list is what the credential may use', () => {
  it('asks OpenAI for the account’s models and returns exactly those', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    const result = await discoverModels({
      ...base,
      provider: 'openai',
      apiKey: 'sk-test-key',
      fetchImpl: stub(200, { data: [{ id: 'gpt-4.1' }, { id: 'o3' }] }, seen),
    });

    expect(seen.url).toBe('https://api.openai.com/v1/models');
    expect(seen.headers?.get('authorization')).toBe('Bearer sk-test-key');
    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(['gpt-4.1', 'o3']);
  });

  it('uses Anthropic’s own header scheme and version', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await discoverModels({
      ...base,
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      fetchImpl: stub(200, { data: [] }, seen),
    });
    expect(seen.url).toBe('https://api.anthropic.com/v1/models');
    expect(seen.headers?.get('x-api-key')).toBe('sk-ant-test');
    expect(seen.headers?.get('anthropic-version')).toBe('2023-06-01');
    // Never the bearer scheme; Anthropic ignores it and the request fails as 401.
    expect(seen.headers?.get('authorization')).toBeNull();
  });

  it('prefers the provider’s own display name when it gives one', async () => {
    const result = await discoverModels({
      ...base,
      provider: 'anthropic',
      apiKey: 'k',
      fetchImpl: stub(200, {
        data: [
          { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-opus-4-1-20250805' },
        ],
      }),
    });
    const [opus, sonnet] = result.models;
    expect(sonnet.label).toBe('Claude Sonnet 4.5');
    expect(sonnet.fromProvider).toBe(true);
    // And derives one where it does not.
    expect(opus.fromProvider).toBe(false);
    expect(opus.label).toContain('Claude');
  });

  it('reads a self-hosted runtime that answers with `models` instead of `data`', async () => {
    const result = await discoverModels({
      ...base,
      provider: 'openai_compatible',
      baseUrl: 'https://llm.internal.example/v1',
      fetchImpl: stub(200, { models: [{ id: 'llama-3.3-70b-instruct' }] }),
    });
    expect(result.ok).toBe(true);
    expect(result.models[0].id).toBe('llama-3.3-70b-instruct');
  });

  it('sends no Authorization header to a self-hosted endpoint with no key', async () => {
    const seen: { url?: string; headers?: Headers } = {};
    await discoverModels({
      ...base,
      provider: 'openai_compatible',
      baseUrl: 'https://llm.internal.example/v1',
      fetchImpl: stub(200, { data: [] }, seen),
    });
    expect(seen.headers?.get('authorization')).toBeNull();
  });

  it('deduplicates and ignores rows with no id', async () => {
    const result = await discoverModels({
      ...base,
      provider: 'openai',
      apiKey: 'k',
      fetchImpl: stub(200, { data: [{ id: 'a' }, { id: 'a' }, {}, { id: '' }, { id: 42 }] }),
    });
    expect(result.models.map((m) => m.id)).toEqual(['a']);
  });
});

describe('LB3.2 — nothing is invented', () => {
  it('returns no models at all when discovery fails', async () => {
    // The behaviour being removed is exactly "fall back to a built-in list".
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'bad', fetchImpl: stub(401, { error: { code: 'invalid_api_key' } }),
    });
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });

  it('offers no identifier the provider did not name', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'k', fetchImpl: stub(200, { data: [{ id: 'gpt-4.1' }] }),
    });
    // The specific regression: the fantasy identifiers the old catalog shipped.
    for (const invented of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6']) {
      expect(result.models.map((m) => m.id)).not.toContain(invented);
    }
  });

  it('says so rather than guessing when a runtime has no model list', async () => {
    const result = await discoverModels({
      ...base,
      provider: 'openai_compatible',
      baseUrl: 'https://llm.internal.example/v1',
      fetchImpl: stub(200, { something: 'else' }),
    });
    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.models).toEqual([]);
  });

  it('offers only visible models listed by the signed-in Codex CLI', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai_subscription',
      codexModelList: async () => [
        { id: 'visible-fast', displayName: 'Visible Fast', isDefault: true, hidden: false },
        { id: 'hidden-internal', displayName: 'Internal', isDefault: false, hidden: true },
        { id: 'visible-deep', displayName: 'Visible Deep', isDefault: false, hidden: false },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.unsupported).not.toBe(true);
    expect(result.fromCatalog).not.toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(['visible-fast', 'visible-deep']);
    expect(result.models[0]).toMatchObject({ label: 'Visible Fast', fromProvider: true, recommended: true });
    expect(result.allowsCustomModel).toBe(true);
    expect(result.message).toMatch(/test.*real request/i);
  });

  it('keeps Automatic usable and never leaks CLI errors when the list fails', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai_subscription',
      codexModelList: async () => { throw new Error('secret-token-should-not-leak'); },
    });
    expect(result.ok).toBe(true);
    expect(result.unsupported).toBe(true);
    expect(result.models).toEqual([]);
    expect(result.allowsCustomModel).toBe(true);
    expect(result.message).toMatch(/could not list/i);
    expect(JSON.stringify(result)).not.toContain('secret-token-should-not-leak');
  });

  it('asks the signed-in Codex app-server for visible models without passing an API key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'josi-codex-model-list-'));
    const command = join(dir, 'codex-fixture');
    const prior = process.env.OPENAI_API_KEY;
    try {
      await writeFile(command, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(2);
let ready = false;
let initialized = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    ready = true;
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'model/list') {
    const bad = !ready || !initialized || message.params?.includeHidden !== false || !!process.env.OPENAI_API_KEY;
    process.stdout.write(JSON.stringify(bad
      ? { id: message.id, error: { code: -1, message: 'bad handshake or API key leaked' } }
      : { id: message.id, result: { data: [
          { id: 'cli-visible', displayName: 'Visible in CLI', hidden: false, isDefault: true },
          { id: 'hidden-internal', displayName: 'Hidden', hidden: true, isDefault: false },
        ], nextCursor: null } }) + '\\n');
  }
});
`);
      await chmod(command, 0o700);
      process.env.OPENAI_API_KEY = 'test-secret-should-not-reach-child';
      const result = await discoverModels({ ...base, provider: 'openai_subscription', codexCommand: command });
      expect(result.ok).toBe(true);
      expect(result.models.map(m => m.id)).toEqual(['cli-visible']);
      expect(result.models[0].label).toBe('Visible in CLI');
      expect(JSON.stringify(result)).not.toContain('test-secret-should-not-reach-child');
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('LB3.4 — a readable label and the exact id, both', () => {
  it('keeps the exact identifier untouched', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'k',
      fetchImpl: stub(200, { data: [{ id: 'gpt-4.1-2025-04-14' }] }),
    });
    // The label is for reading; the id is what gets stored and sent.
    expect(result.models[0].id).toBe('gpt-4.1-2025-04-14');
    expect(result.models[0].label).not.toBe(result.models[0].id);
  });

  it('derives a name rather than looking one up in a table', () => {
    // A table would have an entry for every model that existed when it was
    // written and nothing for the one released last week.
    expect(humanizeModelId('gpt-4.1-mini')).toBe('GPT 4.1 Mini');
    expect(humanizeModelId('claude-opus-4-1')).toBe('Claude Opus 4 1');
    expect(humanizeModelId('grok-4-fast-reasoning')).toBe('Grok 4 fast reasoning');
    expect(humanizeModelId('some-model-nobody-has-seen')).toBe('some model nobody has seen');
  });

  it('marks one suggestion without hiding the rest', async () => {
    const result = await discoverModels({
      ...base, provider: 'anthropic', apiKey: 'k',
      fetchImpl: stub(200, { data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-4-1' }] }),
    });
    expect(result.models.filter((m) => m.recommended)).toHaveLength(1);
    expect(result.models.find((m) => m.recommended)?.id).toBe('claude-opus-4-1');
    expect(result.models).toHaveLength(2);
  });

  it('flags non-chat models instead of dropping them', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'k',
      fetchImpl: stub(200, {
        data: [
          { id: 'gpt-4.1' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' },
          { id: 'dall-e-3' }, { id: 'tts-1' },
        ],
      }),
    });
    // Present, so an advanced view can show everything and nothing is lost —
    // but not offered as the model Josi thinks with.
    expect(result.models).toHaveLength(5);
    expect(result.models.filter((m) => !m.likelyNonChat).map((m) => m.id)).toEqual(['gpt-4.1']);
  });
});

describe('LB3.7 — failures are categorized and actionable', () => {
  const cases: Array<[number, string | undefined, string]> = [
    [401, 'invalid_api_key', 'authentication'],
    [403, undefined, 'authorization'],
    [404, undefined, 'model_unavailable'],
    [429, undefined, 'rate_limit'],
    [429, 'insufficient_quota', 'billing'],     // the one a status alone gets wrong
    [402, undefined, 'billing'],
    [400, undefined, 'malformed_request'],
    [500, undefined, 'provider_outage'],
    [503, undefined, 'provider_outage'],
  ];

  for (const [status, code, expected] of cases) {
    it(`calls ${status}${code ? ` / ${code}` : ''} ${expected}`, async () => {
      const result = await discoverModels({
        ...base, provider: 'openai', apiKey: 'k',
        fetchImpl: stub(status, code ? { error: { code } } : {}),
      });
      expect(result.ok).toBe(false);
      expect(result.category).toBe(expected);
      expect(result.message).toBe(explainCategory(expected as never));
    });
  }

  it('distinguishes a rate limit from a spent account, which both arrive as 429', () => {
    expect(categorizeFailure(429)).toBe('rate_limit');
    expect(categorizeFailure(429, 'insufficient_quota')).toBe('billing');
  });

  it('reports an unreachable provider as a network failure', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'k',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result.category).toBe('network');
  });

  it('gives every category advice that names what to do', () => {
    for (const category of [
      'authentication', 'authorization', 'model_unavailable', 'rate_limit',
      'billing', 'network', 'malformed_request', 'provider_outage',
    ] as const) {
      const text = explainCategory(category);
      expect(text.length, category).toBeGreaterThan(40);
      expect(text, category).toMatch(/[.]$/);
    }
  });

  it('marks a credential problem as needing reconfiguration, and a quota as not retryable', () => {
    const auth = discoveryError({ ok: false, models: [], category: 'authentication' });
    expect(auth.needsReconfiguration).toBe(true);
    expect(auth.retryable).toBe(false);

    const quota = discoveryError({ ok: false, models: [], category: 'billing' });
    // Retrying a spent account fails identically, and failing over to a second
    // provider on the same bill is worse than failing.
    expect(quota.retryable).toBe(false);

    const outage = discoveryError({ ok: false, models: [], category: 'provider_outage' });
    expect(outage.retryable).toBe(true);
  });
});

describe('LB3.7 — safe provider detail, and nothing else', () => {
  it('carries the provider’s short code through', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'k',
      fetchImpl: stub(429, { error: { code: 'insufficient_quota' } }),
    });
    expect(result.providerCode).toBe('insufficient_quota');
  });

  it('never carries the provider’s prose, which quotes the request back', () => {
    // This is the leak the whole rule exists for: OpenAI's message field
    // routinely contains the offending input, and the offending input is the
    // prompt.
    const body = JSON.stringify({
      error: {
        message: "Invalid prompt: 'Draft a reply to alice@example.com about her salary'",
        type: 'invalid_request_error',
      },
    });
    const code = safeErrorCode(body);
    expect(code).toBe('invalid_request_error');
    expect(code).not.toContain('alice@example.com');
    expect(code).not.toContain('salary');
  });

  it('refuses a code field that contains prose rather than an identifier', () => {
    expect(safeErrorCode(JSON.stringify({ error: { code: 'a whole sentence about the request' } })))
      .toBeUndefined();
    expect(safeErrorCode(JSON.stringify({ error: { code: 'x'.repeat(200) } }))).toBeUndefined();
    expect(safeErrorCode('not json at all')).toBeUndefined();
    expect(safeErrorCode(JSON.stringify({ error: {} }))).toBeUndefined();
  });

  it('puts no credential in any discovery result', async () => {
    const result = await discoverModels({
      ...base, provider: 'openai', apiKey: 'sk-super-secret-value',
      fetchImpl: stub(401, { error: { code: 'invalid_api_key' } }),
    });
    expect(JSON.stringify(result)).not.toContain('sk-super-secret-value');
  });
});
