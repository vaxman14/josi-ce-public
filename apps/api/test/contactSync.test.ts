// Contact synchronisation over the wire.
//
// LB8's acceptance criterion in the form it is written: two users sync
// separate Google and Microsoft contact sets, and nothing of one reaches the
// other. Attacked from the outside — real sessions, real CSRF, real
// ownership — rather than by calling the engine directly.
//
// No provider is contacted: `connectorFetch` is injected into the app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey } from '@josi-ce/core';
import { saveClient, setCapability, upsertConnection } from '@josi-ce/connectors';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-contactsync-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 13);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
const conn: Record<string, string> = {};

/** What each user's provider returns. Keyed by access token, so a request
 * carrying Alice's token cannot receive Bob's contacts even by mistake. */
const contactsByToken: Record<string, Array<Record<string, unknown>>> = {};

const connectorFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const href = String(url);
  const auth = new Headers(init?.headers as HeadersInit).get('authorization') ?? '';
  const token = auth.replace(/^Bearer /, '');

  if (href.includes('oauth2') || href.endsWith('/token')) {
    return new Response(JSON.stringify({ access_token: token || 'refreshed', expires_in: 3600 }), { status: 200 });
  }
  if (href.includes('people.googleapis.com')) {
    return new Response(JSON.stringify({
      connections: contactsByToken[token] ?? [], nextSyncToken: `tok-${token}`,
    }), { status: 200 });
  }
  if (href.includes('graph.microsoft.com')) {
    return new Response(JSON.stringify({
      value: contactsByToken[token] ?? [],
      '@odata.deltaLink': `https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=${token}`,
    }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

interface Res { status: number; body: any; setCookie: string[] }

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}): Promise<Res> {
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
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [] };
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

const person = (over: Record<string, unknown> = {}) => ({
  resourceName: 'people/c1',
  etag: 'e1',
  names: [{ displayName: 'Someone' }],
  emailAddresses: [{ value: 'someone@example.test' }],
  ...over,
});

/** A connected account with the contacts capability really granted. */
async function connect(user: string, provider: 'google' | 'microsoft', token: string, write = false) {
  const caps = provider === 'google'
    ? ['google.contacts.read', ...(write ? ['google.contacts.write'] : [])]
    : ['microsoft.contacts.read', ...(write ? ['microsoft.contacts.write'] : [])];
  const scopes = provider === 'google'
    ? `https://www.googleapis.com/auth/contacts.readonly${write ? ' https://www.googleapis.com/auth/contacts' : ''}`
    : `Contacts.Read${write ? ' Contacts.ReadWrite' : ''}`;

  const connection = await upsertConnection(db, key, {
    ownerUserId: user,
    provider,
    tokens: { accessToken: token, refreshToken: `${token}-refresh`, expiresIn: 3600, grantedScopes: scopes },
    accountEmail: `${token}@${provider}.test`,
    providerAccountId: `acct-${token}`,
    requestedCapabilities: caps,
  });
  for (const capability of caps) {
    await setCapability(db, { connection, capability, enabled: true, actorUserId: user });
  }
  return connection;
}

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

  conn.aliceGoogle = (await connect(ids.alice, 'google', 'alice-token')).id;
  conn.aliceMicrosoft = (await connect(ids.alice, 'microsoft', 'alice-ms-token')).id;
  conn.bobGoogle = (await connect(ids.bob, 'google', 'bob-token')).id;
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(() => {
  for (const k of Object.keys(contactsByToken)) delete contactsByToken[k];
});

// -------------------------------------------------------------- the criterion

describe('two users, separate address books', () => {
  it('sync their own contacts and see nothing of each other’s', async () => {
    contactsByToken['alice-token'] = [person({
      resourceName: 'people/a1',
      names: [{ displayName: 'Alice Client' }],
      emailAddresses: [{ value: 'alice-client@example.test' }],
    })];
    contactsByToken['alice-ms-token'] = [{
      id: 'ms-a1', displayName: 'Alice Outlook Client',
      emailAddresses: [{ address: 'alice-outlook@example.test' }],
    }];
    contactsByToken['bob-token'] = [person({
      resourceName: 'people/b1',
      names: [{ displayName: 'Bob Client' }],
      emailAddresses: [{ value: 'bob-client@example.test' }],
    })];

    for (const [jar, connectionId] of [
      [cookies.alice, conn.aliceGoogle],
      [cookies.alice, conn.aliceMicrosoft],
      [cookies.bob, conn.bobGoogle],
    ] as const) {
      const mode = await call(`/api/contacts/sync/${connectionId}`, {
        method: 'PUT', jar, body: { mode: 'import_only' },
      });
      expect(mode.status, JSON.stringify(mode.body)).toBe(200);
      const run = await call(`/api/contacts/sync/${mode.body.origin.id}/run`, { method: 'POST', jar, body: {} });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
    }

    const aliceContacts = (await call('/api/assistant/contacts', { jar: cookies.alice })).body.contacts;
    const bobContacts = (await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts;

    expect(aliceContacts).toHaveLength(2);
    expect(bobContacts).toHaveLength(1);

    // The acceptance criterion, stated as an absence in both directions.
    const aliceDump = JSON.stringify(aliceContacts);
    const bobDump = JSON.stringify(bobContacts);
    expect(aliceDump).not.toContain('bob-client@example.test');
    expect(aliceDump).not.toContain('Bob Client');
    expect(bobDump).not.toContain('alice-client@example.test');
    expect(bobDump).not.toContain('alice-outlook@example.test');
  });

  it('shows where each contact came from', async () => {
    // LB8.7. A synced contact that looks identical to a typed one is a contact
    // nobody can reason about when it changes on its own.
    const contacts = (await call('/api/assistant/contacts', { jar: cookies.alice })).body.contacts;
    const google = contacts.find((c: any) => c.source === 'google');
    const microsoft = contacts.find((c: any) => c.source === 'microsoft');
    expect(google.source_account).toBe('alice-token@google.test');
    expect(microsoft.source_account).toBe('alice-ms-token@microsoft.test');
    expect(google.synced_at).toBeTruthy();
  });

  it('lists only your own origins, with status and mode', async () => {
    const alice = await call('/api/contacts/sync', { jar: cookies.alice });
    expect(alice.body.origins).toHaveLength(2);
    for (const origin of alice.body.origins) {
      expect(origin.syncMode).toBe('import_only');
      expect(origin.status).toBe('idle');
      expect(origin.lastSyncAt).toBeTruthy();
      // A cursor is an opaque provider token; only its presence is useful.
      expect(origin.incremental).toBe(true);
      expect(JSON.stringify(origin)).not.toContain('tok-alice-token');
    }

    const bob = await call('/api/contacts/sync', { jar: cookies.bob });
    expect(bob.body.origins).toHaveLength(1);
    expect(bob.body.origins[0].connectionId).toBe(conn.bobGoogle);
  });
});

describe('somebody else’s connection', () => {
  it('cannot be given a sync mode', async () => {
    const res = await call(`/api/contacts/sync/${conn.aliceGoogle}`, {
      method: 'PUT', jar: cookies.bob, body: { mode: 'import_only' },
    });
    // 404 rather than 403: confirming that somebody else's connection exists
    // is itself a disclosure.
    expect(res.status).toBe(404);
  });

  it('cannot be run', async () => {
    const alice = await call('/api/contacts/sync', { jar: cookies.alice });
    const originId = alice.body.origins[0].id;
    const res = await call(`/api/contacts/sync/${originId}/run`, { method: 'POST', jar: cookies.bob, body: {} });
    expect(res.status).toBe(404);
  });

  it('cannot be stopped', async () => {
    const alice = await call('/api/contacts/sync', { jar: cookies.alice });
    const res = await call(`/api/contacts/sync/${alice.body.origins[0].id}/stop`, {
      method: 'POST', jar: cookies.bob, body: {},
    });
    expect(res.status).toBe(404);
  });

  it('is not reachable by an administrator either', async () => {
    // An admin who could start somebody's contact sync could read their
    // address book, so there is deliberately no administrative equivalent.
    const alice = await call('/api/contacts/sync', { jar: cookies.alice });
    const res = await call(`/api/contacts/sync/${alice.body.origins[0].id}/run`, {
      method: 'POST', jar: cookies.admin, body: {},
    });
    expect(res.status).toBe(404);

    const adminList = await call('/api/contacts/sync', { jar: cookies.admin });
    expect(adminList.body.origins, 'the admin has no connections of their own').toEqual([]);
  });

  it('refuses anonymously', async () => {
    for (const path of ['/api/contacts/sync']) {
      expect((await call(path)).status, path).toBe(401);
    }
  });
});

describe('merging', () => {
  it('refuses to merge a contact belonging to somebody else', async () => {
    const aliceContacts = (await call('/api/assistant/contacts', { jar: cookies.alice })).body.contacts;
    const bobContacts = (await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts;

    const res = await call('/api/contacts/merge', {
      method: 'POST', jar: cookies.bob,
      body: { keepId: bobContacts[0].id, mergeId: aliceContacts[0].id },
    });
    expect(res.status).toBe(404);

    // Alice still has everything she had.
    const after = (await call('/api/assistant/contacts', { jar: cookies.alice })).body.contacts;
    expect(after).toHaveLength(2);
  });

  it('refuses keep-separate across owners', async () => {
    const aliceContacts = (await call('/api/assistant/contacts', { jar: cookies.alice })).body.contacts;
    const bobContacts = (await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts;
    const res = await call('/api/contacts/keep-separate', {
      method: 'POST', jar: cookies.bob,
      body: { contactA: bobContacts[0].id, contactB: aliceContacts[0].id },
    });
    expect(res.status).toBe(404);
    expect(await db.query(`select id from contact_merge_decisions`)).toHaveLength(0);
  });
});

describe('two-way', () => {
  it('is refused until the write permission has actually been granted', async () => {
    const res = await call(`/api/contacts/sync/${conn.aliceGoogle}`, {
      method: 'PUT', jar: cookies.alice, body: { mode: 'two_way' },
    });
    expect(res.status).toBe(409);
    expect(res.body.category).toBe('insufficient_scope');
    expect(res.body.error).toMatch(/granted separately/i);
  });

  it('is allowed once it has', async () => {
    const connection = await connect(ids.bob, 'microsoft', 'bob-ms-token', true);
    const res = await call(`/api/contacts/sync/${connection.id}`, {
      method: 'PUT', jar: cookies.bob, body: { mode: 'two_way' },
    });
    expect(res.status).toBe(200);
    expect(res.body.origin.syncMode).toBe('two_way');
  });

  it('refuses a mode nobody defined', async () => {
    const res = await call(`/api/contacts/sync/${conn.aliceGoogle}`, {
      method: 'PUT', jar: cookies.alice, body: { mode: 'take_everything' },
    });
    expect(res.status).toBe(400);
  });
});

describe('stopping', () => {
  it('keeps the contacts and says so', async () => {
    const list = await call('/api/contacts/sync', { jar: cookies.bob });
    const origin = list.body.origins.find((o: any) => o.connectionId === conn.bobGoogle);
    const before = (await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts.length;

    const res = await call(`/api/contacts/sync/${origin.id}/stop`, { method: 'POST', jar: cookies.bob, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.contactsKept).toBe(before);
    expect(res.body.note).toMatch(/nothing was changed at the provider/i);

    const after = (await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts;
    expect(after).toHaveLength(before);
  });
});

describe('how often it syncs', () => {
  it('is settable, and reported', async () => {
    const list = await call('/api/contacts/sync', { jar: cookies.alice });
    const origin = list.body.origins[0];
    expect(origin.intervalSeconds).toBe(900);

    const res = await call(`/api/contacts/sync/${origin.id}/interval`, {
      method: 'PUT', jar: cookies.alice, body: { seconds: 3600 },
    });
    expect(res.status).toBe(200);

    const after = await call('/api/contacts/sync', { jar: cookies.alice });
    expect(after.body.origins.find((o: any) => o.id === origin.id).intervalSeconds).toBe(3600);
  });

  it('refuses an interval that would hammer a provider', async () => {
    const list = await call('/api/contacts/sync', { jar: cookies.alice });
    for (const seconds of [30, 299, 999999, 'soon']) {
      const res = await call(`/api/contacts/sync/${list.body.origins[0].id}/interval`, {
        method: 'PUT', jar: cookies.alice, body: { seconds },
      });
      expect(res.status, String(seconds)).toBe(400);
    }
  });

  it('cannot be changed on somebody else’s account', async () => {
    const list = await call('/api/contacts/sync', { jar: cookies.alice });
    const res = await call(`/api/contacts/sync/${list.body.origins[0].id}/interval`, {
      method: 'PUT', jar: cookies.bob, body: { seconds: 3600 },
    });
    expect(res.status).toBe(404);
  });
});
