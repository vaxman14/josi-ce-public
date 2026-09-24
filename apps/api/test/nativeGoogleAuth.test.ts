import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MasterKey } from '@josi-ce/core';
import { saveClient } from '@josi-ce/connectors';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-native-google-'));
const keyPath = join(dir, 'master.key');
const keyBytes = Buffer.alloc(32, 29);
writeFileSync(keyPath, keyBytes.toString('base64'));

let db: TestDb;
let server: Server;
let base: string;
let userId: string;
let providerCalls = 0;

const connectorFetch = (async (url: RequestInfo | URL) => {
  providerCalls += 1;
  if (String(url).includes('userinfo')) {
    return new Response(JSON.stringify({ sub: 'google-linked-1', email: 'linked@google.test' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ access_token: 'access-token', scope: 'openid email profile' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { redirect: 'manual', ...init });
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  // APP_URL is the authoritative browser origin. Keep a deliberately stale
  // deployment_config value here so native enrollment cannot regress to the
  // legacy domain-only reconstruction used by password-reset links.
  await db.query(`update deployment_config set domain = 'stale-native.ce.test' where id = true`);
  userId = (await createUser(db, {
    email: 'member@ce.test', username: 'member', role: 'member', password: 'member-password-123',
  })).id;
  await db.query(
    `insert into connections
       (owner_user_id, provider, status, provider_account_id, account_email, granted_scopes, secrets_enc)
     values ($1, 'google', 'active', 'google-linked-1', 'linked@google.test', 'openid email profile', 'sealed-test')`,
    [userId],
  );
  await saveClient(db, new MasterKey(keyBytes), {
    provider: 'google', clientId: 'client-id', clientSecret: 'client-secret',
    redirectUri: 'http://localhost:3000/api/auth/google/callback',
  });
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'https://native.ce.test', masterKeyCheck: { path: keyPath }, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('native Google authentication', () => {
  it('publishes non-secret enrollment metadata', async () => {
    const res = await request('/api/auth/native/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as any;
    expect(body).toEqual({
      appUrl: 'https://native.ce.test',
      googleSignIn: true,
      appleSignIn: false,
      nativeGoogleStart: 'https://native.ce.test/api/auth/google/native/start',
      enrollmentDeepLink: 'josi://enroll?server=https%3A%2F%2Fnative.ce.test',
    });
    expect(JSON.stringify(body)).not.toContain('client-secret');
  });

  it('allows only the exact app callback', async () => {
    for (const redirect of [
      'https://attacker.test/callback', 'josi://evil/callback',
      'josi://auth/callback/extra', 'josi://auth/callback?next=https://attacker.test',
    ]) {
      const res = await request(`/api/auth/google/native/start?redirect_uri=${encodeURIComponent(redirect)}`);
      expect(res.status, redirect).toBe(400);
      expect(providerCalls, redirect).toBe(0);
    }
  });

  it('returns a short-lived code, exchanges it once, and refuses replay', async () => {
    const started = await request('/api/auth/google/native/start?redirect_uri=josi%3A%2F%2Fauth%2Fcallback');
    expect(started.status).toBe(302);
    const google = new URL(started.headers.get('location')!);
    const state = google.searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const callback = await request(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`);
    expect(callback.status).toBe(302);
    const deepLink = new URL(callback.headers.get('location')!);
    expect(`${deepLink.protocol}//${deepLink.host}${deepLink.pathname}`).toBe('josi://auth/callback');
    expect(deepLink.searchParams.get('state')).toBe(state);
    const code = deepLink.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(callback.headers.get('location')).not.toContain('sessionToken');
    const [stored] = await db.query<{ code_hash: string }>(`select code_hash from auth_native_codes where used_at is null`);
    expect(stored.code_hash).not.toBe(code);
    expect(stored.code_hash).toMatch(/^[a-f0-9]{64}$/);

    const callsBeforeReplay = providerCalls;
    const callbackReplay = await request(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`);
    expect(callbackReplay.headers.get('location')).toContain('google_signin_expired');
    expect(providerCalls).toBe(callsBeforeReplay);

    const exchange = await request('/api/auth/google/native/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native' },
      body: JSON.stringify({ code }),
    });
    expect(exchange.status).toBe(200);
    const body = await exchange.json() as any;
    expect(body.user.id).toBe(userId);
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const me = await request('/api/auth/me', {
      headers: { 'x-josi-client': 'native', authorization: `Bearer ${body.sessionToken}` },
    });
    expect(me.status).toBe(200);

    const replay = await request('/api/auth/google/native/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native' },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
  });

  it('refuses an expired native code', async () => {
    const expired = 'expired-native-code-that-was-once-valid';
    const { createHash } = await import('node:crypto');
    await db.query(
      `insert into auth_native_codes (code_hash, user_id, expires_at)
       values ($1, $2, now() - interval '1 second')`,
      [createHash('sha256').update(expired).digest('hex'), userId],
    );
    const exchange = await request('/api/auth/google/native/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native' },
      body: JSON.stringify({ code: expired }),
    });
    expect(exchange.status).toBe(401);
    const [stored] = await db.query<{ used_at: string | null }>(
      `select used_at from auth_native_codes where code_hash = $1`,
      [createHash('sha256').update(expired).digest('hex')],
    );
    expect(stored.used_at).toBeNull();
  });

  it('does not issue a code for an unlinked Google identity', async () => {
    await db.query(`update connections set status = 'revoked' where owner_user_id = $1`, [userId]);
    const started = await request('/api/auth/google/native/start?redirect_uri=josi%3A%2F%2Fauth%2Fcallback');
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const callback = await request(`/api/auth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`);
    const deepLink = new URL(callback.headers.get('location')!);
    expect(deepLink.searchParams.get('error')).toBe('google_not_linked');
    expect(deepLink.searchParams.get('code')).toBeNull();
    await db.query(`update connections set status = 'active' where owner_user_id = $1`, [userId]);
  });

  it('returns provider cancellation to the native app without a code', async () => {
    const callsBefore = providerCalls;
    const started = await request('/api/auth/google/native/start?redirect_uri=josi%3A%2F%2Fauth%2Fcallback');
    const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
    const callback = await request(`/api/auth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    const deepLink = new URL(callback.headers.get('location')!);
    expect(deepLink.searchParams.get('error')).toBe('google_declined');
    expect(deepLink.searchParams.get('state')).toBe(state);
    expect(deepLink.searchParams.get('code')).toBeNull();
    expect(providerCalls).toBe(callsBefore);
  });

  it('requires a native-shaped client for code exchange', async () => {
    const csrf = await request('/api/auth/csrf');
    const cookies = csrf.headers.getSetCookie();
    const token = /josi_csrf=([^;]+)/.exec(cookies.join(';'))?.[1] ?? '';
    const res = await request('/api/auth/google/native/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies.map((v) => v.split(';')[0]).join('; '), 'x-josi-csrf': token },
      body: JSON.stringify({ code: 'made-up' }),
    });
    expect(res.status).toBe(403);
  });
});
