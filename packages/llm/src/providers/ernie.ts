// Baidu ERNIE, through Qianfan.
//
// Three things here are unlike every other provider Josi speaks to, and each of
// them would break a shim:
//
//   1. There is no API key on the request. The credential is an API key and a
//      secret key exchanged for a short-lived access token, and the token goes
//      in the QUERY STRING rather than a header.
//   2. Failures arrive as HTTP 200 with an `error_code` in the body. An adapter
//      that checks `res.ok` would read a refusal as a successful empty reply and
//      report the model as working.
//   3. Tool calling is the older singular `functions` / `function_call` shape,
//      and a tool's answer goes back as a `function` ROLE, not as a result block
//      or a tool message.
//
// The messages array also has to alternate strictly user/assistant and start
// with a user turn, which the seam does not otherwise guarantee.
import {
  type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall,
} from '../types.js';
import { LlmError } from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { configFailure, httpFailure, parseJson, safeCode, transportFailure } from './shared.js';

const DEFAULT_BASE = 'https://aip.baidubce.com';
const RENEW_BEFORE_MS = 60_000;

export interface ErnieOptions {
  model: string;
  apiKey?: string | null;
  secretKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  now?: () => number;
}

interface ErnieResponse {
  result?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  function_call?: { name?: string; arguments?: string };
  error_code?: number;
  error_msg?: string;
}

/** Baidu's numeric error codes, mapped to the status Josi reasons about.
 *
 * They arrive inside a 200, so there is no status to categorise — this IS the
 * status. Only the codes whose meaning is documented and stable are listed; an
 * unrecognised code becomes a 500, which is retryable and honest about not
 * being understood rather than guessing at "your key is wrong". */
export function ernieStatus(code: number): number {
  switch (code) {
    case 110: case 111: case 100: return 401;  // invalid / expired token, invalid param
    case 6: return 403;                        // no permission for this resource
    case 17: case 19: return 402;              // daily quota, total quota
    case 4: case 18: return 429;               // QPS and request-rate limits
    case 336003: case 336007: return 400;      // malformed request body
    case 336006: return 404;                   // no such model endpoint
    default: return 500;
  }
}

/** The access token, minted from the key pair and cached until it expires. */
export function ernieTokenSource(opts: ErnieOptions): () => Promise<string> {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  let cached: { token: string; expiresAtMs: number } | null = null;

  return async function accessToken(): Promise<string> {
    const now = opts.now?.() ?? Date.now();
    if (cached && cached.expiresAtMs - RENEW_BEFORE_MS > now) return cached.token;

    if (!opts.apiKey || !opts.secretKey) {
      throw configFailure('this provider needs both the API key and the secret key of your Qianfan application');
    }

    // The credential travels as form-encoded POST fields rather than in the
    // query string Baidu's own examples use: a query string is the part of a
    // URL that reaches proxy logs, and this one carries the secret key.
    let res: Response;
    try {
      res = await safeFetch(`${base}/oauth/2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: opts.apiKey,
          client_secret: opts.secretKey,
        }).toString(),
      }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
    } catch (err) {
      throw transportFailure(err);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpFailure(res.status);

    const parsed = parseJson<{ access_token?: string; expires_in?: number; error?: string }>(text, res.status);
    if (!parsed.access_token) {
      // The token endpoint also answers 200 with an `error` field.
      throw new LlmError(
        'Baidu rejected that API key and secret key pair.',
        { category: 'authentication', needsReconfiguration: true, providerCode: safeCode(parsed.error) },
      );
    }
    cached = { token: parsed.access_token, expiresAtMs: now + (parsed.expires_in ?? 2592000) * 1000 };
    return cached.token;
  };
}

/** ERNIE requires strict user/assistant alternation beginning with a user turn.
 *
 * Consecutive turns of the same role are merged rather than dropped, and a
 * conversation that somehow begins with an assistant turn has it merged into
 * the first user turn. Dropping content to satisfy a formatting rule would
 * change what the model was asked. */
export function alternate(
  turns: Array<{ role: string; content: string; name?: string }>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    // A `function` turn is a reply to a call and never participates in the
    // alternation rule, so it passes through untouched.
    if (turn.role === 'function') {
      out.push({ role: 'function', name: turn.name ?? '', content: turn.content });
      continue;
    }
    const previous = out[out.length - 1];
    if (previous && previous.role === turn.role) {
      previous.content = `${String(previous.content)}\n\n${turn.content}`;
      continue;
    }
    out.push({ role: turn.role, content: turn.content });
  }
  if (out.length && out[0].role === 'assistant') {
    out.unshift({ role: 'user', content: 'Continue.' });
  }
  return out;
}

export function ernieProvider(opts: ErnieOptions): LlmProvider {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const accessToken = ernieTokenSource(opts);

  return {
    kind: 'ernie',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const turns: Array<{ role: string; content: string; name?: string }> = [];
      for (const m of request.messages) {
        if (m.toolResults?.length) {
          for (const r of m.toolResults) {
            turns.push({ role: 'function', name: r.name, content: r.content });
          }
          if (m.content) turns.push({ role: m.role, content: m.content });
          continue;
        }
        if (m.toolCalls?.length) {
          // ERNIE carries at most one call per turn and expects it echoed on
          // the assistant turn it came from. Extra calls would have to be
          // invented into turns the conversation never had, so the first is
          // sent and the rest are represented as text rather than silently
          // discarded.
          const [first, ...rest] = m.toolCalls;
          turns.push({
            role: 'assistant',
            content: m.content || `Calling ${first.name}.`,
          });
          if (rest.length) {
            turns.push({
              role: 'assistant',
              content: `Also called: ${rest.map((c) => c.name).join(', ')}.`,
            });
          }
          continue;
        }
        turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }

      const body: Record<string, unknown> = { messages: alternate(turns) };
      if (request.system) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
      if (request.jsonMode) body.response_format = { type: 'json_object' };
      if (request.tools?.length) {
        body.functions = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }));
      }

      const token = await accessToken();

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(
          `${base}/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/${encodeURIComponent(opts.model)}`
          + `?access_token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve },
        );
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status);

      const parsed = parseJson<ErnieResponse>(text, res.status);

      // The important one. A refusal arrives as a 200 with an error code, and
      // reading it as a successful empty reply would report a broken
      // configuration as a working model.
      if (typeof parsed.error_code === 'number' && parsed.error_code !== 0) {
        // The code, never `error_msg` — Baidu's message quotes the request back.
        throw httpFailure(ernieStatus(parsed.error_code), `ernie_${parsed.error_code}`);
      }

      const toolCalls: ToolCall[] = [];
      if (parsed.function_call?.name) {
        let input: Record<string, unknown> = {};
        try {
          input = parsed.function_call.arguments
            ? (JSON.parse(parsed.function_call.arguments) as Record<string, unknown>)
            : {};
        } catch {
          input = {};
        }
        // ERNIE issues no call id. One is synthesised so results can be keyed
        // back exactly as they are for every other provider.
        toolCalls.push({ id: 'call_0', name: parsed.function_call.name, input });
      }

      return {
        text: parsed.result ?? '',
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
        latencyMs,
      };
    },
  };
}

/** Proves the key pair works, without spending a model call.
 *
 * Qianfan lists models through its console API rather than through the
 * inference credential, so discovery has nothing to ask. Minting a token is
 * the one thing this credential CAN be checked with, and it is worth checking
 * before an operator is told their provider is configured. */
export async function verifyErnieCredential(opts: ErnieOptions): Promise<void> {
  await ernieTokenSource(opts)();
}
