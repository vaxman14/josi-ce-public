// The MCP core: the protocol a vendor CLI speaks to reach Josi's tools.
//
// Pure-protocol tests. Nothing here spawns a process or opens a database —
// `buildCore` takes a connect function, and these tests hand it one that must
// not be called except where a user-scoped tool genuinely needs it.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '@josi-ce/core';
import { buildCore } from '../src/mcp/server.js';
import { handleMcpMessage, type McpCore } from '../src/mcp/protocol.js';

function ctxFor(tools: string[], userId: string | null = 'u1') {
  const dir = mkdtempSync(join(tmpdir(), 'josi-mcp-test-'));
  return {
    databaseUrl: null, passwordFile: null,
    userId, sessionKey: 's1', threadId: 't1',
    tools,
    callsPath: join(dir, 'calls.jsonl'),
  };
}

const NO_DB = async (): Promise<Db> => {
  throw new Error('this test must not reach the database');
};

describe('the protocol', () => {
  const echoCore: McpCore = {
    tools: [{ name: 'echo', description: 'x', inputSchema: { type: 'object' } }],
    execute: async (_name, input) => ({ text: JSON.stringify(input) }),
  };

  it('initialize echoes the client version and offers only tools', async () => {
    const reply = await handleMcpMessage(echoCore, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
    }) as { result: { protocolVersion: string; capabilities: object } };
    expect(reply.result.protocolVersion).toBe('2025-03-26');
    expect(reply.result.capabilities).toEqual({ tools: {} });
  });

  it('notifications are answered with silence', async () => {
    expect(await handleMcpMessage(echoCore, { jsonrpc: '2.0', method: 'notifications/initialized' }))
      .toBeNull();
  });

  it('a tool that was never offered is a protocol error, not a text reply', async () => {
    const reply = await handleMcpMessage(echoCore, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_everything', arguments: {} },
    }) as { error: { code: number } };
    expect(reply.error.code).toBe(-32602);
  });

  it('a throwing tool becomes an isError result with the tool message only', async () => {
    const core: McpCore = {
      tools: [{ name: 'boom', description: 'x', inputSchema: {} }],
      execute: async () => { throw new Error('the calendar is not connected'); },
    };
    const reply = await handleMcpMessage(core, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boom', arguments: {} },
    }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('the calendar is not connected');
  });
});

describe('the Josi core', () => {
  it('lists only the tools this turn offered, plus the probe tools', async () => {
    const core = buildCore(ctxFor(['create_task']), NO_DB);
    const names = core.tools.map((t) => t.name);
    expect(names).toContain('create_task');
    expect(names).toContain('record_number');
    expect(names).toContain('josi_health');
    // Offered names only — cancel_task exists in the catalogue but was not
    // offered, so it is not listed and cannot be called.
    expect(names).not.toContain('cancel_task');
  });

  it('records every completed call with its real outcome', async () => {
    const ctx = ctxFor([]);
    const core = buildCore(ctx, NO_DB);
    await core.execute('josi_health', { message: 'ping' }, 'id-1');
    const line = JSON.parse(readFileSync(ctx.callsPath, 'utf8').trim());
    expect(line).toEqual({ id: 'id-1', name: 'josi_health', input: { message: 'ping' }, result:{ok:true,echo:'ping'} });
  });

  it('probe tools answer without a database or a user', async () => {
    const core = buildCore(ctxFor([], null), NO_DB);
    const health = await core.execute('josi_health', { message: 'ping' }, '1');
    expect(JSON.parse(health.text)).toEqual({ ok: true, echo: 'ping' });
    const probe = await core.execute('record_number', { value: 7 }, '2');
    expect(JSON.parse(probe.text)).toEqual({ ok: true, recorded: 7 });
  });

  it('a user-scoped tool with no user is refused in words the model can relay', async () => {
    const core = buildCore(ctxFor(['create_task'], null), NO_DB);
    const out = await core.execute('create_task', { template_key: 'x' }, '1');
    const parsed = JSON.parse(out.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('no_user');
  });
});
