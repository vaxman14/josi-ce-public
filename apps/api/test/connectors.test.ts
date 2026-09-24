// Connectors over the wire.
//
// The four acceptance criteria the phase plan names, attacked directly:
//
//   1. admin endpoints return no message/event content
//   2. a user cannot act on another user's connection
//   3. enabling send forces re-consent
//   4. admin tightening overrides user preference; admin loosening is refused
//
// No provider is contacted: `connectorFetch` is injected into the app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, seal, initializeVault } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-connectors-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 11);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const CLIENT_SECRET = 'OPERATOR-CLIENT-SECRET-value';
const ACCESS_TOKEN = 'PROVIDER-ACCESS-TOKEN-value';
const REFRESH_TOKEN = 'PROVIDER-REFRESH-TOKEN-value';
const ACCOUNT = 'alices.private.mailbox@gmail.test';

/** What the stubbed provider returns next. */
let tokenResponse: { scope: string } = { scope: 'https://www.googleapis.com/auth/calendar.readonly' };
let providerCalls: string[] = [];
let onRevoke: (()=>Promise<void>) | undefined;

const connectorFetch = (async (url: RequestInfo | URL) => {
  const href = String(url);
  providerCalls.push(href);
  if(href.includes("/revoke") && onRevoke) await onRevoke();
  if (href.includes('/users/me/calendarList')) {
    return new Response(JSON.stringify({ items: [
      { id: 'primary@example.test', summary: 'Primary', primary: true, accessRole: 'owner', backgroundColor: '#123456' },
      { id: 'kids@example.test', summary: 'Vaxman Kids', accessRole: 'reader', backgroundColor: '#654321' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (href.includes('/calendar/v3/calendars/')) {
    return new Response(JSON.stringify({ items: [{ id: 'event-1', summary: 'Dentist', start: { dateTime: '2026-09-15T17:00:00Z' }, end: { dateTime: '2026-09-15T18:00:00Z' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (href.includes('userinfo') || href.includes('graph.microsoft.com')) {
    return new Response(JSON.stringify({ sub: 'g-account-1', email: ACCOUNT }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN,
      expires_in: 3600, scope: tokenResponse.scope,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

interface Res { status: number; body: any; headers: Headers; setCookie: string[] }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string; redirect?: 'manual' | 'follow' } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: opts.redirect ?? 'manual',
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
  let jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

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
  onRevoke=undefined;
  providerCalls = [];
  tokenResponse = { scope: 'https://www.googleapis.com/auth/calendar.readonly' };
  await db.query(`delete from connection_capabilities`);
  await db.query(`delete from connections`);
  await db.query(`delete from oauth_states`);
  await db.query(`delete from oauth_clients`);
  await db.query(`delete from admin_capability_policy`);
});

async function configureClient(): Promise<void> {
  await call('/api/admin/connectors/clients/google', {
    method: 'PUT', jar: cookies.admin,
    body: {
      clientId: 'operator-client-id',
      clientSecret: CLIENT_SECRET,
      redirectUri: 'http://localhost:3000/api/connections/google/callback',
    },
  });
}

/** Drives a real handshake to completion for `who`, granting `scope`. */
async function connect(who: 'alice' | 'bob', capabilities: string[] = [], scope?: string) {
  if (scope) tokenResponse = { scope };
  const started = await call('/api/connections/google/start', {
    method: 'POST', jar: cookies[who], body: { capabilities },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const state = new URL(started.body.url).searchParams.get('state')!;
  const cb = await call(`/api/connections/google/callback?state=${encodeURIComponent(state)}&code=abc`, {
    jar: cookies[who],
  });
  expect(cb.status).toBe(302);
  const [row] = await db.query<{ id: string }>(
    `select id from connections where owner_user_id = $1`, [ids[who]],
  );
  return row.id;
}

describe('the operator OAuth application', () => {
  it('is required before anyone can connect', async () => {
    const res = await call('/api/connections/google/start', { method: 'POST', jar: cookies.alice, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no google application is configured/i);
  });

  it('is configured by the admin, and the secret never comes back', async () => {
    await configureClient();
    const view = await call('/api/admin/connectors', { jar: cookies.admin });
    const dump = JSON.stringify(view.body);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).toContain('operator-client-id');
    expect(view.body.clients.find((c: any) => c.provider === 'google').configured).toBe(true);

    const [row] = await db.query<{ client_secret_enc: string }>(
      `select client_secret_enc from oauth_clients where provider = 'google'`,
    );
    expect(row.client_secret_enc).not.toContain(CLIENT_SECRET);
  });

  it('never returns the CIPHERTEXT of the secret either', async () => {
    // Found by mutation M19, and it is the same defect Phase 4's M18 exposed:
    // asserting the PLAINTEXT is absent says nothing about the sealed value.
    // Serving ciphertext hands an attacker something to work on offline, and
    // "a client secret is set" answers every legitimate question.
    //
    // I added exactly this guard for the LLM provider DTO in Phase 4 and did
    // not carry it to the connector DTO. This test is what makes that stick.
    await configureClient();
    const view = await call('/api/admin/connectors', { jar: cookies.admin });
    const dump = JSON.stringify(view.body);
    expect(dump).not.toContain(CLIENT_SECRET);
    expect(dump).not.toMatch(/v1\.[A-Za-z0-9+/=]{10}/);
    expect(dump).not.toMatch(/client_secret|clientSecret/i);
  });

  it('cannot be configured by a member', async () => {
    const res = await call('/api/admin/connectors/clients/google', {
      method: 'PUT', jar: cookies.alice,
      body: { clientId: 'x', clientSecret: 'y', redirectUri: 'https://z.test/cb' },
    });
    expect(res.status).toBe(403);
  });

  it('tells the admin exactly which callback URL to register', async () => {
    const view = await call('/api/admin/connectors', { jar: cookies.admin });
    const google = view.body.suggestedRedirectUris.find((u: any) => u.provider === 'google');
    expect(google.uri).toBe('http://localhost:3000/api/connections/google/callback');
  });
});

describe('connecting an account', () => {
  beforeEach(configureClient);

  it('asks once for the complete provider bundle while local capabilities remain off', async () => {
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: {},
    });
    const scope = new URL(started.body.url).searchParams.get('scope')!;
    expect(scope).toContain('calendar.readonly');
    expect(scope).toContain('gmail.readonly');
    expect(scope).toContain('gmail.send');
    expect(scope.split(' ')).toContain('https://www.googleapis.com/auth/calendar');
    expect(scope).toContain('contacts');
    expect(scope).toContain('drive.readonly');
  });

  it('stores the tokens sealed, and never returns them', async () => {
    const id = await connect('alice');
    const [row] = await db.query<{ secrets_enc: string }>(
      `select secrets_enc from connections where id = $1`, [id],
    );
    expect(row.secrets_enc).toMatch(/^v1\./);
    expect(row.secrets_enc).not.toContain(ACCESS_TOKEN);

    const mine = await call('/api/connections', { jar: cookies.alice });
    const dump = JSON.stringify(mine.body);
    expect(dump).not.toContain(ACCESS_TOKEN);
    expect(dump).not.toContain(REFRESH_TOKEN);
    // The owner may see which of their own accounts it is.
    expect(dump).toContain(ACCOUNT);
  });

  it('records the capability as available but off', async () => {
    await connect('alice');
    const mine = await call('/api/connections', { jar: cookies.alice });
    const google = mine.body.providers.find((p: any) => p.provider === 'google');
    const read = google.capabilities.find((c: any) => c.key === 'google.calendar.read');
    expect(read.state).toBe('off');
    // Consent to connect is not consent to act.
    expect(read.needsConsent).toBe(false);
  });

  it('refuses a replayed callback', async () => {
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: {},
    });
    const state = new URL(started.body.url).searchParams.get('state')!;
    const url = `/api/connections/google/callback?state=${encodeURIComponent(state)}&code=abc`;

    expect((await call(url, { jar: cookies.alice })).status).toBe(302);
    const replay = await call(url, { jar: cookies.alice });
    expect(replay.headers.get('location')).toMatch(/error=consumed/);
  });

  it('refuses a callback carrying another person state', async () => {
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: {},
    });
    const state = new URL(started.body.url).searchParams.get('state')!;
    // Bob captured Alice's state and tries to redeem it in his own browser.
    const stolen = await call(
      `/api/connections/google/callback?state=${encodeURIComponent(state)}&code=abc`,
      { jar: cookies.bob },
    );
    expect(stolen.headers.get('location')).toMatch(/error=session_mismatch/);
    expect(await db.query(`select 1 from connections`)).toHaveLength(0);
  });

  it('refuses a forged state', async () => {
    const res = await call('/api/connections/google/callback?state=made-up&code=abc', { jar: cookies.alice });
    expect(res.headers.get('location')).toMatch(/error=unknown/);
    expect(providerCalls).toHaveLength(0);
  });

  it('ignores anything the query string says about who is connecting', async () => {
    // Found by mutation M14: making the callback read `?user=` from the query
    // string left every test passing, because none of them supplied one. The
    // vulnerability was latent rather than absent, and "the callback believes
    // the stored handshake" was a comment nothing checked.
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: {},
    });
    const state = new URL(started.body.url).searchParams.get('state')!;

    // Alice's own callback, with Bob's id smuggled in every plausible spelling.
    const injected = [
      `user=${ids.bob}`, `userId=${ids.bob}`, `owner=${ids.bob}`,
      `owner_user_id=${ids.bob}`, `sub=${ids.bob}`,
    ].join('&');
    const res = await call(
      `/api/connections/google/callback?state=${encodeURIComponent(state)}&code=abc&${injected}`,
      { jar: cookies.alice },
    );
    expect(res.status).toBe(302);

    const rows = await db.query<{ owner_user_id: string }>(`select owner_user_id from connections`);
    expect(rows).toHaveLength(1);
    // The connection belongs to whoever STARTED the handshake.
    expect(rows[0].owner_user_id).toBe(ids.alice);
  });

  it('handles the person clicking cancel at the provider', async () => {
    const res = await call('/api/connections/google/callback?error=access_denied', { jar: cookies.alice });
    expect(res.headers.get('location')).toMatch(/error=declined/);
  });
});

describe('a member cannot act on another member connection', () => {
  beforeEach(configureClient);

  it('404s the connection itself', async () => {
    const aliceConn = await connect('alice');
    expect((await call(`/api/connections/${aliceConn}`, { jar: cookies.bob })).status).toBe(404);
  });

  it('cannot enable a capability on it', async () => {
    tokenResponse = { scope: 'https://www.googleapis.com/auth/gmail.send' };
    const aliceConn = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    const res = await call(`/api/connections/${aliceConn}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.bob, body: { enabled: true },
    });
    expect(res.status).toBe(404);

    const [grant] = await db.query<{ enabled: boolean }>(
      `select enabled from connection_capabilities where capability = 'google.mail.send'`,
    );
    expect(grant.enabled).toBe(false);
  });

  it('cannot disconnect it', async () => {
    const aliceConn = await connect('alice');
    expect((await call(`/api/connections/${aliceConn}`, { method: 'DELETE', jar: cookies.bob })).status).toBe(404);
    expect(await db.query(`select 1 from connections`)).toHaveLength(1);
  });

  it('does not see it in their own list', async () => {
    await connect('alice');
    const bobs = await call('/api/connections', { jar: cookies.bob });
    expect(bobs.body.connections).toHaveLength(0);
    expect(JSON.stringify(bobs.body)).not.toContain(ACCOUNT);
  });
});

describe('legacy partial grants use one account-level permission upgrade', () => {
  beforeEach(configureClient);

  it('refuses when the provider granted only read', async () => {
    const id = await connect('alice');
    const res = await call(`/api/connections/${id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(res.status).toBe(409);
    expect(res.body.state).toBe('needs_consent');
    expect(res.body.error).toMatch(/reconnect/i);
    const mine = await call('/api/connections', { jar: cookies.alice });
    const google = mine.body.providers.find((p: any) => p.provider === 'google');
    expect(google.connections[0].needsPermissionUpgrade).toBe(true);
  });

  it('succeeds after a second handshake that grants the scope', async () => {
    await connect('alice');
    // The account-level upgrade asks for the complete current bundle, even if
    // an old client still submits a per-capability request body.
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: { capabilities: ['google.mail.send'] },
    });
    const scope = new URL(started.body.url).searchParams.get('scope')!;
    expect(scope).toContain('gmail.send');
    expect(scope).toContain('drive.readonly');

    tokenResponse = { scope: 'https://www.googleapis.com/auth/gmail.send' };
    const state = new URL(started.body.url).searchParams.get('state')!;
    await call(`/api/connections/google/callback?state=${encodeURIComponent(state)}&code=abc`, {
      jar: cookies.alice,
    });

    const [conn] = await db.query<{ id: string; granted_scopes: string }>(
      `select id, granted_scopes from connections where owner_user_id = $1`, [ids.alice],
    );
    // The latest token is authoritative; withdrawn grants must not survive.
    expect(conn.granted_scopes).not.toContain('calendar.readonly');
    expect(conn.granted_scopes).toContain('gmail.send');

    const res = await call(`/api/connections/${conn.id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.capabilities.find((c: any) => c.key === 'google.mail.send').state).toBe('on');
  });
});

describe('the admin ceiling can only deny', () => {
  beforeEach(configureClient);

  async function withSend() {
    const id = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    await call(`/api/connections/${id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    return id;
  }

  it('overrides a member who enabled it', async () => {
    const id = await withSend();
    const forbid = await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false, note: 'not on this installation' },
    });
    expect(forbid.status).toBe(200);

    const mine = await call(`/api/connections/${id}`, { jar: cookies.alice });
    const send = mine.body.capabilities.find((c: any) => c.key === 'google.mail.send');
    expect(send.state).toBe('blocked_by_admin');
    expect(send.adminNote).toBe('not on this installation');
  });

  it('does NOT enable something the member never turned on', async () => {
    const id = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    // Explicitly permitted, and still off — an allow is not a grant.
    await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.admin, body: { allowed: true },
    });
    const mine = await call(`/api/connections/${id}`, { jar: cookies.alice });
    expect(mine.body.capabilities.find((c: any) => c.key === 'google.mail.send').state).toBe('off');
  });

  it('refuses a member trying to enable what the admin forbade', async () => {
    const id = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false },
    });
    const res = await call(`/api/connections/${id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(res.status).toBe(409);
    expect(res.body.state).toBe('blocked_by_admin');
  });

  it('restores the member own choice when the ceiling is lifted', async () => {
    const id = await withSend();
    await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.admin, body: { allowed: false },
    });
    await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.admin, body: { allowed: true },
    });
    // Their consent was never overwritten, only overruled.
    const mine = await call(`/api/connections/${id}`, { jar: cookies.alice });
    expect(mine.body.capabilities.find((c: any) => c.key === 'google.mail.send').state).toBe('on');
  });

  it('cannot be set by a member', async () => {
    const res = await call('/api/admin/connectors/policy/google.mail.send', {
      method: 'PUT', jar: cookies.alice, body: { allowed: false },
    });
    expect(res.status).toBe(403);
  });
});

describe('the admin sees health, never content', () => {
  beforeEach(configureClient);

  it('gets whose it is and whether it works, and nothing else', async () => {
    await connect('alice');
    const res = await call('/api/admin/connectors/connections', { jar: cookies.admin });
    expect(res.status).toBe(200);
    const row = res.body.connections[0];
    expect(row).toMatchObject({ username: 'alice', provider: 'google', status: 'active' });

    const dump = JSON.stringify(res.body);
    // Not the mailbox, not the scopes, not a token.
    expect(dump).not.toContain(ACCOUNT);
    expect(dump).not.toContain(ACCESS_TOKEN);
    expect(dump).not.toContain(REFRESH_TOKEN);
    expect(dump).not.toContain('calendar.readonly');
    expect(dump).not.toContain('secrets_enc');
  });

  it('cannot read the member own connection view', async () => {
    const id = await connect('alice');
    // The admin surface is separate on purpose; the member route is 404 for
    // anyone who is not the owner, administrator included.
    expect((await call(`/api/connections/${id}`, { jar: cookies.admin })).status).toBe(404);
  });

  it('may cut a connection off', async () => {
    const id = await connect('alice');
    const res = await call(`/api/admin/connectors/connections/${id}`, {
      method: 'DELETE', jar: cookies.admin,
    });
    expect(res.status).toBe(204);
    expect(await db.query(`select 1 from connections`)).toHaveLength(0);
  });

  it('is refused to a member', async () => {
    expect((await call('/api/admin/connectors/connections', { jar: cookies.bob })).status).toBe(403);
  });
});

describe('disconnecting', () => {
  beforeEach(configureClient);

  it('removes the Vault tokens and capability grants after immediately withdrawing local authority', async () => {
    await initializeVault(db,key,ids.admin);
    const id = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    await call(`/api/connections/${id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });

    expect(await db.query(`select 1 from vault_items where service='connector.google' and slot=$1`,[id])).toHaveLength(1);
    let revoked=false;
    onRevoke=async()=>{ revoked=true;expect((await db.query(`select status from connections where id=$1`,[id]))[0].status).toBe('revoked'); };
    const res = await call(`/api/connections/${id}`, { method: 'DELETE', jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(revoked).toBe(true);
    expect(await db.query(`select 1 from vault_items where service='connector.google' and slot=$1`,[id])).toHaveLength(0);
    expect(await db.query(`select 1 from connections`)).toHaveLength(0);
    expect(await db.query(`select 1 from connection_capabilities`)).toHaveLength(0);
  });
});

describe('the central calendar', () => {
  beforeEach(configureClient);

  it('discovers secondary calendars, keeps selection owner-only, and aggregates selected events', async () => {
    const id = await connect('alice');
    await call(`/api/connections/${id}/capabilities/google.calendar.read`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    const listed = await call('/api/calendar/sources?refresh=true', { jar: cookies.alice });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.sources.map((s: any) => s.name)).toEqual(['Primary', 'Vaxman Kids']);
    const primary=listed.body.sources.find((s:any)=>s.primary);
    expect(primary).toMatchObject({providerCalendarId:'primary@example.test',writeDefault:true,writable:true});
    expect(listed.body.sources.filter((s:any)=>s.primary)).toHaveLength(1);
    expect(listed.body.sources.some((s:any)=>s.providerCalendarId==='primary')).toBe(false);
    const origins=await db.query<{provider_calendar_id:string;last_sync_at:string|null}>(`select provider_calendar_id,last_sync_at from calendar_sync_origins where owner_user_id=$1 order by provider_calendar_id`,[ids.alice]);
    expect(origins.map(origin=>origin.provider_calendar_id)).toEqual(['kids@example.test','primary@example.test']);
    expect(origins.every(origin=>origin.last_sync_at!==null)).toBe(true);
    const kids = listed.body.sources.find((s: any) => s.name === 'Vaxman Kids');
    expect(kids).toMatchObject({providerCalendarId:'kids@example.test',writable:false,writeDefault:false});
    expect((await call(`/api/calendar/sources/${kids.id}`, { method: 'PUT', jar: cookies.bob, body: { selected: false } })).status).toBe(404);
    expect((await call(`/api/calendar/sources/${kids.id}`, { method: 'PUT', jar: cookies.alice, body: { selected: false } })).status).toBe(200);
    const events = await call('/api/calendar/events?start=2026-09-14T00%3A00%3A00Z&end=2026-09-21T00%3A00%3A00Z', { jar: cookies.alice });
    expect(events.status, JSON.stringify(events.body)).toBe(200);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({ title: 'Dentist', sourceName: 'Primary', account: ACCOUNT });
  });
});

describe('the audit trail', () => {
  beforeEach(configureClient);

  it('records what happened without recording what was in the account', async () => {
    const id = await connect('alice', ['google.mail.send'], 'https://www.googleapis.com/auth/gmail.send');
    await call(`/api/connections/${id}/capabilities/google.mail.send`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });

    const events = JSON.stringify(await db.query(`select * from events`));
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, ACCOUNT]) {
      expect(events, secret).not.toContain(secret);
    }
    expect(events).toContain('connection.authorized');
    expect(events).toContain('connection.capability_enabled');
  });
});
