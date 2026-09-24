// AWS Bedrock, through the Converse API.
//
// Converse rather than InvokeModel on purpose: InvokeModel passes the
// underlying vendor's raw body through, so supporting it would mean writing an
// Anthropic body for Anthropic models, a Meta body for Llama and an Amazon body
// for Nova — three adapters wearing one name, and a fourth the day AWS adds a
// vendor. Converse is the one contract that spans them, including tool use.
//
// Authentication is SigV4 over a static IAM credential, which is why this is a
// dedicated adapter and not a base-URL change: there is no bearer token to put
// in a header, the signature covers the body, and it has to be recomputed per
// request.
import {
  type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall,
} from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { configFailure, errorCodeFrom, httpFailure, parseJson, transportFailure } from './shared.js';
import { signRequest, uriEncode, type AwsCredentials } from './awsSigv4.js';

export interface BedrockOptions {
  model: string;
  region: string;
  credentials: AwsCredentials;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  /** Injected by the tests so a signature is reproducible. */
  now?: () => Date;
}

interface BedrockBlock {
  text?: string;
  toolUse?: { toolUseId?: string; name?: string; input?: Record<string, unknown> };
}

interface BedrockResponse {
  output?: { message?: { content?: BedrockBlock[] } };
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Bedrock names an image by format, not by MIME type, and accepts exactly
 * four. An unsupported type is dropped rather than sent as something it is
 * not — a JPEG relabelled as a PNG is rejected by the model with an error the
 * operator cannot act on. */
function imageFormat(mediaType: string): string | null {
  const match = /^image\/(png|jpeg|gif|webp)$/i.exec(mediaType.trim());
  if (match) return match[1].toLowerCase();
  if (/^image\/jpg$/i.test(mediaType.trim())) return 'jpeg';
  return null;
}

export function bedrockProvider(opts: BedrockOptions): LlmProvider {
  if (!opts.region) throw configFailure('this provider needs the AWS region its model access was granted in');
  if (!opts.credentials.accessKeyId || !opts.credentials.secretAccessKey) {
    throw configFailure('this provider needs an AWS access key ID and secret access key');
  }

  const host = `bedrock-runtime.${opts.region}.amazonaws.com`;

  return {
    kind: 'bedrock',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const messages: Array<Record<string, unknown>> = [];

      for (const m of request.messages) {
        // Converse has no system role in `messages` and no tool role either:
        // a tool result is a `toolResult` BLOCK inside an ordinary user turn,
        // which is the Anthropic arrangement rather than the OpenAI one.
        if (m.toolResults?.length) {
          messages.push({
            role: 'user',
            content: [
              ...m.toolResults.map((r) => ({
                toolResult: {
                  toolUseId: r.toolCallId,
                  content: [{ text: r.content }],
                },
              })),
              ...(m.content ? [{ text: m.content }] : []),
            ],
          });
          continue;
        }

        if (m.toolCalls?.length) {
          messages.push({
            role: 'assistant',
            content: [
              ...(m.content ? [{ text: m.content }] : []),
              ...m.toolCalls.map((c) => ({
                toolUse: { toolUseId: c.id, name: c.name, input: c.input },
              })),
            ],
          });
          continue;
        }

        const role = m.role === 'assistant' ? 'assistant' : 'user';

        if (m.images?.length) {
          const blocks = m.images
            .map((img) => {
              const format = imageFormat(img.mediaType);
              return format
                ? { image: { format, source: { bytes: img.base64 } } }
                : null;
            })
            .filter((b): b is { image: { format: string; source: { bytes: string } } } => b !== null);
          if (blocks.length) {
            messages.push({
              role,
              content: [...blocks, ...(m.content ? [{ text: m.content }] : [])],
            });
            continue;
          }
        }

        messages.push({ role, content: [{ text: m.content }] });
      }

      const inferenceConfig: Record<string, unknown> = { maxTokens: request.maxTokens ?? 1024 };
      if (request.temperature !== undefined) inferenceConfig.temperature = request.temperature;

      const system: Array<{ text: string }> = [];
      if (request.system) system.push({ text: request.system });
      if (request.jsonMode && !request.tools?.length) {
        // Converse has no structured-output switch. The documented way is to
        // ask in the system prompt, exactly as with Anthropic's own API — and
        // the probe grades what came back rather than trusting the request.
        system.push({ text: 'Reply with a single valid JSON object and nothing else.' });
      }

      const body: Record<string, unknown> = { messages, inferenceConfig };
      if (system.length) body.system = system;
      if (request.tools?.length) {
        body.toolConfig = {
          tools: request.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              // The schema is wrapped in `json`, which is Converse's way of
              // saying "this is a JSON Schema" rather than one of its own
              // shapes. Unlike Google, it takes ordinary JSON Schema as-is.
              inputSchema: { json: t.parameters },
            },
          })),
        };
      }

      const payload = JSON.stringify(body);
      // Encoded once for the wire; `signRequest` encodes each segment a second
      // time for the canonical form. Model ids contain a colon, so this matters.
      const path = `/model/${uriEncode(opts.model)}/converse`;

      const signed = signRequest({
        method: 'POST',
        host,
        path,
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        region: opts.region,
        service: 'bedrock',
        credentials: opts.credentials,
        now: opts.now?.(),
      });

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(signed.url, {
          method: 'POST',
          headers: signed.headers,
          body: payload,
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status, errorCodeFrom(text));

      const parsed = parseJson<BedrockResponse>(text, res.status);
      const blocks = parsed.output?.message?.content ?? [];

      const toolCalls: ToolCall[] = blocks
        .filter((b) => b.toolUse)
        .map((b, i) => ({
          id: b.toolUse?.toolUseId ?? `call_${i}`,
          name: b.toolUse?.name ?? '',
          input: b.toolUse?.input ?? {},
        }));

      return {
        text: blocks.filter((b) => typeof b.text === 'string').map((b) => b.text ?? '').join(''),
        toolCalls,
        usage: {
          inputTokens: parsed.usage?.inputTokens ?? 0,
          outputTokens: parsed.usage?.outputTokens ?? 0,
        },
        latencyMs,
      };
    },
  };
}

/** The foundation models this account may call in this region.
 *
 * A different host and a different signing service from inference — the
 * catalogue lives on the `bedrock` control plane, not `bedrock-runtime` — and
 * filtered to models that take and return text. A model listed here still has
 * to have been granted to the account, which is why the probe runs afterwards
 * rather than this being treated as proof. */
export async function listBedrockModels(opts: {
  region: string;
  credentials: AwsCredentials;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  now?: () => Date;
}): Promise<{ status: number; body: string; rows: Array<{ id: string; display_name?: string }> | null }> {
  const host = `bedrock.${opts.region}.amazonaws.com`;
  const signed = signRequest({
    method: 'GET',
    host,
    path: '/foundation-models',
    query: { byOutputModality: 'TEXT' },
    headers: {},
    body: '',
    region: opts.region,
    service: 'bedrock',
    credentials: opts.credentials,
    now: opts.now?.(),
  });

  let res: Response;
  try {
    res = await safeFetch(signed.url, { method: 'GET', headers: signed.headers }, {
      timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve,
    });
  } catch (err) {
    throw transportFailure(err);
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) return { status: res.status, body, rows: null };

  let parsed: { modelSummaries?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { status: res.status, body, rows: null };
  }
  if (!Array.isArray(parsed.modelSummaries)) return { status: res.status, body, rows: null };

  const rows = parsed.modelSummaries
    .filter((m) => {
      // ON_DEMAND is the only inference type a plain Converse call can use.
      // A provisioned-throughput-only model needs an ARN the operator has to
      // supply themselves, so offering its bare id would be offering something
      // that cannot work.
      const types = m.inferenceTypesSupported;
      return !Array.isArray(types) || types.includes('ON_DEMAND');
    })
    .map((m) => {
      const id = String(m.modelId ?? '');
      const vendor = typeof m.providerName === 'string' ? m.providerName : '';
      const name = typeof m.modelName === 'string' ? m.modelName : '';
      return {
        id,
        display_name: name ? (vendor ? `${vendor} ${name}` : name) : undefined,
      };
    })
    .filter((m) => m.id);

  return { status: res.status, body, rows };
}
