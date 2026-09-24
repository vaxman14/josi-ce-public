// Anthropic's Messages API. Different enough from the OpenAI shape to need its
// own adapter: system is a top-level field, tools have `input_schema` rather
// than a nested `function`, and content comes back as an array of blocks.
import {
  LlmError, type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall,
} from '../types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';
import { describeFailure } from './openaiCompatible.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
/** Pinned: the header is a dated contract and an unpinned client breaks when
 * the default moves. */
const API_VERSION = '2023-06-01';

export interface AnthropicOptions {
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function anthropicProvider(opts: AnthropicOptions): LlmProvider {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');

  return {
    kind: 'anthropic',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: request.maxTokens ?? 1024,
        // Anthropic has no 'system' role in the messages array, and a tool
        // round-trip is content BLOCKS: `tool_use` on the assistant turn,
        // `tool_result` inside the following user turn.
        messages: request.messages.map((m) => {
          const role = m.role === 'assistant' ? 'assistant' : 'user';
          if (m.toolResults?.length) {
            return {
              role: 'user',
              content: [
                ...m.toolResults.map((r) => ({
                  type: 'tool_result', tool_use_id: r.toolCallId, content: r.content,
                })),
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ],
            };
          }
          if (m.toolCalls?.length) {
            return {
              role: 'assistant',
              content: [
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
                ...m.toolCalls.map((c) => ({
                  type: 'tool_use', id: c.id, name: c.name, input: c.input,
                })),
              ],
            };
          }
          if (m.images?.length) {
            // Anthropic's documented vision shape: an array of content blocks
            // on a user turn, `image` blocks carrying base64 bytes directly
            // (no upload step, no URL — the bytes travel in the same request
            // as the question). Text goes last so the image is established
            // context before the question about it, which is how Anthropic's
            // own examples order it.
            return {
              role,
              content: [
                ...m.images.map((img) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
                })),
                ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ],
            };
          }
          return { role, content: m.content };
        }),
      };
      if (request.system) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }
      if (request.jsonMode && !request.tools?.length) {
        // Anthropic has no response_format. The documented way to get reliable
        // JSON is to say so in the system prompt; the probe judges the result
        // rather than trusting the request.
        body.system = `${request.system ? `${request.system}\n\n` : ''}Reply with a single valid JSON object and nothing else.`;
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(`${base}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': API_VERSION,
            ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}),
          },
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        if (err instanceof UnsafeEndpointError) {
          throw new LlmError(err.message, { needsReconfiguration: true });
        }
        throw new LlmError('the model endpoint did not respond', { retryable: true });
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        throw new LlmError(describeFailure(res.status), {
          status: res.status,
          needsReconfiguration: res.status === 401 || res.status === 403,
          retryable: res.status === 429 || res.status >= 500,
        });
      }

      let parsed: AnthropicResponse;
      try {
        parsed = JSON.parse(text) as AnthropicResponse;
      } catch {
        throw new LlmError('the model endpoint returned something that is not valid JSON', { status: res.status });
      }

      const blocks = parsed.content ?? [];
      const toolCalls: ToolCall[] = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => ({ id: b.id ?? `call_${i}`, name: b.name ?? '', input: b.input ?? {} }));

      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
        },
        latencyMs,
      };
    },
  };
}
