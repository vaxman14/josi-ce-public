// A minimal MCP (Model Context Protocol) stdio server core.
//
// WHY HAND-ROLLED. The server needs exactly four requests to serve a vendor
// CLI: initialize, tools/list, tools/call and ping. The official SDK would add
// a dependency tree to an image whose install step deliberately runs
// --ignore-scripts, in exchange for capabilities (resources, prompts,
// sampling, HTTP transports) this server must never grow — it exposes Josi's
// tools to a model and nothing else. Fifty lines of JSON-RPC we can read is
// the smaller risk. Verified live against the pinned Codex 0.152.0.
//
// This file is PURE: messages in, replies out, no stdio and no database, so
// the tests exercise the protocol without spawning anything. `server.ts` owns
// the wiring.

/** Latest protocol revision this server knows. `initialize` echoes the
 * client's requested version when we can serve it, which for the four methods
 * implemented here is every revision published so far. */
const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolOutcome {
  /** What the MODEL gets to read. Refusals go here too — a policy "no" is an
   * answer for the model to relay, not a protocol failure. */
  text: string;
  /** True only for genuine execution failures. */
  isError?: boolean;
}

export type McpToolExecutor = (
  name: string,
  input: Record<string, unknown>,
  callId: string,
) => Promise<McpToolOutcome>;

export interface McpCore {
  tools: McpToolDescriptor[];
  execute: McpToolExecutor;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Handles one decoded message. Returns the reply to write, or null when the
 * message wants no answer (notifications, malformed junk without an id). */
export async function handleMcpMessage(core: McpCore, raw: unknown): Promise<object | null> {
  const msg = (raw ?? {}) as JsonRpcMessage;
  const method = typeof msg.method === 'string' ? msg.method : '';
  const hasId = msg.id !== undefined && msg.id !== null;

  // Notifications (initialized, cancelled, ...) are acknowledged by silence;
  // answering one is a protocol violation some clients treat as fatal.
  if (!hasId) return null;
  const id = msg.id as string | number;

  if (method === 'initialize') {
    const params = (msg.params ?? {}) as { protocolVersion?: unknown };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'josi-tools', version: '1.0.0' },
      },
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: core.tools } };
  }

  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === 'string' ? params.name : '';
    if (!core.tools.some((t) => t.name === name)) {
      // A real error, not a text reply: the model asked for something that was
      // never offered, and the client should see that as the fault it is.
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `no tool named ${name}` } };
    }
    const input = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    let outcome: McpToolOutcome;
    try {
      outcome = await core.execute(name, input, String(id));
    } catch (err) {
      // The tool's own message, never a stack trace — same rule as the agent
      // loop. What the model reads, the transcript keeps.
      outcome = { text: JSON.stringify({ ok: false, error: 'failed', message: (err as Error).message }), isError: true };
    }
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError === true },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}
