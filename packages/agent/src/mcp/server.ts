// The Josi MCP tool server — the executable half of the subscription harness.
//
// Spawned BY the vendor CLI (Codex or Claude Code), not by Josi: the provider
// in packages/llm configures the CLI with this file's path and a context file,
// and the CLI starts it over stdio for the length of one `chat()` call. See
// packages/llm/src/harness.ts for what travels where and why.
//
// WHAT IT ENFORCES, because a tool server that skips the rules is a bypass:
//
//   * Only the tools offered THIS turn (plus the two probe tools) are listed.
//     The tool list is the promise; an absent tool is an absent promise.
//   * Every user-scoped call goes through `checkStepUp` with the same session
//     key the in-process loop would use. A refusal is returned to the model as
//     text — the same sentence the loop would relay — never bypassed and never
//     dressed up as a crash.
//   * Execution is `executeAssistantTool`, the exact code the in-process loop
//     runs, ownership checks and all.
//   * Every completed call and its real outcome is appended to the private
//     calls file. Failures are recorded in their safe Josi error shape. That
//     file is how the capability probe and reply guards know what truly ran.
//
// The two probe tools are contextless by design. `record_number` exists so the
// standard capability probe measures the real end-to-end harness rather than a
// special case; `josi_health` is the smoke-test handle. Neither touches the
// database, so a context with no user can still prove the plumbing.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { checkStepUp, connectFromEnv, loadMasterKey } from '@josi-ce/core';
import type { Db, MasterKey } from '@josi-ce/core';
import type { HarnessContext } from '@josi-ce/llm';
import { executeAssistantTool } from '../execute.js';
import { isMutatingTool, runDurableEffect } from '../durableEffects.js';
import { ALL_TOOLS } from '../tools.js';
import { handleMcpMessage, type McpCore, type McpToolDescriptor, type McpToolOutcome } from './protocol.js';

type McpHarnessContext = Omit<HarnessContext, 'workspaceEnabled' | 'workspaceMode'>
  & Partial<Pick<HarnessContext, 'workspaceEnabled' | 'workspaceMode'>>;

const PROBE_TOOLS: McpToolDescriptor[] = [
  {
    // Mirrors PROBE_TOOL in packages/llm/src/probe.ts by name and shape, so
    // the one capability probe works unchanged across HTTP and CLI providers.
    name: 'record_number',
    description: 'Record a single number. Call this with the number 7.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'number', description: 'The number to record.' } },
      required: ['value'],
    },
  },
  {
    name: 'josi_health',
    description: 'Echo a message back, to verify the Josi tool server is reachable.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

/** Builds the protocol core for a context. Exported for the tests; the
 * process wiring below is the only other caller. */
export function buildCore(ctx: McpHarnessContext, connect: () => Promise<Db>): McpCore {
  const offered = new Set(ctx.tools);
  const tools: McpToolDescriptor[] = [
    ...PROBE_TOOLS,
    // Only what this turn offered. ALL_TOOLS is the catalogue — task tools and
    // connected-data tools alike; the context file is the turn's actual
    // promise, already narrowed to this person's capability switches.
    ...ALL_TOOLS.filter((t) => offered.has(t.def.name)).map((t) => ({
      name: t.def.name,
      description: t.def.description,
      inputSchema: t.def.parameters,
    })),
  ];

  let db: Promise<Db> | null = null;

  // Loaded once, on the first data tool that needs it. A missing key file is
  // not an error here: executeAssistantTool refuses those tools honestly.
  let masterKey: MasterKey | null | undefined;
  const connectors = () => {
    if (masterKey === undefined) {
      try {
        masterKey = loadMasterKey(ctx.masterKeyPath ? { path: ctx.masterKeyPath } : {});
      } catch {
        masterKey = null;
      }
    }
    const key = masterKey;
    return key ? { masterKey: () => key } : null;
  };

  const execute = async (name: string, input: Record<string, unknown>, callId: string): Promise<McpToolOutcome> => {
    const completed = (result: unknown): McpToolOutcome => {
      // The private ephemeral file is the ground truth consumed by approval,
      // presentation and fabrication guards. Vendor prose is not evidence.
      appendFileSync(ctx.callsPath, `${JSON.stringify({ id: callId, name, input, result })}\n`, { mode: 0o600 });
      return { text: JSON.stringify(result) };
    };
    if (name === 'josi_health') {
      return completed({ ok: true, echo: input.message ?? null });
    }
    if (name === 'record_number') {
      // A no-op on purpose. The probe asks whether a call ARRIVES, not whether
      // it changes anything — recording its completed result answers that.
      return completed({ ok: true, recorded: input.value ?? null });
    }

    if (!ctx.userId) {
      // Honest refusal, phrased for the model to relay. No user means no owner
      // for the work, and inventing one is the thing this file must never do.
      return completed({ ok: false, error: 'no_user', message: 'This session has no signed-in person attached, so no work can be created or changed.' });
    }

    try {
      db ??= connect();
      const conn = await db;

      // The same gate, the same key, the same sentence as the in-process loop.
      const decision = await checkStepUp(conn, {
        userId: ctx.userId,
        sessionKey: ctx.sessionKey ?? ctx.threadId ?? 'mcp',
        action: name,
      });
      if (!decision.allowed) {
        return completed({ ok: false, error: decision.reason, message: decision.message });
      }

      const execute=()=>executeAssistantTool(
        conn,
        {
          userId: ctx.userId!, threadId: ctx.threadId, connectors: connectors(),
          latestUserText: ctx.latestUserText ?? undefined,
          effectiveNow: ctx.effectiveNow ? new Date(ctx.effectiveNow) : undefined,
        },
        name,
        input,
      );
      const result=isMutatingTool(name,input)
        ? await runDurableEffect(conn,{turnId:ctx.durableTurnId,leaseToken:ctx.durableLeaseToken},name,input,execute)
        : await execute();
      return completed(result);
    } catch (err) {
      // Record the real failure shape for guards, but keep stack traces and
      // provider bodies out of the private handoff file.
      completed({ ok: false, error: 'failed', message: (err as Error).message });
      throw err;
    }
  };

  return { tools, execute };
}

function loadContext(): McpHarnessContext {
  const path = process.env.JOSI_MCP_CONTEXT;
  if (!path) throw new Error('JOSI_MCP_CONTEXT is not set — this server is only started by the Josi harness');
  // The path came from our own provider; its content is ours. Parse errors are
  // fatal and say the path, never the content: the file names a person.
  const ctx = JSON.parse(readFileSync(path, 'utf8')) as McpHarnessContext;
  if (!ctx.callsPath || !Array.isArray(ctx.tools)
    || (ctx.workspaceEnabled !== undefined && typeof ctx.workspaceEnabled !== 'boolean')
    || (ctx.workspaceMode !== undefined && ctx.workspaceMode !== 'ro' && ctx.workspaceMode !== 'rw')) {
    throw new Error(`the harness context at ${path} is not the expected shape`);
  }
  return ctx;
}

async function main(): Promise<void> {
  const ctx = loadContext();
  // This process exists for one private harness session. Restore only the two
  // non-secret installation facts written by Josi's parent process; absent or
  // malformed legacy state is disabled/read-only. The shared grant still
  // enforces the exact /workspace root, owner mapping, capability and status.
  process.env.JOSI_WORKSPACE_ENABLED = ctx.workspaceEnabled === true ? '1' : '0';
  process.env.JOSI_WORKSPACE_MODE = ctx.workspaceEnabled === true && ctx.workspaceMode === 'rw' ? 'rw' : 'ro';
  let close: (() => Promise<void>) | null = null;
  const core = buildCore(ctx, async () => {
    // The connection string reaches this process through the 0600 context
    // file, not through the vendor CLI's environment — the CLI holds no secret
    // of ours. connectFromEnv is fed a synthetic env for exactly that reason.
    const conn = await connectFromEnv({
      DATABASE_URL: ctx.databaseUrl ?? undefined,
      PGPASSWORD_FILE: ctx.passwordFile ?? undefined,
    } as NodeJS.ProcessEnv, { max: 2 });
    close = conn.close;
    return conn.db;
  });

  // Replies still in flight. stdin closing is how the CLI says goodbye, and
  // it can arrive while a tool is mid-execution — exiting then would swallow
  // the answer AND the calls-file line the provider is about to read.
  const pending = new Set<Promise<void>>();

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // Not JSON-RPC; nothing to answer.
    }
    const job = handleMcpMessage(core, msg).then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  });
  rl.on('close', () => {
    // The CLI is done with us: finish what was asked, close the pool, exit.
    void Promise.allSettled([...pending])
      .then(() => (close ? close() : undefined))
      .finally(() => process.exit(0));
  });
}

// This module is an entry point, spawned by path. It still guards on the
// context variable rather than import shape, so importing `buildCore` in a
// test never starts a server.
if (process.env.JOSI_MCP_CONTEXT) {
  main().catch((err) => {
    // stderr goes to the vendor CLI's log. The message names files and shapes,
    // never conversation content.
    console.error(`josi mcp server failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
