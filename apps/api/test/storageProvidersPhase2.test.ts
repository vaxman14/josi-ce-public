// Dropbox, Box and Nextcloud over the wire — the same claims
// storageProviders.test.ts proves for Google Drive/OneDrive, aimed at the
// three phase-2 providers:
//
//   1. Dropbox/Box: connecting for calendar/mail never applies (they have no
//      calendar or mail capability at all) — file access is the only thing
//      there is to ask for, and it is still opt-in-by-name at connect time.
//   2. Folder browsing is owner-only (404 for anyone else) and refused with a
//      reason while the capability is off (409), for all three.
//   3. Nextcloud's OWN connect route: verifies the credential against the
//      server before storing it, refuses a bad one, and is not reachable via
//      the OAuth /start or /callback routes because it never registers as an
//      OAuth provider there.
//   4. The assistant's document search reaches indexed text from any of the
//      three exactly as it does for Drive — proving search_documents/
//      list_documents needed NO changes for this round, as designed.
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
import { executeAssistantTool } from '@josi-ce/agent';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-storage-providers-phase2-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 17);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** The stubbed providers: token exchange/identity for Dropbox and Box, and a
 * WebDAV server for Nextcloud. No real network anywhere in this file. */
const connectorFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const href = String(url);
  const method = init?.method ?? 'GET';

  // Dropbox identity (POST, no query string — see providers.ts's comment on
  // why this is the one non-GET identity call).
  if (href.includes('get_current_account')) {
    return new Response(JSON.stringify({ account_id: 'dbx-acct-1', email: 'a@dropboxmail.test' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Box identity.
  if (href.includes('api.box.com/2.0/users/me')) {
    return new Response(JSON.stringify({ id: 'box-acct-1', login: 'a@boxmail.test' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Dropbox folder listing.
  if (href.includes('/files/list_folder')) {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const listing = body.path === ''
      ? [{ '.tag': 'folder', name: 'Reports', path_display: '/Reports', path_lower: '/reports' }]
      : [];
    return new Response(JSON.stringify({ entries: listing, has_more: false }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Box folder listing.
  if (href.includes('/folders/') && href.includes('/items')) {
    const isRoot = href.includes('/folders/0/items');
    const listing = isRoot ? [{ id: 'fold-1', name: 'Reports', type: 'folder' }] : [];
    return new Response(JSON.stringify({ entries: listing, total_count: listing.length, offset: 0, limit: 100 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Nextcloud WebDAV: connect-time verification and folder browsing both go
  // through PROPFIND.
  if (method === 'PROPFIND') {
    if (href.includes('nc-bad.example.test')) {
      return new Response('', { status: 401 });
    }
    const isRoot = /\/files\/[^/]+\/?$/.test(new URL(href).pathname);
    const children = isRoot
      ? `<d:response><d:href>/remote.php/dav/files/roman/Reports/</d:href>
           <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>
           <d:displayname>Reports</d:displayname></d:prop>
           <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
      : '';
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>${new URL(href).pathname}</d:href>
        <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
      ${children}
    </d:multistatus>`;
    return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml' } });
  }
  // OAuth token exchange (Dropbox and Box both land here).
  return new Response(
    JSON.stringify({ access_token: 'ACCESS-TOKEN-value', refresh_token: 'REFRESH-TOKEN-value', expires_in: 3600 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

interface Res { status: number; body: any; setCookie: string[] }

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
  ids.admin = (await createUser(db, { email: 'admin3@ce.test', username: 'admin3', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice3@ce.test', username: 'alice3', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob3@ce.test', username: 'bob3', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin3', PW.admin);
  cookies.alice = await signIn('alice3', PW.alice);
  cookies.bob = await signIn('bob3', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  await db.query(`delete from documents`);
  await db.query(`delete from folder_mappings`);
  await db.query(`delete from sync_state`);
  await db.query(`delete from job_queue`);
  await db.query(`delete from connection_capabilities`);
  await db.query(`delete from connections`);
  await db.query(`delete from oauth_states`);
  await db.query(`delete from oauth_clients`);
  await db.query(`delete from admin_capability_policy`);
  await db.query(`delete from storage_capabilities`);
  await db.query(`update storage_policy set processing_paused = false, manual_sync_enabled = true`);
  for (const provider of ['dropbox', 'box']) {
    await call(`/api/admin/connectors/clients/${provider}`, {
      method: 'PUT', jar: cookies.admin,
      body: {
        clientId: `${provider}-operator-client-id`,
        clientSecret: `${provider}-OPERATOR-CLIENT-SECRET-value`,
        redirectUri: `http://localhost:3000/api/connections/${provider}/callback`,
      },
    });
  }
});

async function connectOAuth(who: 'alice' | 'bob', provider: 'dropbox' | 'box'): Promise<string> {
  const started = await call(`/api/connections/${provider}/start`, {
    method: 'POST', jar: cookies[who], body: { capabilities: [`${provider}.files.read`] },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const state = new URL(started.body.url).searchParams.get('state')!;
  const cb = await call(`/api/connections/${provider}/callback?state=${encodeURIComponent(state)}&code=abc`, {
    jar: cookies[who],
  });
  expect(cb.status).toBe(302);
  const [row] = await db.query<{ id: string }>(
    `select id from connections where owner_user_id = $1 and provider = $2`, [ids[who], provider],
  );
  return row.id;
}

async function enableCapability(who: 'alice' | 'bob', connectionId: string, capability: string) {
  const enabled = await call(`/api/connections/${connectionId}/capabilities/${capability}`, {
    method: 'PUT', jar: cookies[who], body: { enabled: true },
  });
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
}

describe('Dropbox and Box: connect, browse, gate', () => {
  it.each(['dropbox', 'box'] as const)('%s appears on the Connections page as its own capability, off until enabled', async (provider) => {
    await connectOAuth('alice', provider);
    const view = await call('/api/connections', { jar: cookies.alice });
    const p = view.body.providers.find((x: any) => x.provider === provider);
    expect(p.available).toBe(true);
    const cap = p.capabilities.find((c: any) => c.key === `${provider}.files.read`);
    expect(cap.state).toBe('off');
  });

  it.each(['dropbox', 'box'] as const)('%s: lists folders for the connection owner once the capability is on', async (provider) => {
    const id = await connectOAuth('alice', provider);
    await enableCapability('alice', id, `${provider}.files.read`);
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.alice });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.folders).toEqual([{ id: provider === 'dropbox' ? '/Reports' : 'fold-1', name: 'Reports' }]);
  });

  it.each(['dropbox', 'box'] as const)("%s: another member's connection is 404, not 403", async (provider) => {
    const id = await connectOAuth('alice', provider);
    await enableCapability('alice', id, `${provider}.files.read`);
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.bob });
    expect(res.status).toBe(404);
  });

  it.each(['dropbox', 'box'] as const)('%s: refused with a fixable reason while the capability is off', async (provider) => {
    const id = await connectOAuth('alice', provider);
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.alice });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not turned on/i);
  });

  it.each(['dropbox', 'box'] as const)('%s: mapping and syncing a folder works through /api/storage/mappings', async (provider) => {
    const id = await connectOAuth('alice', provider);
    await enableCapability('alice', id, `${provider}.files.read`);
    await db.query(
      `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
       values ($1, true, true, $2)`,
      [ids.alice, ids.admin],
    );
    const remoteFolderId = provider === 'dropbox' ? '/Reports' : 'fold-1';
    const created = await call('/api/storage/mappings', {
      method: 'POST', jar: cookies.alice,
      body: { provider, connectionId: id, remoteFolderId, displayPath: `${provider}/Reports`, recursive: true },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const enabled = await call(`/api/storage/mappings/${created.body.mapping.id}/indexing`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    const synced = await call(`/api/storage/mappings/${created.body.mapping.id}/sync`, {
      method: 'POST', jar: cookies.alice, body: {},
    });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const jobs = await db.query(`select kind from job_queue where kind = 'storage.sync'`);
    expect(jobs.length).toBe(1);
  });
});

describe('Nextcloud: WebDAV connect, browse, gate', () => {
  it('has no OAuth handshake — /start and /callback do not recognise it', async () => {
    const started = await call('/api/connections/nextcloud/start', { method: 'POST', jar: cookies.alice, body: {} });
    expect(started.status).toBe(404);
    const cb = await call('/api/connections/nextcloud/callback?state=x&code=y', { jar: cookies.alice });
    expect(cb.status).toBe(404);
  });

  it('connects with a server URL, username and app password, verified before storing', async () => {
    const res = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.connection.provider).toBe('nextcloud');
    expect(res.body.connection.serverUrl).toBe('https://cloud.example.test');
  });

  it('refuses a bad credential rather than storing a connection that will never work', async () => {
    const res = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'nc-bad.example.test', username: 'roman', appPassword: 'wrong-password' },
    });
    expect(res.status).toBe(401);
    const [row] = await db.query(`select id from connections where owner_user_id = $1 and provider = 'nextcloud'`, [ids.alice]);
    expect(row).toBeUndefined();
  });

  it('rejects a non-http(s) server address before it ever reaches a request', async () => {
    const res = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'javascript:alert(1)', username: 'roman', appPassword: 'secret' },
    });
    expect(res.status).toBe(400);
  });

  it('appears on the Connections page with its own off-by-default capability', async () => {
    await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    const view = await call('/api/connections', { jar: cookies.alice });
    const nc = view.body.providers.find((p: any) => p.provider === 'nextcloud');
    expect(nc.available).toBe(true);
    const cap = nc.capabilities.find((c: any) => c.key === 'nextcloud.files.read');
    expect(cap.state).toBe('off');
  });

  it('lists folders for the connection owner once the capability is on', async () => {
    const connect = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    await enableCapability('alice', connect.body.connection.id, 'nextcloud.files.read');
    const res = await call(`/api/connections/${connect.body.connection.id}/storage/folders`, { jar: cookies.alice });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.folders).toEqual([{ id: '/Reports', name: 'Reports' }]);
  });

  it("another member's Nextcloud connection is 404, not 403", async () => {
    const connect = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    await enableCapability('alice', connect.body.connection.id, 'nextcloud.files.read');
    const res = await call(`/api/connections/${connect.body.connection.id}/storage/folders`, { jar: cookies.bob });
    expect(res.status).toBe(404);
  });

  it('refused with a fixable reason while the capability is off', async () => {
    const connect = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    const res = await call(`/api/connections/${connect.body.connection.id}/storage/folders`, { jar: cookies.alice });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not turned on/i);
  });

  it('disconnecting deletes the credential and explains the app-password caveat honestly', async () => {
    const connect = await call('/api/connections/nextcloud/connect', {
      method: 'POST', jar: cookies.alice,
      body: { serverUrl: 'cloud.example.test', username: 'roman', appPassword: 'app-pw-secret' },
    });
    const res = await call(`/api/connections/${connect.body.connection.id}`, { method: 'DELETE', jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.note).toMatch(/app password/i);
    const [row] = await db.query(`select id from connections where id = $1`, [connect.body.connection.id]);
    expect(row).toBeUndefined();
  });
});

describe("the assistant's document search reaches all three providers' text, unmodified", () => {
  async function indexedDoc(owner: string, provider: 'dropbox' | 'box' | 'nextcloud', content: string): Promise<void> {
    let connectionId: string;
    if (provider === 'nextcloud') {
      const connect = await call('/api/connections/nextcloud/connect', {
        method: 'POST', jar: cookies.alice,
        body: { serverUrl: `${provider}.example.test`, username: 'roman', appPassword: 'app-pw-secret' },
      });
      connectionId = connect.body.connection.id;
    } else {
      connectionId = await connectOAuth('alice', provider);
    }
    const [mapping] = await db.query<{ id: string }>(
      `insert into folder_mappings
         (owner_user_id, provider, connection_id, remote_folder_id, display_path)
       values ($1, $2, $3, 'remote-x', $4) returning id`,
      [owner, provider, connectionId, `${provider}/Reports`],
    );
    const [doc] = await db.query<{ id: string }>(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename, extension, state)
       values ($1, $2, 'notes.txt', 'notes.txt', 'txt', 'indexed') returning id`,
      [mapping.id, owner],
    );
    await db.query(
      `insert into document_segments (document_id, owner_user_id, ordinal, content)
       values ($1, $2, 0, $3)`,
      [doc.id, owner, content],
    );
  }

  it.each(['dropbox', 'box', 'nextcloud'] as const)(
    "finds the caller's own indexed text from a %s mapping, cited, via the unmodified search_documents tool",
    async (provider) => {
      await indexedDoc(ids.alice, provider, `the quarterly ${provider} budget draft`);
      const out = await executeAssistantTool(db, { userId: ids.alice, threadId: null }, 'search_documents', {
        query: `${provider} budget`,
      }) as any;
      expect(out.ok).toBe(true);
      expect(out.hits.length).toBe(1);
      expect(out.hits[0].citation).toBe('notes.txt');
    },
  );

  it('list_documents also needed no changes: a nextcloud-mapped document shows up in it', async () => {
    await indexedDoc(ids.alice, 'nextcloud', 'listed via the generic tool');
    const out = await executeAssistantTool(db, { userId: ids.alice, threadId: null }, 'list_documents', {}) as any;
    expect(out.ok).toBe(true);
    expect(out.documents.some((d: any) => d.filename === 'notes.txt')).toBe(true);
  });
});
