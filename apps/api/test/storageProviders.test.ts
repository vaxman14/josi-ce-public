// Storage providers over the wire: Drive/OneDrive scopes, folder browsing,
// manual sync, the worker's fan-out, and the assistant's document search.
//
// The claims under attack:
//
//   1. connecting for calendar/mail does NOT drag file access along — the
//      storage scope is asked for by name or not at all
//   2. browsing folders is owner-only (404 for anyone else) and refused with a
//      reason while the capability is off (409, the person can fix it)
//   3. "Sync now" queues the job it claims to queue
//   4. the assistant's search reaches exactly the caller's own indexed text
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
import { runJob } from '../../worker/src/jobs.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-storage-providers-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 13);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const key = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
let tokenScope = DRIVE_SCOPE;

/** The stubbed provider: token exchange, identity, and a tiny Drive. */
const connectorFetch = (async (url: RequestInfo | URL) => {
  const href = String(url);
  if (href.includes('userinfo')) {
    return new Response(JSON.stringify({ sub: 'acct-1', email: 'a@gmail.test' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (href.includes('googleapis.com/drive/v3/files?')) {
    // URLSearchParams encodes spaces as '+', which decodeURIComponent keeps.
    const parent = /'([^']+)'/.exec(decodeURIComponent(href))?.[1];
    const listing = parent === 'root'
      ? [
          { id: 'fold-1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' },
          { id: 'file-1', name: 'stray.txt', mimeType: 'text/plain', size: '4' },
        ]
      : [];
    return new Response(JSON.stringify({ files: listing }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(
    JSON.stringify({
      access_token: 'ACCESS-TOKEN-value', refresh_token: 'REFRESH-TOKEN-value',
      expires_in: 3600, scope: tokenScope,
    }),
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
  tokenScope = DRIVE_SCOPE;
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
  await call('/api/admin/connectors/clients/google', {
    method: 'PUT', jar: cookies.admin,
    body: {
      clientId: 'operator-client-id',
      clientSecret: 'OPERATOR-CLIENT-SECRET-value',
      redirectUri: 'http://localhost:3000/api/connections/google/callback',
    },
  });
});

/** A completed handshake for `who`, asking for the named capabilities. */
async function connect(who: 'alice' | 'bob', capabilities: string[] = []): Promise<string> {
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

describe('storage scope: one provider consent bundle (Test List 7 item 6)', () => {
  it('a default connect asks once for every supported Google capability', async () => {
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: {},
    });
    const scope = new URL(started.body.url).searchParams.get('scope')!;
    expect(scope).toContain('calendar.readonly');
    expect(scope).toContain('gmail.readonly');
    expect(scope).toContain('contacts.readonly');
    // Item 16b: file read joins the first trip, so choosing a folder never
    // needs a second "Approve at provider" round-trip.
    expect(scope).toContain(DRIVE_SCOPE);
    expect(scope.split(' ')).toContain('https://www.googleapis.com/auth/calendar');
    expect(scope.split(' ')).toContain('https://www.googleapis.com/auth/contacts');
    expect(scope).toContain('gmail.send');
  });

  it('ignores legacy per-capability requests and still requests the account bundle', async () => {
    const started = await call('/api/connections/google/start', {
      method: 'POST', jar: cookies.alice, body: { capabilities: ['google.drive.read'] },
    });
    const scope = new URL(started.body.url).searchParams.get('scope')!;
    expect(scope).toContain(DRIVE_SCOPE);
    expect(scope).toContain('gmail.send');
    expect(scope).toContain('calendar');
  });

  it('appears on the Connections page as a capability, off until its owner turns it on', async () => {
    // No capabilities named — the default bundle already covers drive.read
    // per item 16b, so this proves the ordinary one-click connect reaches it.
    await connect('alice');
    const view = await call('/api/connections', { jar: cookies.alice });
    const google = view.body.providers.find((p: any) => p.provider === 'google');
    const drive = google.capabilities.find((c: any) => c.key === 'google.drive.read');
    // Granted by the provider, but connecting is still not consent to act:
    // needsConsent is false (no second OAuth trip needed) and it still starts
    // off until the owner switches it on.
    expect(drive.needsConsent).toBe(false);
    expect(drive.state).toBe('off');
    expect(drive.kind).toBe('read');
  });

  it('a default connect no longer needs a second handshake before folders can be browsed', async () => {
    // The whole point of item 16b: one connect, then straight to picking a
    // folder — no "needs_consent" detour in between.
    const id = await connect('alice');
    const enabled = await call(`/api/connections/${id}/capabilities/google.drive.read`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.capabilities.find((c: any) => c.key === 'google.drive.read').state).toBe('on');
  });
});

describe('browsing folders to map one', () => {
  async function connectWithDriveOn(who: 'alice' | 'bob'): Promise<string> {
    const id = await connect(who, ['google.drive.read']);
    const enabled = await call(`/api/connections/${id}/capabilities/google.drive.read`, {
      method: 'PUT', jar: cookies[who], body: { enabled: true },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    return id;
  }

  it('lists folders — folders only, no file names — for the connection owner', async () => {
    const id = await connectWithDriveOn('alice');
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.alice });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.folders).toEqual([{ id: 'fold-1', name: 'Reports' }]);
    // The stray file in the stub listing is not offered.
    expect(JSON.stringify(res.body)).not.toContain('stray.txt');
  });

  it("another member gets 404, not 403 — a connection's existence is not theirs to learn", async () => {
    const id = await connectWithDriveOn('alice');
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.bob });
    expect(res.status).toBe(404);
  });

  it('refused with a reason while the capability is off — 409, fixable by its owner', async () => {
    const id = await connect('alice', ['google.drive.read']);
    const res = await call(`/api/connections/${id}/storage/folders`, { jar: cookies.alice });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not turned on/i);
  });
});

describe('manual sync and the worker', () => {
  async function mappedFolder(): Promise<string> {
    const connectionId = await connect('alice', ['google.drive.read']);
    await call(`/api/connections/${connectionId}/capabilities/google.drive.read`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    await db.query(
      `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
       values ($1, true, true, $2)`,
      [ids.alice, ids.admin],
    );
    const created = await call('/api/storage/mappings', {
      method: 'POST', jar: cookies.alice,
      body: {
        provider: 'google_drive', connectionId, remoteFolderId: 'fold-1',
        displayPath: 'Google Drive/Reports', recursive: true,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const enabled = await call(`/api/storage/mappings/${created.body.mapping.id}/indexing`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    return created.body.mapping.id;
  }

  it('"Sync now" queues the job it claims to queue', async () => {
    const mappingId = await mappedFolder();
    const res = await call(`/api/storage/mappings/${mappingId}/sync`, {
      method: 'POST', jar: cookies.alice, body: {},
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const jobs = await db.query<{ kind: string; payload: any }>(
      `select kind, payload from job_queue where kind = 'storage.sync'`,
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0].payload.mappingId).toBe(mappingId);
  });

  it('the fan-out schedule enqueues one job per due mapping and stamps its turn', async () => {
    const mappingId = await mappedFolder();
    await runJob(db, { id: 'j', kind: 'storage.sync_due', payload: {} } as any, { masterKey: key });
    const jobs = await db.query<{ payload: any }>(
      `select payload from job_queue where kind = 'storage.sync'`,
    );
    expect(jobs.map((j) => j.payload.mappingId)).toEqual([mappingId]);
    // Stamped before the run: the next fan-out enqueues nothing.
    await runJob(db, { id: 'j2', kind: 'storage.sync_due', payload: {} } as any, { masterKey: key });
    const again = await db.query(`select id from job_queue where kind = 'storage.sync'`);
    expect(again.length).toBe(1);
  });

  it('the migration installed the schedule', async () => {
    const [row] = await db.query<{ enabled: boolean; interval_seconds: number }>(
      `select enabled, interval_seconds from schedules where kind = 'storage.sync_due'`,
    );
    expect(row?.enabled).toBe(true);
    expect(row?.interval_seconds).toBe(120);
  });
});

describe("the assistant's document search", () => {
  async function indexedDoc(owner: string, content: string): Promise<void> {
    const [mapping] = await db.query<{ id: string }>(
      `insert into folder_mappings
         (owner_user_id, provider, connection_id, remote_folder_id, display_path)
       select $1, 'google_drive', c.id, 'fold-x', 'Google Drive/Reports'
       from connections c where c.owner_user_id = $1 returning id`,
      [owner],
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

  it('finds the caller’s own indexed text, cited', async () => {
    await connect('alice', ['google.drive.read']);
    await indexedDoc(ids.alice, 'the quarterly pelican budget draft');
    const out = await executeAssistantTool(db, { userId: ids.alice, threadId: null }, 'search_documents', {
      query: 'pelican budget',
    }) as any;
    expect(out.ok).toBe(true);
    expect(out.hits.length).toBe(1);
    expect(out.hits[0].citation).toBe('notes.txt');
    expect(out.hits[0].snippet).toContain('pelican');
  });

  it("never finds another person's documents — there is no argument that widens it", async () => {
    await connect('alice', ['google.drive.read']);
    await indexedDoc(ids.alice, 'confidential heron figures');
    const out = await executeAssistantTool(db, { userId: ids.bob, threadId: null }, 'search_documents', {
      query: 'heron',
    }) as any;
    expect(out.ok).toBe(true);
    expect(out.hits).toEqual([]);
    // And the honest sentence for an empty index sends bob to the right fix.
    expect(out.message).toMatch(/no documents are indexed yet/i);
  });

  it('distinguishes "nothing matched" from "nothing to search"', async () => {
    await connect('alice', ['google.drive.read']);
    await indexedDoc(ids.alice, 'entirely unrelated words');
    const out = await executeAssistantTool(db, { userId: ids.alice, threadId: null }, 'search_documents', {
      query: 'xylophone',
    }) as any;
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/no indexed document matched/i);
    expect(out.message).toMatch(/1 document/);
  });
});
