// Azure AI / Azure OpenAI.
//
// The BODY is the OpenAI chat-completions contract and is shared with that
// adapter rather than copied. Everything around it is different enough to need
// its own file:
//
//   * There is no shared host. Each customer has their own resource, so the
//     endpoint is configuration rather than a constant.
//   * A request routes by DEPLOYMENT name in the path, not by model name in
//     the body. Two customers running the same model reach it by different
//     names, and the same name on two resources can be different models.
//   * `api-version` is mandatory and is a dated contract, so it is pinned here
//     and overridable — an operator on an older resource needs the older one.
//   * The credential is an `api-key` header, not a bearer token.
//
// Given all four, "OpenAI with a different base URL" would not have worked for
// a single request.
import {
  type ChatRequest, type ChatResponse, type LlmProvider,
} from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { openAiChatBody, readOpenAiChat } from './openaiCompatible.js';
import { configFailure, errorCodeFrom, httpFailure, parseJson, transportFailure } from './shared.js';

/** The version Josi is built and tested against. Pinned rather than tracking
 * "latest": an API version is a contract, and silently moving one under a
 * running installation is how a working configuration stops working overnight. */
export const DEFAULT_API_VERSION = '2024-10-21';

export interface AzureAiOptions {
  /** The deployment name. Stored in the model column because it is what the
   * operator picks and what routes the request. */
  model: string;
  apiKey?: string | null;
  /** The resource endpoint, e.g. https://my-resource.openai.azure.com */
  baseUrl?: string | null;
  apiVersion?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

interface OaiResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function azureAiProvider(opts: AzureAiOptions): LlmProvider {
  const base = (opts.baseUrl || '').replace(/\/$/, '');
  if (!base) throw configFailure('this provider needs the endpoint of your own Azure resource');

  const apiVersion = opts.apiVersion || DEFAULT_API_VERSION;

  return {
    kind: 'azure_ai',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      // The body still carries `model`. Azure ignores it in favour of the
      // deployment in the path, and sending it keeps one body builder for both
      // providers rather than a near-copy that differs by one key.
      const body = openAiChatBody(opts.model, request);

      const url = `${base}/openai/deployments/${encodeURIComponent(opts.model)}/chat/completions`
        + `?api-version=${encodeURIComponent(apiVersion)}`;

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { 'api-key': opts.apiKey } : {}),
          },
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status, errorCodeFrom(text));

      return readOpenAiChat(parseJson<OaiResponse>(text, res.status), latencyMs);
    },
  };
}

/** The deployments on this resource.
 *
 * Deployments, not models: a resource with GPT-4o available but nothing
 * deployed can serve no requests at all, so listing models would offer the
 * operator names that cannot work. */
export async function listAzureDeployments(opts: AzureAiOptions): Promise<{
  status: number; body: string; rows: Array<{ id: string; display_name?: string }> | null;
}> {
  const base = (opts.baseUrl || '').replace(/\/$/, '');
  if (!base) throw configFailure('this provider needs the endpoint of your own Azure resource');
  const apiVersion = opts.apiVersion || DEFAULT_API_VERSION;

  let res: Response;
  try {
    res = await safeFetch(
      `${base}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`,
      { method: 'GET', headers: opts.apiKey ? { 'api-key': opts.apiKey } : {} },
      { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve },
    );
  } catch (err) {
    throw transportFailure(err);
  }

  const body = await res.text().catch(() => '');
  if (!res.ok) return { status: res.status, body, rows: null };

  let parsed: { data?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return { status: res.status, body, rows: null };
  }
  if (!Array.isArray(parsed.data)) return { status: res.status, body, rows: null };

  const rows = parsed.data
    .filter((d) => {
      // A deployment that is still creating, or has failed, cannot answer.
      const status = typeof d.status === 'string' ? d.status.toLowerCase() : '';
      return !status || status === 'succeeded';
    })
    .map((d) => {
      const id = String(d.id ?? '');
      const model = typeof d.model === 'string' ? d.model : '';
      return {
        id,
        // Both names, because they are frequently different and the operator
        // needs to recognise the deployment they made AND know what is behind
        // it before they pick one.
        display_name: model && model !== id ? `${id} (${model})` : undefined,
      };
    })
    .filter((d) => d.id);

  return { status: res.status, body, rows };
}
