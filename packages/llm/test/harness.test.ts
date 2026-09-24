// The subscription tool harness: what travels where, and what is reported.
//
// The style of subscription.test.ts applies: no test here executes a real
// binary. The runner is faked, and the "MCP server" is the fake runner writing
// the calls file — which is exactly the seam the provider trusts in production.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openHarnessSession, readExecutedCalls, writeClaudeMcpConfig,
} from '../src/harness.js';
import { probeProvider } from '../src/probe.js';
import { claudeArgs, claudeCliProvider } from '../src/providers/claudeCli.js';
import { codexArgs, codexCliProvider, type SpawnRunner } from '../src/providers/codexCli.js';
import type { ChatRequest, ChatResponse, LlmProvider, ToolDefinition } from '../src/types.js';

const A_TOOL: ToolDefinition = {
  name: 'create_task',
  description: 'x',
  parameters: { type: 'object', properties: {} },
};

function session(tools: ToolDefinition[] = [A_TOOL]) {
  return openHarnessSession({
    serverPath: '/app/packages/agent/dist/mcp/server.js',
    tools,
    toolContext: { userId: 'u1', sessionKey: 's1', threadId: 't1', durableTurnId:'turn-1', durableLeaseToken:'lease-1' },
    env: { DATABASE_URL: 'postgresql://josi@db:5432/josi', PGPASSWORD_FILE: '/run/secrets/pw' },
  });
}

describe('the harness context file', () => {
  it('is private, and says who is asking and what was offered', () => {
    const s = session();
    try {
      // 0600: /tmp is shared and the file names a person.
      expect(statSync(s.contextPath).mode & 0o777).toBe(0o600);
      const ctx = JSON.parse(readFileSync(s.contextPath, 'utf8'));
      expect(ctx.userId).toBe('u1');
      expect(ctx.sessionKey).toBe('s1');
      expect(ctx.threadId).toBe('t1');
      expect(ctx.durableTurnId).toBe('turn-1');
      expect(ctx.durableLeaseToken).toBe('lease-1');
      expect(ctx.tools).toEqual(['create_task']);
      expect(ctx.databaseUrl).toBe('postgresql://josi@db:5432/josi');
      expect(ctx.callsPath).toBe(s.callsPath);
      expect(ctx.workspaceEnabled).toBe(false);
      expect(ctx.workspaceMode).toBe('ro');
      expect(statSync(s.callsPath).mode & 0o777).toBe(0o600);
    } finally {
      s.cleanup();
    }
  });

  it('captures workspace state only from the trusted server environment', () => {
    const s = openHarnessSession({
      serverPath: '/app/packages/agent/dist/mcp/server.js', tools: [A_TOOL],
      toolContext: { userId: 'u1', workspaceEnabled: false } as never,
      env: { JOSI_WORKSPACE_ENABLED: '1', JOSI_WORKSPACE_MODE: 'rw' },
    });
    try {
      const ctx = JSON.parse(readFileSync(s.contextPath, 'utf8'));
      expect(ctx.workspaceEnabled).toBe(true);
      expect(ctx.workspaceMode).toBe('rw');
    } finally { s.cleanup(); }
  });

  it('cleanup removes everything, including the calls file', () => {
    const s = session();
    writeFileSync(s.callsPath, '{}\n');
    s.cleanup();
    expect(() => statSync(s.contextPath)).toThrow();
    expect(() => statSync(s.callsPath)).toThrow();
  });
});

describe('reading back what the server recorded', () => {
  it('parses the calls file and survives a torn last line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-calls-'));
    const path = join(dir, 'calls.jsonl');
    writeFileSync(path, `${JSON.stringify({ id: '1', name: 'create_task', input: { a: 1 }, result: { ok:true,state:'ready' } })}\n{"tor`);
    const calls = readExecutedCalls(path);
    expect(calls).toEqual([{ id: '1', name: 'create_task', input: { a: 1 }, result:{ok:true,state:'ready'} }]);
  });

  it('a missing file means no tool ran, not an error', () => {
    expect(readExecutedCalls('/nonexistent/calls.jsonl')).toEqual([]);
  });
});

describe('the codex command line with a harness', () => {
  it('adds the MCP server as config overrides and keeps the sandbox read-only', () => {
    const s = session();
    try {
      const args = codexArgs('m', s);
      const joined = args.join(' ');
      expect(joined).toContain('--sandbox read-only');
      expect(joined).toContain(`mcp_servers.josi.args=[${JSON.stringify(s.serverPath)}]`);
      expect(joined).toContain(`JOSI_MCP_CONTEXT = ${JSON.stringify(s.contextPath)}`);
      // Required at the pinned 0.152.0: exec runs with approval policy `never`
      // and would otherwise fail every MCP call with "requires approval". Safe
      // because Josi's own step-up gate lives inside the server.
      expect(joined).toContain('mcp_servers.josi.default_tools_approval_mode="approve"');
    } finally {
      s.cleanup();
    }
  });

  it('without a harness the command line is unchanged', () => {
    expect(codexArgs('m')).toEqual(codexArgs('m', null));
    expect(codexArgs('m').join(' ')).not.toContain('mcp_servers');
  });
});

describe('the claude command line with a harness', () => {
  it('loads only the Josi server, allows only its tools, and still denies the built-ins', () => {
    const s = session();
    try {
      const configPath = writeClaudeMcpConfig(s);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.mcpServers.josi.args).toEqual([s.serverPath]);
      expect(config.mcpServers.josi.env.JOSI_MCP_CONTEXT).toBe(s.contextPath);

      const args = claudeArgs('m', configPath);
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--strict-mcp-config');
      expect(args).toContain('mcp__josi');
      expect(args).toContain('Bash'); // still denied by name
    } finally {
      s.cleanup();
    }
  });

  it('without a harness the command line is unchanged', () => {
    expect(claudeArgs('m')).toEqual(claudeArgs('m', null));
    expect(claudeArgs('m').join(' ')).not.toContain('mcp');
  });
});

/** A runner that plays both the CLI and the MCP server: it answers as the CLI
 * would and writes the calls file as the server would. */
/** Pulls the quoted context path out of the TOML env override. */
function contextPathFrom(override: string): string {
  return override.slice(override.indexOf('"'), override.lastIndexOf('"') + 1);
}

function harnessRunner(reply: string): { runner: SpawnRunner; seen: { args: string[] } } {
  const seen = { args: [] as string[] };
  const runner: SpawnRunner = async ({ args }) => {
    seen.args = args;
    // Find the context path from the codex overrides and record a call, the
    // way the real server does when the model uses a tool.
    const override = args.find((a) => a.includes('JOSI_MCP_CONTEXT'));
    if (override) {
      const contextPath = JSON.parse(contextPathFrom(override));
      const ctx = JSON.parse(readFileSync(contextPath, 'utf8'));
      writeFileSync(ctx.callsPath, `${JSON.stringify({ id: 'c1', name: 'record_number', input: { value: 7 }, result:{ok:true,recorded:7} })}\n`);
    }
    return { code: 0, stdout: reply, timedOut: false, stderr: '' };
  };
  return { runner, seen };
}

describe('the codex provider with tools', () => {
  const AGENT_REPLY = `${JSON.stringify({ type: 'agent_message', message: 'done' })}\n`;

  it('reports executed calls as fact, never as pending work', async () => {
    const { runner } = harnessRunner(AGENT_REPLY);
    const provider = codexCliProvider({ model: 'm', runner, mcpServerPath: '/srv/server.js' });
    const res = await provider.chat({
      messages: [{ role: 'user', content: 'record 7' }],
      tools: [A_TOOL],
      toolContext: { userId: 'u1', sessionKey: 's1', threadId: 't1' },
    });
    expect(res.text).toBe('done');
    // Nothing pending: the CLI's own loop already ran the tool.
    expect(res.toolCalls).toEqual([]);
    expect(res.executedToolCalls).toEqual([{ id: 'c1', name: 'record_number', input: { value: 7 }, result:{ok:true,recorded:7} }]);
  });

  it('cleans up the context file even when the run succeeds', async () => {
    const { runner, seen } = harnessRunner(AGENT_REPLY);
    const provider = codexCliProvider({ model: 'm', runner, mcpServerPath: '/srv/server.js' });
    await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [A_TOOL] });
    const override = seen.args.find((a) => a.includes('JOSI_MCP_CONTEXT'))!;
    const contextPath = JSON.parse(contextPathFrom(override));
    expect(() => statSync(contextPath)).toThrow();
  });

  it('still refuses tools when the server is not available', async () => {
    const { runner } = harnessRunner(AGENT_REPLY);
    const provider = codexCliProvider({ model: 'm', runner, mcpServerPath: null });
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [A_TOOL] }),
    ).rejects.toThrow(/cannot call tools/);
  });
});

describe('provider-specific harness configuration', () => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };

  it('carries the same trusted workspace state through Codex TOML and Claude JSON paths', async () => {
    const oldEnabled = process.env.JOSI_WORKSPACE_ENABLED;
    const oldMode = process.env.JOSI_WORKSPACE_MODE;
    process.env.JOSI_WORKSPACE_ENABLED = '1'; process.env.JOSI_WORKSPACE_MODE = 'rw';
    try {
      let codexContext: Record<string, unknown> | undefined;
      const codexRunner: SpawnRunner = async ({ args }) => {
        const override = args.find((value) => value.includes('JOSI_MCP_CONTEXT'))!;
        codexContext = JSON.parse(readFileSync(JSON.parse(contextPathFrom(override)), 'utf8'));
        return { code: 0, timedOut: false, stderr: '', stdout: `${JSON.stringify({ type: 'agent_message', message: 'done' })}\n` };
      };
      await codexCliProvider({ model: 'm', runner: codexRunner, mcpServerPath: '/srv/server.js' }).chat({
        messages: [{ role: 'user', content: 'inspect workspace' }], tools: [A_TOOL],
      });

      let claudeContext: Record<string, unknown> | undefined;
      const claudeRunner: SpawnRunner = async ({ args }) => {
        const configPath = args[args.indexOf('--mcp-config') + 1]!;
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        claudeContext = JSON.parse(readFileSync(config.mcpServers.josi.env.JOSI_MCP_CONTEXT, 'utf8'));
        return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ result: 'done', is_error: false, usage: {} }) };
      };
      await claudeCliProvider({ model: 'm', runner: claudeRunner, mcpServerPath: '/srv/server.js' }).chat({
        messages: [{ role: 'user', content: 'inspect workspace' }], tools: [A_TOOL],
      });

      expect(codexContext).toMatchObject({ workspaceEnabled: true, workspaceMode: 'rw' });
      expect(claudeContext).toMatchObject({ workspaceEnabled: true, workspaceMode: 'rw' });
    } finally {
      restore('JOSI_WORKSPACE_ENABLED', oldEnabled); restore('JOSI_WORKSPACE_MODE', oldMode);
    }
  });
});

describe('the capability probe over the harness', () => {
  it('marks toolCalling true only when the probe call demonstrably ran', async () => {
    // A provider that answers everything and reports the probe tool as an
    // executed call — the shape a real harness run produces.
    const provider: LlmProvider = {
      kind: 'openai_subscription', model: 'm', external: true,
      async chat(request: ChatRequest): Promise<ChatResponse> {
        return {
          text: 'ok',
          toolCalls: [],
          ...(request.tools?.length
            ? { executedToolCalls: [{ id: '1', name: 'record_number', input: { value: 7 }, result:{ok:true,recorded:7} }] }
            : {}),
          usage: { inputTokens: 0, outputTokens: 0 },
          latencyMs: 1,
        };
      },
    };
    const result = await probeProvider(provider);
    expect(result.capabilities.toolCalling).toBe(true);
  });

  it('and false when no call came back in any form', async () => {
    const provider: LlmProvider = {
      kind: 'openai_subscription', model: 'm', external: true,
      async chat(): Promise<ChatResponse> {
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 1 };
      },
    };
    const result = await probeProvider(provider);
    expect(result.capabilities.toolCalling).toBe(false);
  });
});
