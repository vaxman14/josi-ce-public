// Google's Gemini API (`generateContent`).
//
// Not an OpenAI shim. Every part of the contract differs: the model name is in
// the PATH rather than the body, turns are `contents` with a `model` role
// instead of `assistant`, text and images and tool traffic are all `parts` of a
// turn rather than separate fields, the system prompt is its own top-level
// object, generation settings live under `generationConfig`, and JSON mode is a
// MIME type rather than a `response_format`. Routing this through the OpenAI
// adapter with a changed base URL would fail on the first tool call.
import {
  LlmError,
  type ChatRequest, type ChatResponse, type LlmProvider, type ProviderKind, type ToolCall,
} from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { errorCodeFrom, googleSchema, httpFailure, parseJson, transportFailure } from './shared.js';

export interface GeminiOptions {
  kind?: ProviderKind;
  model: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** The turns, translated.
 *
 * Exported for the Vertex adapter, which speaks the same body over a different
 * host and a different credential. One translation, two transports — the thing
 * that genuinely differs between them is authentication, and that is the only
 * thing that is written twice. */
export function geminiContents(request: ChatRequest): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];

  for (const m of request.messages) {
    // Gemini calls the assistant "model". Everything that is not the assistant
    // — including a turn carrying tool results — is a user turn.
    const role = m.role === 'assistant' ? 'model' : 'user';

    if (m.toolResults?.length) {
      contents.push({
        role: 'user',
        parts: [
          ...m.toolResults.map((r) => ({
            functionResponse: {
              name: r.name,
              // The result must be an OBJECT here, not the JSON text every
              // other provider accepts. A tool that returned an array or a
              // bare string is wrapped rather than rejected, because the
              // shape of a tool's output is not Gemini's decision to make.
              response: wrapToolResult(r.content),
            },
          })),
          ...(m.content ? [{ text: m.content }] : []),
        ],
      });
      continue;
    }

    if (m.toolCalls?.length) {
      contents.push({
        role: 'model',
        parts: [
          ...(m.content ? [{ text: m.content }] : []),
          ...m.toolCalls.map((c) => ({ functionCall: { name: c.name, args: c.input } })),
        ],
      });
      continue;
    }

    if (m.images?.length) {
      // `inlineData` carries the bytes in this request. Text last, so the
      // picture is context before the question about it.
      contents.push({
        role,
        parts: [
          ...m.images.map((img) => ({ inlineData: { mimeType: img.mediaType, data: img.base64 } })),
          ...(m.content ? [{ text: m.content }] : []),
        ],
      });
      continue;
    }

    contents.push({ role, parts: [{ text: m.content }] });
  }

  return contents;
}

/** A tool's JSON text as the object Gemini insists on.
 *
 * Anything that is not a JSON object — an array, a number, a string, or output
 * that was never JSON at all — is put under `result` rather than dropped or
 * coerced. The model sees what the tool actually said either way. */
function wrapToolResult(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return { result: content };
  }
}

/** The non-turn half of the body: system prompt, tools, generation settings. */
export function geminiEnvelope(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };

  if (request.tools?.length) {
    body.tools = [{
      functionDeclarations: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Google takes an OpenAPI subset and 400s on ordinary JSON Schema
        // keywords, so the shared definitions are narrowed on the way out.
        parameters: googleSchema(t.parameters),
      })),
    }];
  }

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxTokens ?? 1024,
  };
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  // Gemini's JSON mode is a response MIME type. It is genuinely enforced rather
  // than requested, but the probe still judges what came back — an enforced
  // mode that returns an empty candidate is not structured output.
  if (request.jsonMode) generationConfig.responseMimeType = 'application/json';
  body.generationConfig = generationConfig;

  return body;
}

/** The response, normalised. Shared with Vertex for the same reason as the
 * request half. */
export function readGeminiResponse(parsed: GeminiResponse, latencyMs: number): ChatResponse {
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];

  const toolCalls: ToolCall[] = parts
    .filter((p) => p.functionCall)
    .map((p, i) => ({
      // Gemini does not issue call ids. One is synthesised so the rest of CE
      // can key results by it exactly as it does everywhere else, and it is
      // stable within the turn, which is all a round-trip needs.
      id: `call_${i}`,
      name: p.functionCall?.name ?? '',
      input: p.functionCall?.args ?? {},
    }));

  return {
    text: parts.filter((p) => typeof p.text === 'string').map((p) => p.text ?? '').join(''),
    toolCalls,
    usage: {
      inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
    },
    latencyMs,
  };
}

export function geminiProvider(opts: GeminiOptions): LlmProvider {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');

  return {
    kind: opts.kind ?? 'gemini',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = { contents: geminiContents(request), ...geminiEnvelope(request) };

      const started = Date.now();
      let res: Response;
      try {
        // The key goes in a header rather than the `?key=` query parameter
        // Google's quickstarts use. A query string is the part of a URL that
        // ends up in proxy logs and error reports; a header is not.
        res = await safeFetch(
          `${base}/models/${encodeURIComponent(opts.model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(opts.apiKey ? { 'x-goog-api-key': opts.apiKey } : {}),
            },
            body: JSON.stringify(body),
          },
          { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve },
        );
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status, errorCodeFrom(text));

      return readGeminiResponse(parseJson<GeminiResponse>(text, res.status), latencyMs);
    },
  };
}

/** Gemini's model listing, for discovery.
 *
 * Returns the raw rows so `discovery.ts` owns the shaping. Only models that
 * declare `generateContent` are returned: the listing also carries embedding
 * and token-counting models, and offering one as the model Josi thinks with is
 * the failure discovery exists to prevent. */
export async function listGeminiModels(
  opts: GeminiOptions,
): Promise<{ status: number; body: string; rows: Array<{ id: string; display_name?: string }> | null }> {
  const base = (opts.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  let res: Response;
  try {
    res = await safeFetch(
      `${base}/models?pageSize=200`,
      { method: 'GET', headers: opts.apiKey ? { 'x-goog-api-key': opts.apiKey } : {} },
      { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve },
    );
  } catch (err) {
    throw transportFailure(err);
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) return { status: res.status, body, rows: null };

  let parsed: { models?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { status: res.status, body, rows: null };
  }
  if (!Array.isArray(parsed.models)) return { status: res.status, body, rows: null };

  const rows = parsed.models
    .filter((m) => {
      const methods = m.supportedGenerationMethods;
      // Absent rather than empty means an older API surface that did not say;
      // those are kept, because dropping a model for not answering a question
      // is worse than showing one the probe will reject.
      return !Array.isArray(methods) || methods.includes('generateContent');
    })
    .map((m) => ({
      // `models/gemini-2.5-pro` is the resource name; the id used everywhere
      // else — and in the request path above — is the last segment.
      id: String(m.name ?? '').replace(/^models\//, ''),
      display_name: typeof m.displayName === 'string' ? m.displayName : undefined,
    }))
    .filter((m) => m.id);

  return { status: res.status, body, rows };
}

/** Raised when a Gemini-shaped provider is built without what it needs. */
export function requireGeminiModel(model: string): void {
  if (!model) throw new LlmError('no model was chosen for this provider', { needsReconfiguration: true });
}
