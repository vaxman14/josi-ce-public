// The parts every adapter needs and none of them should own a copy of.
//
// Seven new adapters landed at once for V2.4. Each of them has to turn an HTTP
// status into an `LlmError` with the right `retryable` and `needsReconfiguration`
// flags, and each of them has to do it identically — the fallback rule in
// `registry.ts` reads `retryable` to decide whether to bill a second provider,
// so an adapter that sets it differently changes behaviour nobody asked it to
// change. Seven copies of that logic would have been seven chances to get it
// subtly wrong, so there is one.
import {
  LlmError, categorizeFailure, explainCategory,
  type LlmErrorCategory,
} from '../types.js';
import { UnsafeEndpointError } from '../ssrf.js';

/** The one place a non-2xx becomes an `LlmError`.
 *
 * Never carries the provider's prose — vendors routinely quote the request
 * back, and the request contains the prompt. The short code is an enum member
 * and is the only thing that separates "slow down" from "out of credit", both
 * of which arrive as 429. */
export function httpFailure(status: number, providerCode?: string): LlmError {
  const category = categorizeFailure(status, providerCode);
  return new LlmError(explainCategory(category), {
    status,
    category,
    providerCode,
    needsReconfiguration: status === 401 || status === 403 || category === 'billing',
    // A quota failure is not worth retrying, and not worth failing over to a
    // second provider that bills the same account.
    retryable: (status === 429 || status >= 500) && category !== 'billing',
  });
}

/** A transport failure, told apart from a refused endpoint.
 *
 * `UnsafeEndpointError` means the operator pointed us somewhere we will not go,
 * which is a configuration problem they can fix. Everything else is a socket. */
export function transportFailure(err: unknown): LlmError {
  if (err instanceof UnsafeEndpointError) {
    return new LlmError(err.message, { needsReconfiguration: true });
  }
  return new LlmError(explainCategory('network'), { retryable: true, category: 'network' });
}

/** A failure that is ours rather than the provider's — a credential we could
 * not use, a region that was never configured. Retrying cannot fix it. */
export function configFailure(message: string, category: LlmErrorCategory = 'malformed_request'): LlmError {
  return new LlmError(message, { needsReconfiguration: true, category });
}

export function parseJson<T>(text: string, status: number): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LlmError('the model endpoint returned something that is not valid JSON', { status });
  }
}

/** An identifier the provider gave that is safe to repeat back.
 *
 * Safe means an identifier, not a sentence: a code like `RESOURCE_EXHAUSTED`
 * or `insufficient_quota` carries no request content, whereas a `message` very
 * often quotes the prompt straight back. Anything with whitespace, or longer
 * than an identifier plausibly is, is dropped rather than trusted. */
export function safeCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(trimmed)) return undefined;
  return trimmed;
}

/** Digs a safe code out of a vendor error body, whatever it calls the field.
 *
 * Vendors disagree: OpenAI nests `error.code`, Google uses `error.status`,
 * Cohere and Tencent put it at the top level, AWS answers with a header. The
 * paths are listed rather than guessed at so a field that happens to contain
 * prose is skipped by `safeCode` instead of being echoed. */
export function errorCodeFrom(body: string): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const error = (parsed.error ?? parsed.Error ?? {}) as Record<string, unknown>;
  const response = (parsed.Response ?? {}) as Record<string, unknown>;
  const tencent = (response.Error ?? {}) as Record<string, unknown>;
  const candidates = [
    error.status, error.code, error.type, error.Code,
    tencent.Code,
    parsed.code, parsed.type, parsed.error_code, parsed.__type,
  ];
  for (const candidate of candidates) {
    const code = safeCode(candidate);
    if (code) return code;
  }
  return undefined;
}

/** A JSON Schema the Google function-calling APIs will actually accept.
 *
 * Gemini and Vertex take an OpenAPI 3.0 subset, not JSON Schema: `$schema`,
 * `additionalProperties`, `const`, `examples` and friends are rejected outright
 * with a 400. Josi's tool definitions are written as ordinary JSON Schema and
 * shared across every provider, so rather than maintaining a second set of
 * definitions for Google, the unsupported keywords are stripped on the way out.
 *
 * Stripping rather than translating is deliberate: a dropped `additionalProperties`
 * loosens validation the model was going to ignore anyway, whereas a mistranslated
 * type would make the tool call wrong. */
const GOOGLE_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minimum', 'maximum', 'minItems', 'maxItems', 'anyOf',
]);

export function googleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(googleSchema);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!GOOGLE_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && typeof item === 'string') {
      // Google spells the primitives in capitals and has no `null` type;
      // a nullable field is expressed by the `nullable` flag instead.
      out.type = item.toUpperCase();
      continue;
    }
    if (key === 'properties' && item && typeof item === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(item as Record<string, unknown>)) {
        props[name] = googleSchema(schema);
      }
      out.properties = props;
      continue;
    }
    out[key] = googleSchema(item);
  }
  return out;
}
