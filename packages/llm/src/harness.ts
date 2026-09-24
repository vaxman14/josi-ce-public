// The out-of-process tool harness for subscription (CLI) providers.
//
// THE PROBLEM THIS SOLVES
//
// A subscription provider does not speak a chat API: it runs the vendor's own
// CLI as a subprocess, and until now that subprocess was a dumb pipe — text in,
// text out, no tools. The capability probe therefore found `toolCalling: false`
// and Phase 4's gates honestly disabled everything that acts.
//
// But both vendor CLIs are agents, and both speak MCP. So instead of teaching
// the CLI our tool dialect — it has none — we expose Josi's OWN tools to the
// CLI over an MCP stdio server (`packages/agent/src/mcp/server.js` in the
// built image) and let the vendor's agent loop drive them. The tools still
// execute inside Josi's code, against Josi's database, behind Josi's step-up
// policy. The CLI is only the model transport, exactly as before.
//
// WHAT TRAVELS WHERE, because that is the whole security story:
//
//   * The CONTEXT FILE (0600, in a private temp dir) carries who is asking and
//     how to reach the database. It is read by OUR server process, never by
//     the vendor CLI — the CLI only learns the file's PATH, via the MCP server
//     environment it is asked to set. `childEnvironment` still strips
//     DATABASE_URL and PGPASSWORD_FILE from the CLI itself, so the vendor
//     binary continues to hold no secret of ours.
//   * The CALLS FILE is written by our server as ground truth of which tools
//     actually ran. The provider reads it back after the subprocess exits and
//     reports the calls as `executedToolCalls` — observed fact, not a parse of
//     the CLI's ever-shifting event schema.
//
// WHY THE CALLS ARE REPORTED AT ALL. The agent loop and the capability probe
// both need to know that tools genuinely ran. The probe in particular must not
// mark `toolCalling: true` unless a call it asked for demonstrably reached our
// server — the calls file is that demonstration.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutedToolCall, ToolContext, ToolDefinition } from './types.js';

/** Where the built image puts the MCP server entry. A source checkout or a
 * test overrides this with `JOSI_MCP_SERVER`; when neither exists the harness
 * is simply unavailable and the providers refuse tools exactly as they always
 * have — the capability stays honestly false rather than half-working. */
export const DEFAULT_MCP_SERVER_PATH = '/app/packages/agent/dist/mcp/server.js';

/** The environment variable the MCP server reads its context path from. */
export const MCP_CONTEXT_ENV = 'JOSI_MCP_CONTEXT';

/** The one server name both CLIs are configured with. Claude namespaces tools
 * as `mcp__<server>__<tool>`, so this string is part of the allow-list too. */
export const MCP_SERVER_NAME = 'josi';

export function resolveMcpServerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.JOSI_MCP_SERVER?.trim();
  if (configured) return existsSync(configured) ? configured : null;
  return existsSync(DEFAULT_MCP_SERVER_PATH) ? DEFAULT_MCP_SERVER_PATH : null;
}

/** What the context file contains. Written here, read by the MCP server, and
 * typed in one place so the two cannot drift apart silently. */
export interface HarnessContext {
  databaseUrl: string | null;
  passwordFile: string | null;
  /** Path to the installation master key FILE — never the key itself. The
   * server loads it only when a connected-data tool actually runs; without it
   * those tools refuse honestly and everything else works unchanged. */
  masterKeyPath: string | null;
  userId: string | null;
  sessionKey: string | null;
  threadId: string | null;
  durableTurnId: string | null;
  durableLeaseToken: string | null;
  latestUserText: string | null;
  effectiveNow: string | null;
  /** Non-secret installation state captured from Josi's server environment.
   * The vendor cannot supply these through the chat request. The dedicated
   * MCP child restores them so the shared workspace grant fails closed exactly
   * as it does in the parent API process. */
  workspaceEnabled: boolean;
  workspaceMode: 'ro' | 'rw';
  /** Names the caller offered THIS turn. The server exposes only these (plus
   * its own probe tools), so a turn that offered nothing user-scoped cannot be
   * talked into task work by the model. */
  tools: string[];
  callsPath: string;
}

export interface HarnessSession {
  serverPath: string;
  contextPath: string;
  callsPath: string;
  /** Removes the temp dir. Always called in a `finally`; a leftover context
   * file is a leftover statement of who was asking. */
  cleanup: () => void;
}

export function openHarnessSession(args: {
  serverPath: string;
  tools: ToolDefinition[];
  toolContext?: ToolContext;
  env?: NodeJS.ProcessEnv;
}): HarnessSession {
  const env = args.env ?? process.env;
  // mkdtemp gives the directory 0700, and the context file gets 0600 on top:
  // /tmp is shared, and the file names a person.
  const dir = mkdtempSync(join(tmpdir(), 'josi-mcp-'));
  const contextPath = join(dir, 'context.json');
  const callsPath = join(dir, 'calls.jsonl');
  const workspaceEnabled = env.JOSI_WORKSPACE_ENABLED === '1';
  const context: HarnessContext = {
    // Captured from OUR environment before `childEnvironment` strips them from
    // the CLI's. The server is our process and may hold our connection string;
    // the vendor binary is not and may not.
    databaseUrl: env.DATABASE_URL ?? null,
    passwordFile: env.PGPASSWORD_FILE ?? null,
    masterKeyPath: env.MASTER_KEY_FILE ?? null,
    userId: args.toolContext?.userId ?? null,
    sessionKey: args.toolContext?.sessionKey ?? null,
    threadId: args.toolContext?.threadId ?? null,
    durableTurnId: args.toolContext?.durableTurnId ?? null,
    durableLeaseToken: args.toolContext?.durableLeaseToken ?? null,
    latestUserText: args.toolContext?.latestUserText ?? null,
    effectiveNow: args.toolContext?.effectiveNow ?? null,
    workspaceEnabled,
    workspaceMode: workspaceEnabled && env.JOSI_WORKSPACE_MODE === 'rw' ? 'rw' : 'ro',
    tools: args.tools.map((t) => t.name),
    callsPath,
  };
  writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
  // Create this explicitly rather than relying on appendFile's umask. The
  // completed results may contain private connected data used by grounding.
  writeFileSync(callsPath, '', { mode: 0o600 });
  return {
    serverPath: args.serverPath,
    contextPath,
    callsPath,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
    },
  };
}

/** Reads back what the server recorded. Missing file means no tool ran, which
 * is a normal outcome, not an error. */
export function readExecutedCalls(callsPath: string): ExecutedToolCall[] {
  let raw: string;
  try {
    raw = readFileSync(callsPath, 'utf8');
  } catch {
    return [];
  }
  const calls: ExecutedToolCall[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { id?: unknown; name?: unknown; input?: unknown; result?: unknown };
      if (typeof entry.name !== 'string' || !Object.hasOwn(entry, 'result')) continue;
      calls.push({
        id: typeof entry.id === 'string' ? entry.id : `call-${calls.length}`,
        name: entry.name,
        input: (entry.input && typeof entry.input === 'object' ? entry.input : {}) as Record<string, unknown>,
        result: entry.result,
      });
    } catch {
      // A torn last line from a killed server. The completed lines still count.
    }
  }
  return calls;
}

/** The Claude CLI takes its MCP configuration as a JSON file rather than
 * config overrides; written into the same private temp dir. */
export function writeClaudeMcpConfig(session: HarnessSession): string {
  const path = join(session.contextPath, '..', 'mcp.json');
  writeFileSync(path, JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: 'stdio',
        // The exact node running this process, not `node` from PATH — the CLI
        // spawns the server itself and its PATH is not a promise we rely on.
        command: process.execPath,
        args: [session.serverPath],
        env: { [MCP_CONTEXT_ENV]: session.contextPath },
      },
    },
  }), { mode: 0o600 });
  return path;
}
