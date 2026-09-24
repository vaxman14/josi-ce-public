// Tencent Hunyuan, over the Tencent Cloud API.
//
// Nothing about this is OpenAI-shaped. The signature scheme is Tencent's own
// TC3-HMAC-SHA256, every field is PascalCase, the action is a header rather
// than a path, a tool's parameter schema is sent as a JSON STRING rather than
// an object, and — like Baidu — a refusal comes back as HTTP 200 with an error
// object inside it.
//
// The signing is close enough to AWS SigV4 to look reusable and different
// enough that it is not: a different prefix, a different terminator, a lowercase
// action in the canonical headers, and a timestamp that is seconds rather than
// a formatted string.
import { createHash, createHmac } from 'node:crypto';
import {
  type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall,
} from '../types.js';
import { configFailure, httpFailure, parseJson, safeCode, transportFailure } from './shared.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';

const HOST = 'hunyuan.tencentcloudapi.com';
const SERVICE = 'hunyuan';
/** The dated API contract. Pinned, for the same reason Anthropic's version is. */
const API_VERSION = '2023-09-01';

export interface HunyuanOptions {
  model: string;
  secretId?: string | null;
  secretKey?: string | null;
  region?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  now?: () => number;
}

interface HunyuanBody {
  Response?: {
    Choices?: Array<{
      Message?: {
        Content?: string;
        ToolCalls?: Array<{ Id?: string; Function?: { Name?: string; Arguments?: string } }>;
      };
    }>;
    Usage?: { PromptTokens?: number; CompletionTokens?: number };
    Error?: { Code?: string; Message?: string };
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** TC3-HMAC-SHA256, for one JSON POST to one host.
 *
 * Deliberately not generalised. Tencent's canonical request has several fields
 * that are constant for every call Josi makes — the URI is always `/`, the
 * query is always empty, the payload is always JSON — and a general signer
 * would have parameters that are never varied and one that is easy to get
 * wrong: the action name is lowercased in the canonical headers and sent in
 * its original case in the request. */
export function tc3Authorization(args: {
  secretId: string;
  secretKey: string;
  action: string;
  payload: string;
  timestampSeconds: number;
}): string {
  const date = new Date(args.timestampSeconds * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const signedHeaders = 'content-type;host;x-tc-action';

  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:${contentType}\nhost:${HOST}\nx-tc-action:${args.action.toLowerCase()}\n`,
    signedHeaders,
    sha256Hex(args.payload),
  ].join('\n');

  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(args.timestampSeconds),
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = hmac(hmac(hmac(`TC3${args.secretKey}`, date), SERVICE), 'tc3_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `TC3-HMAC-SHA256 Credential=${args.secretId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Tencent's error codes, which are dotted identifiers rather than numbers.
 *
 * Matched on the family before the specific code, because Tencent appends a
 * reason to most of them (`AuthFailure.SignatureExpire`) and the family is the
 * part that says what the operator has to do. */
export function hunyuanStatus(code: string): number {
  if (code.startsWith('AuthFailure')) return 401;
  if (code.startsWith('UnauthorizedOperation')) return 403;
  if (code.startsWith('RequestLimitExceeded')) return 429;
  if (code.startsWith('LimitExceeded') || code.includes('ResourceInsufficient')) return 402;
  if (code.startsWith('InvalidParameter') || code.startsWith('MissingParameter')) return 400;
  if (code.startsWith('ResourceNotFound')) return 404;
  if (code.startsWith('InternalError') || code.startsWith('FailedOperation')) return 500;
  return 500;
}

export function hunyuanProvider(opts: HunyuanOptions): LlmProvider {
  if (!opts.secretId || !opts.secretKey) {
    throw configFailure('this provider needs a Tencent Cloud secret ID and secret key');
  }
  const secretId = opts.secretId;
  const secretKey = opts.secretKey;

  return {
    kind: 'hunyuan',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      // Hunyuan has no structured-output switch, so JSON mode is asked for in
      // the system turn — the same approach as Anthropic and Bedrock, and the
      // probe grades the answer rather than trusting the request.
      const systemText = [
        request.system ?? '',
        request.jsonMode && !request.tools?.length
          ? 'Reply with a single valid JSON object and nothing else.'
          : '',
      ].filter(Boolean).join('\n\n');

      const messages: Array<Record<string, unknown>> = [
        ...(systemText ? [{ Role: 'system', Content: systemText }] : []),
      ];

      for (const m of request.messages) {
        if (m.toolResults?.length) {
          for (const r of m.toolResults) {
            messages.push({ Role: 'tool', ToolCallId: r.toolCallId, Content: r.content });
          }
          if (m.content) messages.push({ Role: m.role, Content: m.content });
          continue;
        }
        if (m.toolCalls?.length) {
          messages.push({
            Role: 'assistant',
            Content: m.content || '',
            ToolCalls: m.toolCalls.map((c) => ({
              Id: c.id,
              Type: 'function',
              Function: { Name: c.name, Arguments: JSON.stringify(c.input) },
            })),
          });
          continue;
        }
        if (m.images?.length) {
          // `Contents` — plural, and a different field from `Content` — is how
          // a multimodal turn is expressed. Only the vision models accept it;
          // the probe is what establishes whether the chosen one does.
          messages.push({
            Role: m.role,
            Contents: [
              ...m.images.map((img) => ({
                Type: 'image_url',
                ImageUrl: { Url: `data:${img.mediaType};base64,${img.base64}` },
              })),
              ...(m.content ? [{ Type: 'text', Text: m.content }] : []),
            ],
          });
          continue;
        }
        messages.push({ Role: m.role, Content: m.content });
      }

      const body: Record<string, unknown> = {
        Model: opts.model,
        Messages: messages,
        Stream: false,
      };
      if (request.temperature !== undefined) body.Temperature = request.temperature;
      if (request.maxTokens !== undefined) body.MaxTokens = request.maxTokens;
      if (request.tools?.length) {
        body.Tools = request.tools.map((t) => ({
          Type: 'function',
          Function: {
            Name: t.name,
            Description: t.description,
            // A JSON *string*, not an object. Sending the object gets the
            // whole request rejected as a malformed parameter.
            Parameters: JSON.stringify(t.parameters),
          },
        }));
        body.ToolChoice = 'auto';
      }

      const payload = JSON.stringify(body);
      const timestamp = Math.floor((opts.now?.() ?? Date.now()) / 1000);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
        Host: HOST,
        'X-TC-Action': 'ChatCompletions',
        'X-TC-Version': API_VERSION,
        'X-TC-Timestamp': String(timestamp),
        Authorization: tc3Authorization({
          secretId, secretKey, action: 'ChatCompletions', payload, timestampSeconds: timestamp,
        }),
      };
      if (opts.region) headers['X-TC-Region'] = opts.region;

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(`https://${HOST}/`, { method: 'POST', headers, body: payload }, {
          timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve,
        });
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status);

      const parsed = parseJson<HunyuanBody>(text, res.status).Response ?? {};

      // A refusal inside a 200. Reading past it would report a signature
      // failure or an unactivated service as a working model that says nothing.
      if (parsed.Error?.Code) {
        const code = safeCode(parsed.Error.Code);
        // The code only. Tencent's `Message` field quotes the request back.
        throw httpFailure(hunyuanStatus(parsed.Error.Code), code);
      }

      const message = parsed.Choices?.[0]?.Message;
      const toolCalls: ToolCall[] = (message?.ToolCalls ?? []).map((tc, i) => {
        let input: Record<string, unknown> = {};
        try {
          input = tc.Function?.Arguments
            ? (JSON.parse(tc.Function.Arguments) as Record<string, unknown>)
            : {};
        } catch {
          input = {};
        }
        return { id: tc.Id ?? `call_${i}`, name: tc.Function?.Name ?? '', input };
      });

      return {
        text: message?.Content ?? '',
        toolCalls,
        usage: {
          inputTokens: parsed.Usage?.PromptTokens ?? 0,
          outputTokens: parsed.Usage?.CompletionTokens ?? 0,
        },
        latencyMs,
      };
    },
  };
}
