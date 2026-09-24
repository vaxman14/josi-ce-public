// Cohere's v2 Chat API.
//
// Close enough to the OpenAI shape to be tempting and different enough to break
// if you give in: the reply is `message.content` as an ARRAY of typed blocks
// rather than a string, token counts live under `usage.tokens` with different
// field names, and an assistant turn that calls a tool carries a `tool_plan`
// string that has to be round-tripped or Cohere rejects the follow-up. A shim
// would return an empty string for every reply and lose every tool result.
import {
  type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall,
} from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { errorCodeFrom, httpFailure, parseJson, transportFailure } from './shared.js';

export interface CohereOptions {
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

const DEFAULT_BASE = 'https://api.cohere.com';

interface CohereBlock { type?: string; text?: string }

interface CohereResponse {
  message?: {
    content?: CohereBlock[] | string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
  usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
}

export function cohereProvider(opts: CohereOptions): LlmProvider {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');

  return {
    kind: 'cohere',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const messages: Array<Record<string, unknown>> = [
        ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ];

      for (const m of request.messages) {
        if (m.toolResults?.length) {
          // One `tool` message per result, keyed by call id — the same rule as
          // OpenAI, and the reason this half looks familiar.
          for (const r of m.toolResults) {
            messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
          }
          if (m.content) messages.push({ role: m.role, content: m.content });
          continue;
        }

        if (m.toolCalls?.length) {
          messages.push({
            role: 'assistant',
            // Cohere requires a `tool_plan` on any assistant turn that calls a
            // tool and refuses the request without one. The model's own plan
            // text is not something the seam carries — no other provider has
            // the concept — so the assistant's text stands in for it, and a
            // turn that was pure tool calls gets a plain statement of fact
            // rather than an invented rationale.
            tool_plan: m.content || 'Calling the tools needed to answer.',
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            })),
          });
          continue;
        }

        if (m.images?.length) {
          messages.push({
            role: m.role,
            content: [
              ...m.images.map((img) => ({
                type: 'image_url',
                image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
              })),
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
            ],
          });
          continue;
        }

        messages.push({ role: m.role, content: m.content });
      }

      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        max_tokens: request.maxTokens ?? 1024,
      };
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.jsonMode) body.response_format = { type: 'json_object' };
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(`${base}/v2/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status, errorCodeFrom(text));

      const parsed = parseJson<CohereResponse>(text, res.status);
      const content = parsed.message?.content;

      const toolCalls: ToolCall[] = (parsed.message?.tool_calls ?? []).map((tc, i) => {
        let input: Record<string, unknown> = {};
        try {
          input = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        return { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? '', input };
      });

      return {
        // An array of blocks in the documented shape, but a plain string is
        // accepted too rather than silently becoming an empty reply if Cohere
        // ever simplifies it.
        text: typeof content === 'string'
          ? content
          : (content ?? []).filter((b) => b.type === 'text' || b.text).map((b) => b.text ?? '').join(''),
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.tokens?.input_tokens ?? 0,
          outputTokens: parsed.usage?.tokens?.output_tokens ?? 0,
        },
        latencyMs,
      };
    },
  };
}

/** Cohere's model listing, filtered to the ones that serve chat.
 *
 * The listing is v1 even for a v2 chat client — Cohere did not version the
 * catalogue with the inference API, and asking v2 for it returns a 404 that
 * would surface to the operator as "the provider does not list models". */
export async function listCohereModels(
  opts: CohereOptions,
): Promise<{ status: number; body: string; rows: Array<{ id: string }> | null }> {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  let res: Response;
  try {
    res = await safeFetch(
      `${base}/v1/models?endpoint=chat&page_size=100`,
      { method: 'GET', headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {} },
      { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve },
    );
  } catch (err) {
    throw transportFailure(err);
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) return { status: res.status, body, rows: null };

  let parsed: { models?: Array<{ name?: unknown }> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { status: res.status, body, rows: null };
  }
  if (!Array.isArray(parsed.models)) return { status: res.status, body, rows: null };

  return {
    status: res.status,
    body,
    rows: parsed.models
      .map((m) => ({ id: typeof m.name === 'string' ? m.name : '' }))
      .filter((m) => m.id),
  };
}
