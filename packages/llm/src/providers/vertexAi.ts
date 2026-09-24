// Google Vertex AI.
//
// The BODY is Gemini's and is shared with that adapter. What makes this a
// separate provider rather than a base-URL change is the credential: Vertex
// does not take an API key at all. It takes a Google Cloud service account, and
// a request has to carry a short-lived OAuth access token minted by signing a
// JWT with that account's private key. So this file is, almost entirely, that
// exchange — and the reason it exists is that no amount of base-URL
// configuration can produce a token.
//
// The other real difference is that the project and region are part of the
// resource path. A Vertex request is addressed to a model inside one project in
// one region, which is exactly the property that makes it usable under a
// data-residency obligation, so it is configuration rather than a constant.
import { createSign } from 'node:crypto';
import {
  type ChatRequest, type ChatResponse, type LlmProvider,
} from '../types.js';
import { safeFetch, type SafeFetchOptions } from '../ssrf.js';
import { geminiContents, geminiEnvelope, readGeminiResponse } from './gemini.js';
import { configFailure, errorCodeFrom, httpFailure, parseJson, transportFailure } from './shared.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Tokens last an hour. Renewed early so a request never races the expiry. */
const RENEW_BEFORE_MS = 60_000;

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface VertexAiOptions {
  model: string;
  project: string;
  location: string;
  serviceAccount: ServiceAccount;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  now?: () => number;
}

/** Parses the JSON key file an operator pasted in.
 *
 * Refuses rather than guesses. A key file missing `client_email` or
 * `private_key` cannot sign anything, and finding that out at the first real
 * request — after setup has said "saved" — is the failure this avoids. */
export function readServiceAccount(raw: string): ServiceAccount {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw configFailure('that service account key is not valid JSON. Paste the whole file, including the braces.');
  }
  const email = parsed.client_email;
  const key = parsed.private_key;
  if (typeof email !== 'string' || !email) {
    throw configFailure('that service account key has no client_email, so Josi cannot sign in with it.');
  }
  if (typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw configFailure('that service account key has no private_key, so Josi cannot sign in with it.');
  }
  return {
    client_email: email,
    private_key: key,
    project_id: typeof parsed.project_id === 'string' ? parsed.project_id : undefined,
  };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A signed JWT asserting "this service account would like a token". */
export function serviceAccountAssertion(account: ServiceAccount, nowMs: number): string {
  const issued = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: issued,
    exp: issued + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(account.private_key);
  return `${signingInput}.${base64Url(signature)}`;
}

interface CachedToken { token: string; expiresAtMs: number }

/** Mints and caches an access token for one service account.
 *
 * Cached per provider instance rather than globally: a token is scoped to the
 * credential that produced it, and a cache keyed by anything less specific
 * would let one installation's configuration change go unnoticed until the
 * hour was up. */
export function tokenSource(opts: VertexAiOptions): () => Promise<string> {
  let cached: CachedToken | null = null;

  return async function accessToken(): Promise<string> {
    const now = opts.now?.() ?? Date.now();
    if (cached && cached.expiresAtMs - RENEW_BEFORE_MS > now) return cached.token;

    const assertion = serviceAccountAssertion(opts.serviceAccount, now);
    let res: Response;
    try {
      res = await safeFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
    } catch (err) {
      throw transportFailure(err);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // Google answers 400 for a malformed or clock-skewed assertion and 401
      // for a key that has been revoked. Both mean the stored credential
      // cannot be used, so both are told as an authentication problem rather
      // than as the generic bad-request they arrive as.
      throw httpFailure(res.status === 400 ? 401 : res.status, errorCodeFrom(text));
    }

    const parsed = parseJson<{ access_token?: string; expires_in?: number }>(text, res.status);
    if (!parsed.access_token) {
      throw configFailure('Google returned no access token for that service account.', 'authentication');
    }
    cached = {
      token: parsed.access_token,
      expiresAtMs: now + (parsed.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}

/** The regional host. `global` has no prefix, every other location does. */
export function vertexHost(location: string): string {
  return location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
}

export function vertexAiProvider(opts: VertexAiOptions): LlmProvider {
  if (!opts.project) throw configFailure('this provider needs the Google Cloud project its model access is in');
  if (!opts.location) throw configFailure('this provider needs the Google Cloud location its model access is in');

  const accessToken = tokenSource(opts);
  const host = vertexHost(opts.location);

  return {
    kind: 'vertex_ai',
    model: opts.model,
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = { contents: geminiContents(request), ...geminiEnvelope(request) };
      const token = await accessToken();

      const url = `https://${host}/v1/projects/${encodeURIComponent(opts.project)}`
        + `/locations/${encodeURIComponent(opts.location)}/publishers/google/models/`
        + `${encodeURIComponent(opts.model)}:generateContent`;

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        throw transportFailure(err);
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) throw httpFailure(res.status, errorCodeFrom(text));

      return readGeminiResponse(parseJson(text, res.status), latencyMs);
    },
  };
}

/** Proves a service account can actually mint a token.
 *
 * Called during discovery, where there is no model list to fetch: the useful
 * question at that point is not "which models exist" — Vertex offers the same
 * published set to everyone — but "will this credential work at all", and that
 * is answerable without spending a model call. */
export async function verifyVertexCredential(opts: VertexAiOptions): Promise<void> {
  await tokenSource(opts)();
}
