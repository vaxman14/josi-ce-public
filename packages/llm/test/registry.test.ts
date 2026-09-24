// Local-only mode, spending caps, fallback rules and cost labelling.
//
// These run against a real migrated database because every one of them is a
// claim about stored state, not about a function's return value.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, seal } from '@josi-ce/core';
import { chat, buildProvider, capabilitiesOf, isLocalOnly, loadStoredProvider, LocalOnlyViolation } from '../src/registry.js';
import { checkCaps, priceCall, recordUsage, usageSummary } from '../src/metering.js';
import { LlmError } from '../src/types.js';

let db: TestDb;
const key = new MasterKey(Buffer.alloc(32, 5));
const resolve = async () => ['1.1.1.1'];
const localResolve = async () => ['127.0.0.1'];

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okReply = () => reply({
  choices: [{ message: { content: 'hi' } }],
  usage: { prompt_tokens: 100, completion_tokens: 50 },
});

async function insertProvider(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    role: 'primary', provider: 'openai', model: 'gpt-test', base_url: null,
    api_key_enc: seal(key, { apiKey: 'test-key' }),
    external_acknowledged: true, activated_at: new Date().toISOString(),
    probed_at: new Date().toISOString(), cap_chat: true,
    cap_structured_output: true, cap_tool_calling: true, cap_vision: false, cap_context_tokens: 8000,
    ...over,
  };
  await db.query(
    `insert into llm_providers
       (role, provider, model, base_url, api_key_enc, external_acknowledged, activated_at,
        probed_at, cap_chat, cap_structured_output, cap_tool_calling, cap_vision, cap_context_tokens)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (role) do update set
       provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
       api_key_enc = excluded.api_key_enc, external_acknowledged = excluded.external_acknowledged,
       activated_at = excluded.activated_at, probed_at = excluded.probed_at,
       cap_chat = excluded.cap_chat`,
    [row.role, row.provider, row.model, row.base_url, row.api_key_enc, row.external_acknowledged,
     row.activated_at, row.probed_at, row.cap_chat, row.cap_structured_output,
     row.cap_tool_calling, row.cap_vision, row.cap_context_tokens],
  );
}

beforeEach(async () => { db = await testDb(); });

describe('Local-only mode', () => {
  it('is off by default', async () => {
    expect(await isLocalOnly(db)).toBe(false);
  });

  it('refuses to build an external provider when on', async () => {
    await db.query(`update security_policy set local_only = true where id = true`);
    await insertProvider({ provider: 'openai' });
    const stored = (await loadStoredProvider(db, 'primary'))!;
    await expect(buildProvider({ db, masterKey: key, resolve }, stored)).rejects.toThrow(LocalOnlyViolation);
  });

  it('refuses at the layer that builds the client, not merely at a route', async () => {
    // A feature added later that forgets to check still gets refused.
    await db.query(`update security_policy set local_only = true where id = true`);
    await insertProvider({ provider: 'anthropic' });
    await expect(
      chat({ db, masterKey: key, resolve, fetchImpl: (async () => okReply()) as unknown as typeof fetch },
        { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/Local-only/);
  });

  it('still allows a self-hosted endpoint when on', async () => {
    await db.query(`update security_policy set local_only = true where id = true`);
    await insertProvider({
      provider: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1',
      api_key_enc: null, external_acknowledged: false,
    });
    const outcome = await chat(
      { db, masterKey: key, resolve: localResolve, fetchImpl: (async () => okReply()) as unknown as typeof fetch },
      { messages: [{ role: 'user', content: 'x' }] },
    );
    expect(outcome.response.text).toBe('hi');
  });

  it('blocks an external FALLBACK too, not just the primary', async () => {
    await db.query(`update security_policy set local_only = true where id = true`);
    await insertProvider({
      provider: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1',
      api_key_enc: null, external_acknowledged: false,
    });
    await insertProvider({ role: 'fallback', provider: 'openai' });
    // Primary fails retryably; the fallback is external and must be refused
    // rather than quietly becoming the escape hatch out of Local-only.
    await expect(
      chat({
        db, masterKey: key, resolve: localResolve,
        fetchImpl: (async () => reply({}, 503)) as unknown as typeof fetch,
      }, { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
    const used = await db.query(`select role from llm_usage`);
    expect(used).toHaveLength(0);
  });
});

describe('the acknowledgment survives outside the wizard', () => {
  it('refuses an external provider whose acknowledgment was removed directly in the database', async () => {
    // The check constraint blocks the normal path, so force it the way a
    // careless migration or a manual UPDATE would.
    await db.query(`alter table llm_providers drop constraint llm_external_requires_ack`);
    await insertProvider({ provider: 'openai', external_acknowledged: false });
    const stored = (await loadStoredProvider(db, 'primary'))!;
    await expect(buildProvider({ db, masterKey: key, resolve }, stored)).rejects.toThrow(/acknowledged/);
  });
});

describe('fallback', () => {
  it('is not used when none is configured', async () => {
    await insertProvider();
    await expect(
      chat({ db, masterKey: key, resolve, fetchImpl: (async () => reply({}, 503)) as unknown as typeof fetch },
        { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
  });

  it('is used when enabled and the primary failed retryably', async () => {
    await insertProvider();
    await insertProvider({ role: 'fallback', provider: 'anthropic', model: 'claude-test' });
    let call = 0;
    const outcome = await chat({
      db, masterKey: key, resolve,
      fetchImpl: (async () => {
        call++;
        return call === 1 ? reply({}, 503) : reply({ content: [{ type: 'text', text: 'from fallback' }], usage: { input_tokens: 2, output_tokens: 1 } });
      }) as unknown as typeof fetch,
    }, { messages: [{ role: 'user', content: 'x' }] });
    expect(outcome.usedRole).toBe('fallback');
    expect(outcome.response.text).toBe('from fallback');
  });

  it('is NOT used for a bad API key', async () => {
    // A fallback that fires on 401 moves a workspace onto a second provider,
    // and a second bill, because someone mistyped a character.
    await insertProvider();
    await insertProvider({ role: 'fallback', provider: 'anthropic', model: 'claude-test' });
    let calls = 0;
    await expect(
      chat({
        db, masterKey: key, resolve,
        fetchImpl: (async () => { calls++; return reply({}, 401); }) as unknown as typeof fetch,
      }, { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toMatchObject({ needsReconfiguration: true });
    expect(calls).toBe(1);
  });

  it('is not used when it has never been probed', async () => {
    await insertProvider();
    await insertProvider({ role: 'fallback', provider: 'anthropic', activated_at: null, probed_at: null, cap_chat: null });
    await expect(
      chat({ db, masterKey: key, resolve, fetchImpl: (async () => reply({}, 503)) as unknown as typeof fetch },
        { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
  });
});

describe('an unprobed primary is never used', () => {
  it('refuses rather than trying the model', async () => {
    await insertProvider({ activated_at: null, probed_at: null, cap_chat: null });
    let calls = 0;
    await expect(
      chat({ db, masterKey: key, resolve, fetchImpl: (async () => { calls++; return okReply(); }) as unknown as typeof fetch },
        { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/not been tested/);
    expect(calls).toBe(0);
  });

  it('cannot be marked active without a passing probe, at the database level', async () => {
    await expect(
      db.query(
        `insert into llm_providers (role, provider, model, external_acknowledged, activated_at)
         values ('primary', 'openai', 'm', true, now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('cost labelling', () => {
  it('reports a self-hosted call as $0 provider charge, excluding hardware', async () => {
    const cost = await priceCall(db, {
      provider: 'openai_compatible', model: 'llama',
      usage: { inputTokens: 1000, outputTokens: 500 }, external: false,
    });
    expect(cost).toMatchObject({ costUsd: 0, source: 'none' });
    expect(cost.note).toMatch(/hardware and electricity are not counted/i);
  });

  it('labels a computed figure as an estimate', async () => {
    await db.query(
      `insert into llm_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok)
       values ('openai', 'gpt-test', 1.00, 2.00)`,
    );
    const cost = await priceCall(db, {
      provider: 'openai', model: 'gpt-test',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, external: true,
    });
    expect(cost.source).toBe('estimated');
    expect(cost.costUsd).toBeCloseTo(3.0, 5);
    expect(cost.note).toMatch(/may be out of date/i);
  });

  it('prefers a provider-reported figure over an estimate', async () => {
    await db.query(
      `insert into llm_prices (provider, model, input_usd_per_mtok, output_usd_per_mtok) values ('openai','gpt-test',1,2)`,
    );
    const cost = await priceCall(db, {
      provider: 'openai', model: 'gpt-test', usage: { inputTokens: 1_000_000, outputTokens: 0 },
      reportedCostUsd: 0.42, external: true,
    });
    expect(cost).toMatchObject({ source: 'reported', costUsd: 0.42 });
  });

  it('says so when no price is known rather than silently counting zero', async () => {
    const cost = await priceCall(db, {
      provider: 'openai', model: 'unpriced', usage: { inputTokens: 500, outputTokens: 500 }, external: true,
    });
    expect(cost.source).toBe('estimated');
    expect(cost.note).toMatch(/no price is known/i);
  });

  it('keeps reported and estimated apart in the summary', async () => {
    const usage = { inputTokens: 10, outputTokens: 10 };
    await recordUsage(db, { provider: 'openai', model: 'a', role: 'primary', usage,
      cost: { costUsd: 1, source: 'reported', note: '' } });
    await recordUsage(db, { provider: 'openai', model: 'b', role: 'primary', usage,
      cost: { costUsd: 2, source: 'estimated', note: '' } });
    await recordUsage(db, { provider: 'openai_compatible', model: 'c', role: 'primary', usage,
      cost: { costUsd: 0, source: 'none', note: '' } });

    const summary = await usageSummary(db);
    expect(summary.reportedCostUsd).toBe(1);
    expect(summary.estimatedCostUsd).toBe(2);
    expect(summary.selfHostedCalls).toBe(1);
    // Never a single blended number presented as a bill.
    expect(summary).not.toHaveProperty('totalCostUsd');
    expect(summary.notes.join(' ')).toMatch(/out of date/);
  });

  it('will not let a self-hosted call claim a cost, at the database level', async () => {
    await expect(
      db.query(
        `insert into llm_usage (provider, model, role, cost_usd, cost_source) values ('x','y','primary', 5, 'none')`,
      ),
    ).rejects.toThrow();
  });
});

describe('spending caps', () => {
  async function spend(costUsd: number, userId?: string): Promise<void> {
    await recordUsage(db, {
      userId, provider: 'openai', model: 'm', role: 'primary',
      usage: { inputTokens: 1000, outputTokens: 0 },
      cost: { costUsd, source: 'estimated', note: '' },
    });
  }

  it('allows everything when no cap is set', async () => {
    expect(await checkCaps(db)).toMatchObject({ allowed: true, status: 'ok', fraction: null });
  });

  it('warns at 50%, 80%, then hard-stops at 100%', async () => {
    await db.query(`update llm_caps set monthly_cost_usd = 100 where id = true`);
    expect((await checkCaps(db)).status).toBe('ok');
    await spend(50);
    expect((await checkCaps(db)).status).toBe('warn_50');
    await spend(30);
    expect((await checkCaps(db)).status).toBe('warn_80');
    await spend(20);
    const blocked = await checkCaps(db);
    expect(blocked.status).toBe('blocked');
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toMatch(/administrator/i);
  });

  it('hard-stops the actual call, not just the report', async () => {
    await db.query(`update llm_caps set monthly_cost_usd = 1 where id = true`);
    await spend(5);
    await insertProvider();
    let calls = 0;
    await expect(
      chat({ db, masterKey: key, resolve, fetchImpl: (async () => { calls++; return okReply(); }) as unknown as typeof fetch },
        { messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/budget/i);
    expect(calls).toBe(0);
  });

  it('applies a token cap as well as a cost cap', async () => {
    await db.query(`update llm_caps set monthly_tokens = 1000 where id = true`);
    await recordUsage(db, {
      provider: 'openai', model: 'm', role: 'primary',
      usage: { inputTokens: 900, outputTokens: 200 },
      cost: { costUsd: 0, source: 'estimated', note: '' },
    });
    expect((await checkCaps(db)).status).toBe('blocked');
  });

  it('stops a user at their own cap while the installation is still fine', async () => {
    const u = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ('a@b.test','a','member') returning id`,
    );
    await db.query(`update llm_caps set monthly_cost_usd = 1000 where id = true`);
    await db.query(`insert into llm_user_caps (user_id, monthly_cost_usd) values ($1, 10)`, [u[0].id]);
    await spend(10, u[0].id);

    expect((await checkCaps(db, u[0].id))).toMatchObject({ allowed: false, scope: 'user' });
    // The installation itself is nowhere near its cap.
    expect((await checkCaps(db))).toMatchObject({ allowed: true });
  });

  it('stops a user when the INSTALLATION is out, even if their own cap is fine', async () => {
    const u = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ('c@d.test','c','member') returning id`,
    );
    await db.query(`update llm_caps set monthly_cost_usd = 10 where id = true`);
    await db.query(`insert into llm_user_caps (user_id, monthly_cost_usd) values ($1, 1000)`, [u[0].id]);
    await spend(10);
    expect((await checkCaps(db, u[0].id))).toMatchObject({ allowed: false, scope: 'workspace' });
  });

  it('counts only the current calendar month', async () => {
    await db.query(`update llm_caps set monthly_cost_usd = 10 where id = true`);
    await spend(50);
    await db.query(`update llm_usage set created_at = now() - interval '2 months'`);
    expect((await checkCaps(db)).status).toBe('ok');
  });

  it('refuses a nonsensical cap at the database level', async () => {
    await expect(db.query(`update llm_caps set monthly_cost_usd = -5 where id = true`)).rejects.toThrow();
    await expect(db.query(`update llm_caps set monthly_tokens = 0 where id = true`)).rejects.toThrow();
  });
});

describe('usage recording', () => {
  it('records tokens, latency and role for a successful call', async () => {
    await insertProvider();
    await chat({ db, masterKey: key, resolve, fetchImpl: (async () => okReply()) as unknown as typeof fetch },
      { messages: [{ role: 'user', content: 'x' }] }, { purpose: 'probe' });
    const rows = await db.query<{ input_tokens: number; output_tokens: number; role: string; purpose: string }>(
      `select input_tokens, output_tokens, role, purpose from llm_usage`,
    );
    expect(rows[0]).toMatchObject({ input_tokens: 100, output_tokens: 50, role: 'primary', purpose: 'probe' });
  });

  it('never records the prompt or the reply', async () => {
    await insertProvider();
    await chat({ db, masterKey: key, resolve, fetchImpl: (async () => okReply()) as unknown as typeof fetch },
      { messages: [{ role: 'user', content: 'SECRET-BUSINESS-CONTENT' }] });
    const dump = JSON.stringify(await db.query(`select * from llm_usage`));
    expect(dump).not.toContain('SECRET-BUSINESS-CONTENT');
    expect(dump).not.toContain('hi');
  });
});

describe('capability reading', () => {
  it('returns null until a probe has run, which disables dependent features', async () => {
    await insertProvider({ probed_at: null, cap_chat: null, activated_at: null });
    expect(capabilitiesOf(await loadStoredProvider(db, 'primary'))).toBeNull();
  });

  it('treats a null capability as absent rather than assumed', async () => {
    await insertProvider({ cap_tool_calling: null });
    const caps = capabilitiesOf(await loadStoredProvider(db, 'primary'))!;
    expect(caps.toolCalling).toBe(false);
  });
});

describe('the stored API key', () => {
  it('is opened only through the master key, and never leaks into an error', async () => {
    await insertProvider();
    const stored = (await loadStoredProvider(db, 'primary'))!;
    await expect(buildProvider({ db, masterKey: null, resolve }, stored)).rejects.toThrow(/master key/);
    try {
      await buildProvider({ db, masterKey: null, resolve }, stored);
    } catch (err) {
      expect((err as LlmError).message).not.toContain('test-key');
    }
  });
});
