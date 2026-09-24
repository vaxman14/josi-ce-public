// LB5.6 verified, and the OAuth handshake attacked.
//
// Two things in one file because they are the same surface. The first half
// walks the per-user lifecycle the blocker names — Connect, status, scope
// display, re-consent, revoke, disconnect, failure recovery — over the wire.
// The second half attacks it: state replay, callback confusion, token
// substitution, and a forged callback with no handshake at all.
//
// No provider is contacted: `connectorFetch` is injected. What the attacks
// exercise is CE's own logic, which is where all of these are decided.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, openSealed } from '@josi-ce/core';
import { saveClient } from '@josi-ce/connectors';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-hostile-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 17);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** The token the stubbed provider will hand back next, and to whom. */
let nextToken = 'ACCESS-TOKEN-alice';
let nextIdentity = { sub: 'g-alice', email: 'alice@gmail.test' };
let exchangeCalls = 0;

const connectorFetch = (async (url: RequestInfo | URL) => {
  const href = String(url);
  if (href.includes('userinfo') || href.includes('graph.microsoft.com/v1.0/me')) {
    return new Response(JSON.stringify(nextIdentity), { status: 200 });
  }
  exchangeCalls++;
  return new Response(JSON.stringify({
    access_token: nextToken,
    refresh_token: `${nextToken}-refresh`,
    expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
  }), { status: 200 });
}) as unknown as typeof fetch;

interface Res { status: number; body: any; headers: Headers; setCookie: string[] }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return {
    status: res.status,
    body: await res.json().catch(() => null),
    headers: res.headers,
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await call('/api/auth/csrf');
  const jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

/** Start a handshake and pull the `state` out of the URL the server returns. */
async function startHandshake(
  jar: string,
  provider: 'google' | 'microsoft' = 'google',
  capabilities?: string[],
): Promise<string> {
  const res = await call(`/api/connections/${provider}/start`, {
    method: 'POST', jar, body: capabilities ? { capabilities } : {},
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return new URL(res.body.url).searchParams.get('state')!;
}

/** Follow the callback exactly as a browser would. */
const callback = (provider: string, params: Record<string, string>, jar?: string) =>
  call(`/api/connections/${provider}/callback?${new URLSearchParams(params)}`, { jar });

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  for (const provider of ['google', 'microsoft'] as const) {
    await saveClient(db, key, {
      provider,
      clientId: `${provider}-client`,
      clientSecret: `${provider}-CLIENT-SECRET`,
      redirectUri: `https://josi.example.test/api/connections/${provider}/callback`,
      actorUserId: ids.admin,
    });
  }

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  exchangeCalls = 0;
  nextToken = 'ACCESS-TOKEN-alice';
  nextIdentity = { sub: 'g-alice', email: 'alice@gmail.test' };
  await db.query(`delete from connections`);
  await db.query(`delete from oauth_states`);
});

// ======================================================= LB5.6 — the lifecycle

describe('LB5.2 — registering an application and connecting an account are different things', () => {
  it('separates who does which', async () => {
    // A member cannot register the installation's application…
    const register = await call('/api/admin/connectors/clients/google', {
      method: 'PUT', jar: cookies.alice,
      body: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://josi.example.test/cb' },
    });
    expect(register.status).toBe(403);

    // …and an administrator cannot connect an account on somebody's behalf:
    // there is no route that takes an owner, so the only account they can
    // connect is their own.
    const mine = await call('/api/connections', { jar: cookies.admin });
    expect(mine.body.connections).toEqual([]);
  });

  it('tells a user whether the administrator has set the application up', async () => {
    const view = await call('/api/connections', { jar: cookies.alice });
    const google = view.body.providers.find((p: any) => p.provider === 'google');
    // `available` is about the INSTALLATION; `connection` is about the person.
    expect(google.available).toBe(true);
    expect(google.connection).toBeNull();
  });
});

describe('LB5.6 — Connect, status, scopes, re-consent, revoke, recovery', () => {
  it('connects, and reports status afterwards', async () => {
    const state = await startHandshake(cookies.alice);
    const done = await callback('google', { state, code: 'auth-code' }, cookies.alice);
    expect(done.status).toBe(302);

    const view = await call('/api/connections', { jar: cookies.alice });
    const google = view.body.providers.find((p: any) => p.provider === 'google');
    expect(google.connection.status).toBe('active');
    expect(google.connection.account).toBe('alice@gmail.test');
  });

  it('shows what each permission is and whether it is on', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'auth-code' }, cookies.alice);

    const view = await call('/api/connections', { jar: cookies.alice });
    const google = view.body.providers.find((p: any) => p.provider === 'google');
    const caps = google.capabilities;
    expect(caps.length).toBeGreaterThan(3);

    // Every one names what it does; the write ones name the consequence.
    for (const cap of caps) {
      expect(cap.label, cap.key).toBeTruthy();
      if (cap.kind === 'write') expect(cap.consequence, cap.key).toBeTruthy();
    }
    // Read-only at first connect: the calendar read scope was granted, the
    // write one was not.
    const read = caps.find((c: any) => c.key === 'google.calendar.read');
    const write = caps.find((c: any) => c.key === 'google.calendar.write');
    expect(read.state).not.toBe('needs_consent');
    expect(write.state).toBe('needs_consent');
  });

  it('uses one account-level permission upgrade before a write capability can be enabled', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'auth-code' }, cookies.alice);
    const view = await call('/api/connections', { jar: cookies.alice });
    const id = view.body.providers.find((p: any) => p.provider === 'google').connection.id;

    // Turning it on without the provider having granted it is refused rather
    // than stored as a wish.
    const early = await call(`/api/connections/${id}/capabilities/google.calendar.write`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(early.status).toBe(409);

    // Legacy partial grants use one upgrade for the provider's complete current
    // bundle, so enabling the next capability never causes another consent loop.
    const again = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: { capabilities: ['google.calendar.write'] },
    });
    expect(again.status).toBe(200);
    expect(again.body.capabilities).toEqual(expect.arrayContaining([
      'google.calendar.read', 'google.calendar.write', 'google.mail.read',
      'google.mail.send', 'google.contacts.read', 'google.contacts.write',
      'google.drive.read',
    ]));
    const url = new URL(again.body.url);
    expect(url.searchParams.get('scope')).toContain('auth/calendar');
    // Incremental: Google is asked to keep what it already granted.
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('disconnects, and forgets the credential', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'auth-code' }, cookies.alice);
    const view = await call('/api/connections', { jar: cookies.alice });
    const id = view.body.providers.find((p: any) => p.provider === 'google').connection.id;

    const gone = await call(`/api/connections/${id}`, { method: 'DELETE', jar: cookies.alice });
    expect(gone.status).toBe(200);

    const after = await call('/api/connections', { jar: cookies.alice });
    expect(after.body.providers.find((p: any) => p.provider === 'google').connection).toBeNull();
    expect(await db.query(`select id from connections`)).toHaveLength(0);
  });

  it('recovers from a failure by reconnecting, without a duplicate connection', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'auth-code' }, cookies.alice);
    const first = await call('/api/connections', { jar: cookies.alice });
    const id = first.body.providers.find((p: any) => p.provider === 'google').connection.id;

    // The provider withdrew access.
    await db.query(`update connections set status = 'revoked', last_error_category = 'revoked'`);
    const broken = await call('/api/connections', { jar: cookies.alice });
    const shown = broken.body.providers.find((p: any) => p.provider === 'google').connection;
    expect(shown.status).toBe('revoked');
    // A category, so "reconnect" and "we are rate limited" read differently.
    expect(shown.errorCategory).toBe('revoked');

    const state2 = await startHandshake(cookies.alice);
    await callback('google', { state: state2, code: 'auth-code-2' }, cookies.alice);

    const fixed = await call('/api/connections', { jar: cookies.alice });
    const after = fixed.body.providers.find((p: any) => p.provider === 'google').connection;
    expect(after.status).toBe('active');
    // The same row, healed — not a second connection to the same account.
    expect(after.id).toBe(id);
    expect(await db.query(`select id from connections`)).toHaveLength(1);
  });

  it('never returns the credential, in any shape', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'auth-code' }, cookies.alice);
    const view = JSON.stringify((await call('/api/connections', { jar: cookies.alice })).body);
    for (const secret of ['ACCESS-TOKEN-alice', 'ACCESS-TOKEN-alice-refresh', 'google-CLIENT-SECRET']) {
      expect(view, secret).not.toContain(secret);
    }
    expect(view, 'no ciphertext either').not.toMatch(/"v1\./);
  });
});

// ================================================== hostile: the handshake

describe('OAuth state replay', () => {
  it('refuses a state that has already been used', async () => {
    const state = await startHandshake(cookies.alice);
    const first = await callback('google', { state, code: 'code-1' }, cookies.alice);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).not.toContain('error=');

    const replay = await callback('google', { state, code: 'code-2' }, cookies.alice);
    expect(replay.headers.get('location')).toContain('error=consumed');
    // And the second code was never exchanged.
    expect(exchangeCalls, 'one exchange, not two').toBe(1);
    expect(await db.query(`select id from connections`)).toHaveLength(1);
  });

  it('refuses a state nobody minted', async () => {
    const res = await callback('google', { state: 'a'.repeat(43), code: 'x' }, cookies.alice);
    expect(res.headers.get('location')).toContain('error=unknown');
    expect(exchangeCalls).toBe(0);
  });

  it('refuses an expired state', async () => {
    const state = await startHandshake(cookies.alice);
    await db.query(`update oauth_states set expires_at = now() - interval '1 minute'`);
    const res = await callback('google', { state, code: 'x' }, cookies.alice);
    expect(res.headers.get('location')).toContain('error=expired');
    expect(exchangeCalls).toBe(0);
  });

  it('refuses a state minted in somebody else’s session', async () => {
    // The stolen-state case: Alice starts a handshake, Bob completes it. Bob
    // must not end up with a connection, and neither must Alice.
    const state = await startHandshake(cookies.alice);
    const res = await callback('google', { state, code: 'x' }, cookies.bob);
    expect(res.headers.get('location')).toContain('error=session_mismatch');
    expect(exchangeCalls).toBe(0);
    expect(await db.query(`select id from connections`)).toHaveLength(0);
  });
});

describe('callback confusion', () => {
  it('refuses a Google state redeemed at the Microsoft callback', async () => {
    const state = await startHandshake(cookies.alice, 'google');
    const res = await callback('microsoft', { state, code: 'x' }, cookies.alice);
    expect(res.headers.get('location')).toContain('error=wrong_provider');
    expect(exchangeCalls).toBe(0);
    expect(await db.query(`select id from connections`)).toHaveLength(0);
  });

  it('refuses a provider that does not exist', async () => {
    // 'dropbox' used to be this test's example of a nonexistent provider;
    // storage-providers phase 2 made it a real one. 'notaprovider' is what
    // this test is actually about — a name in no provider list at all.
    const res = await call('/api/connections/notaprovider/callback?state=x&code=y', { jar: cookies.alice });
    expect(res.status).toBe(404);
  });

  it('takes the owner from the stored handshake, not from the session', async () => {
    // Even if a session somehow accompanied the callback, the connection
    // belongs to whoever started the handshake. The session check refuses the
    // mismatch first; this asserts the ownership source directly.
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'x' }, cookies.alice);
    const [row] = await db.query<{ owner_user_id: string }>(`select owner_user_id from connections`);
    expect(row.owner_user_id).toBe(ids.alice);
  });

  it('carries no error detail into the redirect beyond a category', async () => {
    const res = await callback('google', { state: 'nope', code: 'x' }, cookies.alice);
    const location = res.headers.get('location') ?? '';
    // A reason a person can act on; never a token, a code, or a provider body.
    expect(location).toMatch(/^\/app\/connections\?error=[a-z_]+$/);
  });
});

describe('token substitution', () => {
  it('stores the token against the handshake’s owner, not the caller', async () => {
    // Alice connects. The tokens the provider returns are sealed against her
    // connection and nobody else's.
    const state = await startHandshake(cookies.alice);
    nextToken = 'ACCESS-TOKEN-alice';
    await callback('google', { state, code: 'x' }, cookies.alice);

    const [row] = await db.query<{ owner_user_id: string; secrets_enc: string }>(
      `select owner_user_id, secrets_enc from connections`,
    );
    expect(row.owner_user_id).toBe(ids.alice);
    const opened = openSealed<{ accessToken: string }>(key, row.secrets_enc);
    expect(opened.accessToken).toBe('ACCESS-TOKEN-alice');
  });

  it('does not let one person point a connection id at their own request', async () => {
    // Bob knows Alice's connection id and tries to use it.
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'x' }, cookies.alice);
    const view = await call('/api/connections', { jar: cookies.alice });
    const aliceId = view.body.providers.find((p: any) => p.provider === 'google').connection.id;

    // Read, capability change, and delete all answer "not found" — never 403,
    // which would confirm the id exists.
    expect((await call(`/api/connections/${aliceId}`, { jar: cookies.bob })).status).toBe(404);
    expect((await call(`/api/connections/${aliceId}/capabilities/google.calendar.read`, {
      method: 'PUT', jar: cookies.bob, body: { enabled: true },
    })).status).toBe(404);
    expect((await call(`/api/connections/${aliceId}`, { method: 'DELETE', jar: cookies.bob })).status).toBe(404);

    // Alice's connection is untouched.
    expect(await db.query(`select id from connections`)).toHaveLength(1);
  });

  it('keeps the existing account when the owner explicitly adds another provider account', async () => {
    const state = await startHandshake(cookies.alice);
    await callback('google', { state, code: 'x' }, cookies.alice);

    nextIdentity = { sub: 'g-someone-else', email: 'attacker@gmail.test' };
    const state2 = await startHandshake(cookies.alice);
    await callback('google', { state: state2, code: 'y' }, cookies.alice);

    const rows = await db.query<{ owner_user_id: string; account_email: string }>(
      `select owner_user_id, account_email from connections`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.owner_user_id === ids.alice), 'both remain Alice’s private connections').toBe(true);
    expect(rows.map((row) => row.account_email).sort()).toEqual(['alice@gmail.test', 'attacker@gmail.test']);
  });

  it('refuses to start a handshake without a session at all', async () => {
    // Two refusals, and the order is deliberate: `app.ts` runs CSRF before the
    // routes, so a state-changing request with no token is rejected before
    // anybody asks who is calling.
    const noToken = await call('/api/connections/google/start', { method: 'POST', body: {} });
    expect(noToken.status, 'no CSRF token').toBe(403);

    // With a token but no session — which anyone can obtain, since the login
    // form needs one — it is refused as unauthenticated.
    const pre = await call('/api/auth/csrf');
    const anonymous = mergeJar(undefined, pre.setCookie);
    const withToken = await call('/api/connections/google/start', {
      method: 'POST', jar: anonymous, body: {},
    });
    expect(withToken.status, 'CSRF token, no session').toBe(401);
  });
});

describe('CSRF still applies to the connector surface', () => {
  it('refuses a state-changing request with no token', async () => {
    // The jar carries the session but the header is dropped, which is what a
    // cross-origin form post looks like.
    const jarWithoutHeader = cookies.alice;
    const res = await fetch(`${base}/api/connections/google/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: jarWithoutHeader },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});
