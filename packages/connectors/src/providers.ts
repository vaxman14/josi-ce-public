// Google, Microsoft, Dropbox and Box, over fetch.
//
// No provider SDK. The whole surface is three or four URLs each, and a plain
// fetch keeps the image small, the failure modes visible, and the supply
// chain short — which matters more for software strangers run on their own
// hardware than for a hosted service.
//
// Nextcloud is not here. It is not an OAuth provider — see `OAUTH_PROVIDERS`
// in capabilities.ts — and everything in this file is the OAuth2 dance:
// authorize URL, code exchange, refresh, revoke. Its WebDAV + app-password
// client lives in `providers/webdav.ts`.
//
// NOTHING HERE LOGS A TOKEN, A CODE, OR A PROVIDER BODY. Provider error bodies
// quote the request that caused them, and a request to a mail API quotes mail.
// Failures are turned into a CATEGORY the operator can act on and nothing else.
import type { OAuthProvider, Provider } from './capabilities.js';

export class ConnectorError extends Error {
  /** What an operator can do about it. Never the provider's own text. */
  category: ErrorCategory = 'provider_error';
  /** The grant is gone — reconnecting fixes it, retrying does not. */
  revoked = false;
  status?: number;
  retryAfterSeconds?: number;

  constructor(message: string, init: Partial<Pick<ConnectorError, 'category' | 'revoked' | 'status' | 'retryAfterSeconds'>> = {}) {
    super(message);
    Object.assign(this, init);
  }
}

export type ErrorCategory =
  | 'revoked'
  | 'expired'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'provider_error'
  | 'network';

export interface ProviderEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** Who the tokens belong to. Asked once, at connect time. */
  identityUrl: string;
}

export const ENDPOINTS: Record<OAuthProvider, ProviderEndpoints> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    identityUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  microsoft: {
    // `common` lets both work and personal accounts connect. An operator whose
    // tenant should be restricted registers a single-tenant application and
    // Microsoft enforces it at their end, which is the right place for it.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    identityUrl: 'https://graph.microsoft.com/v1.0/me',
  },
  dropbox: {
    authUrl: 'https://www.dropbox.com/oauth2/authorize',
    tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
    // Dropbox has no OAuth-standard revoke endpoint; disconnecting works the
    // same way it does for Microsoft — the local copy goes and the person
    // finishes the job in their Dropbox account settings if they want to.
    identityUrl: 'https://api.dropboxapi.com/2/users/get_current_account',
  },
  box: {
    authUrl: 'https://account.box.com/api/oauth2/authorize',
    tokenUrl: 'https://api.box.com/oauth2/token',
    revokeUrl: 'https://api.box.com/oauth2/revoke',
    identityUrl: 'https://api.box.com/2.0/users/me',
  },
};

export interface OAuthClient {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Seconds from now. */
  expiresIn: number | null;
  /** What the provider GRANTED, which is not always what was requested. */
  grantedScopes: string;
}

export interface Identity {
  accountId: string | null;
  email: string | null;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function buildAuthUrl(
  client: OAuthClient,
  args: { state: string; scopes: string; codeChallenge?: string },
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    response_type: 'code',
    redirect_uri: client.redirectUri,
    scope: args.scopes,
    state: args.state,
  });

  if (client.provider === 'google') {
    // `offline` is what asks for a refresh token; `consent` is what makes
    // Google hand one over on a RE-auth rather than assuming we kept the first.
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
    // Incremental authorization: a second handshake keeps what was already
    // granted instead of silently narrowing the connection to the new scopes.
    params.set('include_granted_scopes', 'true');
  } else if (client.provider === 'microsoft') {
    // Microsoft's equivalent: force the consent screen so an added scope is
    // actually shown to the person rather than granted silently.
    params.set('prompt', 'consent');
  } else if (client.provider === 'dropbox') {
    // `token_access_type=offline` is Dropbox's name for the same thing Google
    // calls `access_type=offline`: without it, the code exchange returns an
    // access token with no refresh token at all, and the connection dies the
    // moment the short-lived token expires.
    params.set('token_access_type', 'offline');
  } else if (client.provider === 'box') {
    // Box has no consent-forcing parameter to set — its consent screen shows
    // every requested scope on every authorization, which is the property the
    // other providers' flags exist to force.
  }

  if (args.codeChallenge) {
    params.set('code_challenge', args.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${ENDPOINTS[client.provider].authUrl}?${params}`;
}

/** Turns a provider's failure into something an operator can act on.
 *
 * Deliberately does not include the body. `invalid_grant` is the one worth
 * naming precisely: it means the grant is gone — revoked, password changed,
 * refresh token aged out — and the fix is to reconnect, not to retry. */
function classify(status: number, error: string): { category: ErrorCategory; revoked: boolean } {
  if (error === 'invalid_grant') return { category: 'revoked', revoked: true };
  if (error === 'insufficient_scope' || status === 403) return { category: 'insufficient_scope', revoked: false };
  if (status === 429) return { category: 'rate_limited', revoked: false };
  if (status === 401) return { category: 'expired', revoked: false };
  return { category: 'provider_error', revoked: false };
}

async function postForm(
  url: string,
  body: URLSearchParams,
  opts: FetchOptions,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof payload.error === 'string' ? payload.error : '';
      const { category, revoked } = classify(res.status, error);
      // The message names the category and the status. Not the body.
      throw new ConnectorError(`the provider refused the request (${category})`, {
        category, revoked, status: res.status,
      });
    }
    return payload;
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError('could not reach the provider', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

function toTokenSet(payload: Record<string, unknown>, requestedScopes: string): TokenSet {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    throw new ConnectorError('the provider returned no access token', { category: 'provider_error' });
  }
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : null,
    // What was GRANTED. Microsoft echoes `scope`; Google usually does. When a
    // provider says nothing we fall back to what we asked for, and the
    // capability check treats a missing scope as absent either way.
    grantedScopes: typeof payload.scope === 'string' ? payload.scope : requestedScopes,
  };
}

export async function exchangeCode(
  client: OAuthClient,
  args: { code: string; verifier?: string | null; scopes: string },
  opts: FetchOptions = {},
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: args.code,
    grant_type: 'authorization_code',
    redirect_uri: client.redirectUri,
  });
  if (args.verifier) body.set('code_verifier', args.verifier);
  return toTokenSet(await postForm(ENDPOINTS[client.provider].tokenUrl, body, opts), args.scopes);
}

export async function refreshTokens(
  client: OAuthClient,
  args: { refreshToken: string; scopes: string },
  opts: FetchOptions = {},
): Promise<TokenSet> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: 'refresh_token',
  });
  const set = toTokenSet(await postForm(ENDPOINTS[client.provider].tokenUrl, body, opts), args.scopes);
  // Google does not return a new refresh token on refresh. Keeping the old one
  // is the caller's job, and `null` here says so rather than implying it is gone.
  return set;
}

export async function fetchIdentity(
  provider: OAuthProvider,
  accessToken: string,
  opts: FetchOptions = {},
): Promise<Identity> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    // Dropbox's identity call is a POST with an empty JSON body — the one
    // outlier among four otherwise-GET identity endpoints. Everyone else is a
    // bearer-token GET.
    const res = await (opts.fetchImpl ?? fetch)(ENDPOINTS[provider].identityUrl, {
      method: provider === 'dropbox' ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(provider === 'dropbox' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(provider === 'dropbox' ? { body: 'null' } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const { category, revoked } = classify(res.status, '');
      throw new ConnectorError('could not read the account identity', { category, revoked, status: res.status });
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const pick = (...keys: string[]): string | null => {
      for (const key of keys) {
        const value = payload[key];
        if (typeof value === 'string' && value) return value;
      }
      return null;
    };
    // Dropbox nests its account id and email under `account_id` /
    // `email`/`name`; Box answers `id`/`login` (Box's word for the email
    // address); Google and Microsoft are the existing `sub`/`id` and
    // `email`/`mail`/`userPrincipalName` pairs.
    return {
      accountId: pick('sub', 'id', 'account_id'),
      email: pick('email', 'mail', 'userPrincipalName', 'login'),
    };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError('could not reach the provider', { category: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort revocation at the provider.
 *
 * Google and Box have an endpoint; Microsoft and Dropbox do not offer a
 * per-application one, so disconnecting there means deleting our copy and
 * telling the person where to finish the job. Saying so is better than a
 * button that silently does half of what it claims. */
export async function revokeAtProvider(
  client: OAuthClient,
  refreshToken: string,
  opts: FetchOptions = {},
): Promise<{ revokedRemotely: boolean; note?: string }> {
  const endpoint = ENDPOINTS[client.provider].revokeUrl;
  if (!endpoint) {
    const label = client.provider === 'dropbox' ? 'Dropbox' : 'Microsoft';
    return {
      revokedRemotely: false,
      note: `${label} has no per-application revoke endpoint. Josi has deleted its copy of the tokens; `
        + `to withdraw the grant entirely, remove Josi from your ${label} account permissions.`,
    };
  }
  try {
    const response = await (opts.fetchImpl ?? fetch)(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (!response.ok) throw new Error('Provider refused revocation');
    return { revokedRemotely: true };
  } catch {
    // The local copy is deleted regardless. A provider we could not reach must
    // not stop someone disconnecting.
    return {
      revokedRemotely: false,
      note: 'Josi deleted its copy of the tokens but could not reach the provider to revoke them.',
    };
  }
}
