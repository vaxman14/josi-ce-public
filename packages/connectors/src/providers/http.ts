// The HTTP floor the read-only data adapters stand on.
//
// Extracted for mail and calendar rather than shared backwards into
// contacts.ts — that file is delta-sync machinery with its own cursor rules,
// and rewiring proven code to save forty lines is how proven code stops being
// proven. New adapters use this; contacts keeps its own copy.
//
// The rules are the same ones contacts.ts states: provider error BODIES are
// never quoted (a mail API's error message quotes somebody's mailbox), only
// short identifier-shaped codes survive; a timeout is enforced on every call;
// and a status maps to a category the connection-health machinery understands.
import { ConnectorError, type ErrorCategory, type FetchOptions } from '../providers.js';

export interface HttpResult {
  status: number;
  body: unknown;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfter: number | null;
}

export async function providerRequest(
  url: string,
  init: RequestInit,
  opts: FetchOptions,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const header = res.headers.get('retry-after');
    const retryAfter = header && /^\d+$/.test(header) ? Number(header) : null;
    return { status: res.status, body, retryAfter };
  } catch {
    throw new ConnectorError('could not reach the provider', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** A provider's short error code, if it gave one that is safe to repeat.
 * Codes only — an identifier, never a sentence. */
export function safeCode(body: unknown): string | null {
  const err = (body as { error?: { status?: unknown; code?: unknown } } | null)?.error;
  for (const candidate of [err?.status, err?.code]) {
    if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) return candidate;
  }
  return null;
}

export function classifyStatus(status: number, code: string | null): { category: ErrorCategory; revoked: boolean } {
  if (status === 401) return { category: 'expired', revoked: false };
  if (status === 403) return { category: 'insufficient_scope', revoked: false };
  if (status === 429) return { category: 'rate_limited', revoked: false };
  if (code === 'invalid_grant') return { category: 'revoked', revoked: true };
  return { category: 'provider_error', revoked: false };
}

export function raiseProviderError(status: number, body: unknown): never {
  const code = safeCode(body);
  const { category, revoked } = classifyStatus(status, code);
  throw new ConnectorError(
    code ? `the provider refused the request (${code})` : 'the provider refused the request',
    { category, revoked, status },
  );
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
