// OpenAI's chat-completions shape, which OpenAI, xAI, essentially every
// self-hosted runtime, and a growing list of hosted vendors speak. One adapter
// for all of them, because the wire format is genuinely the same and
// maintaining a copy per vendor would mean maintaining a copy of every bug.
//
// Which vendors belong here is decided in `catalog.ts` by `wire: 'openai-chat'`
// and the bar is deliberately higher than "advertises an OpenAI-compatible
// endpoint": the vendor has to honour the contract Josi actually uses — nested
// `function` tool definitions, `tool_calls` returned with a `tool` role keyed
// by call id, and `response_format: {type:'json_object'}`. A vendor that
// diverges on any of those gets its own adapter instead, because a shim
// presented as native support fails at the moment somebody asks for something
// that needs a tool.
import {
  LlmError, categorizeFailure, explainCategory,
  type ChatRequest, type ChatResponse, type LlmErrorCategory, type LlmProvider, type ProviderKind, type ToolCall,
} from '../types.js';
import { describeProvider } from '../catalog.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';

export interface OpenAiCompatibleOptions {
  kind: ProviderKind;
  model: string;
  apiKey?: string | null;
  /** Required for `openai_compatible`, which has no default. Optional for the
   * hosted vendors: supplying one overrides the catalogue's default endpoint,
   * which is how an operator reaches a regional host. */
  baseUrl?: string | null;
  external: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

interface OaiMessage {
  content?: string | null;
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
}

interface OaiResponse {
  choices?: Array<{ message?: OaiMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/** The chat-completions request body.
 *
 * Exported because Azure AI genuinely speaks this body — what differs there is
 * the transport around it: a per-resource host, the deployment in the path, a
 * mandatory `api-version`, and an `api-key` header instead of a bearer. Sharing
 * the translation and not the transport is the honest split; sharing the whole
 * adapter would have meant pretending a deployment is a model name. */
export function openAiChatBody(model: string, request: ChatRequest): Record<string, unknown> {
  // A tool round-trip in this dialect is: an assistant message carrying
  // `tool_calls`, then ONE `tool` message per call, keyed by call id.
  const messages: Array<Record<string, unknown>> = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
  ];
  for (const m of request.messages) {
    if (m.toolResults?.length) {
      // The results arrive as their own messages, not as a user turn.
      for (const r of m.toolResults) {
        messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
      if (m.content) messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
      continue;
    }
    if (m.images?.length) {
      // The documented OpenAI vision shape: a content ARRAY on the user turn,
      // images as `image_url` parts carrying a data: URI. Bytes travel in the
      // request rather than as a link — CE does not ask a model vendor to go
      // and fetch a second party's storage. Text last, so the picture is
      // established context before the question about it.
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
    model,
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
  return body;
}

/** The chat-completions response, normalised. Shared with Azure. */
export function readOpenAiChat(parsed: OaiResponse, latencyMs: number): ChatResponse {
  const message = parsed.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc, i) => {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      // A model that emits malformed arguments has not really made a tool
      // call. Keep the name so the probe can still see the attempt.
      input = {};
    }
    return { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? '', input };
  });

  return {
    text: message?.content ?? '',
    toolCalls,
    usage: {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
    },
    latencyMs,
  };
}

export function openAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  // The operator's endpoint wins where the catalogue allows one, so a vendor
  // with a regional or mainland-China host can be pointed at the right one
  // rather than being unusable for the people it was added for.
  const base = (opts.baseUrl || describeProvider(opts.kind)?.defaultBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new LlmError(`no endpoint configured for ${opts.kind}`);

  return {
    kind: opts.kind,
    model: opts.model,
    external: opts.external,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = openAiChatBody(opts.model, request);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // A self-hosted runtime may need no key at all; sending an empty bearer
      // makes some of them reject the request outright.
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        if (err instanceof UnsafeEndpointError) {
          throw new LlmError(err.message, { needsReconfiguration: true });
        }
        // Abort or socket failure.
        throw new LlmError(explainCategory('network'), { retryable: true, category: 'network' });
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        // The provider's own PROSE goes nowhere near the caller: it routinely
        // echoes back parts of the request, and this one contains the prompt.
        // Its short `code`/`type` is an enum member rather than prose, and it
        // is the only thing that distinguishes "slow down" from "out of
        // credit" — both of which arrive as 429.
        const providerCode = safeErrorCode(text);
        const category = categorizeFailure(res.status, providerCode);
        throw new LlmError(describeFailure(res.status, category), {
          status: res.status,
          category,
          providerCode,
          needsReconfiguration: res.status === 401 || res.status === 403 || category === 'billing',
          // A quota failure is not worth retrying and not worth failing over
          // to a second provider that bills the same account.
          retryable: (res.status === 429 || res.status >= 500) && category !== 'billing',
        });
      }

      let parsed: OaiResponse;
      try {
        parsed = JSON.parse(text) as OaiResponse;
      } catch {
        throw new LlmError('the model endpoint returned something that is not valid JSON', { status: res.status });
      }

      return readOpenAiChat(parsed, latencyMs);
    },
  };
}

/** Status codes turned into something an operator can act on, with nothing of
 * the provider's own prose. */
export function describeFailure(status: number, category?: LlmErrorCategory): string {
  const cat = category ?? categorizeFailure(status);
  if (cat === 'unknown') return 'the model provider refused the request';
  return explainCategory(cat);
}

/** The provider's short error code, if it gave one that is safe to repeat.
 *
 * Safe means: an identifier, not a sentence. A code like `insufficient_quota`
 * carries no request content; a `message` very often quotes the prompt straight
 * back. So this reads `code` and `type`, refuses anything with whitespace, and
 * caps the length — a provider that puts prose in a code field gets ignored
 * rather than trusted. */
export function safeErrorCode(body: string): string | undefined {
  let parsed: { error?: { code?: unknown; type?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return undefined;
  }
  for (const candidate of [parsed.error?.code, parsed.error?.type]) {
    if (typeof candidate !== 'string') continue;
    if (!/^[a-z0-9_.:-]{1,64}$/i.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}
