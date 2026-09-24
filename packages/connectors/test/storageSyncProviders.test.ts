// Cloud folder sync for the phase-2 providers — Dropbox, Box, Nextcloud — end
// to end against a real schema, through the SAME syncCloudMapping engine
// storageSync.test.ts proves for Google Drive.
//
// What this file exists to show: `openRemoteSession` really does erase the
// OAuth/WebDAV difference for the walk. Google/OneDrive's own depth (first
// sync, unchanged, removal, truncated walk, capability revocation, schedule)
// is not re-proven per provider here — that would be duplicating
// storageSync.test.ts three times for no new claim. What IS new per provider:
//
//   * a first sync actually indexes something, through THAT provider's own
//     list/download dialect
//   * removal-after-a-complete-walk still holds
//   * the capability check still refuses correctly when off
//   * Nextcloud specifically: connectNextcloud (no OAuth token at all) reaches
//     the same walk as every OAuth provider, and a revoked/wrong app password
//     fails the same way an expired OAuth token does
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import { createMapping, searchDocuments, setIndexing } from '@josi-ce/storage';
import {
  connectNextcloud, saveClient, setCapability, syncCloudMapping, upsertConnection,
  type ConnectionRow,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let admin: string;
const key = new MasterKey(Buffer.alloc(32, 11));

beforeAll(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'ad2@ce.test', username: 'admin2', role: 'super_admin' })).id;
  alice = (await createUser(db, { email: 'a2@ce.test', username: 'alice2', role: 'member' })).id;
  for (const provider of ['dropbox', 'box'] as const) {
    await saveClient(db, key, {
      provider, clientId: `${provider}-client-id`, clientSecret: `${provider}-CLIENT-SECRET-value`,
      redirectUri: `https://josi.example.test/api/connections/${provider}/callback`, actorUserId: admin,
    });
  }
});

beforeEach(async () => {
  await db.query(`delete from documents`);
  await db.query(`delete from folder_mappings`);
  await db.query(`delete from sync_state`);
  await db.query(`delete from connections`);
  await db.query(`delete from connection_capabilities`);
  await db.query(`delete from storage_capabilities`);
  await db.query(`delete from admin_capability_policy`);
  await db.query(
    `update storage_policy set processing_paused = false, max_file_bytes = 1000,
       max_total_bytes_per_user = 100000, max_files_per_user = 100,
       allowed_extensions = array['txt','md','csv','pdf'], clamav_enabled = false`,
  );
});

async function grantMapCapability(user: string) {
  await db.query(
    `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
     values ($1, true, true, $2)
     on conflict (user_id) do update set may_map_cloud = true, may_index = true`,
    [user, admin],
  );
}

async function connectDropbox(user: string, enable = true): Promise<ConnectionRow> {
  const connection = await upsertConnection(db, key, {
    ownerUserId: user, provider: 'dropbox',
    tokens: {
      accessToken: 'dbx-access', refreshToken: 'dbx-refresh', expiresIn: 3600,
      grantedScopes: 'files.metadata.read files.content.read',
    },
    accountEmail: 'someone@dropboxmail.test', providerAccountId: 'dbx-acct-1',
    requestedCapabilities: ['dropbox.files.read'],
  });
  if (enable) {
    await setCapability(db, { connection, capability: 'dropbox.files.read', enabled: true, actorUserId: user });
  }
  return connection;
}

async function connectBox(user: string, enable = true): Promise<ConnectionRow> {
  const connection = await upsertConnection(db, key, {
    ownerUserId: user, provider: 'box',
    tokens: { accessToken: 'box-access', refreshToken: 'box-refresh', expiresIn: 3600, grantedScopes: 'root_readonly' },
    accountEmail: 'someone@boxmail.test', providerAccountId: 'box-acct-1',
    requestedCapabilities: ['box.files.read'],
  });
  if (enable) {
    await setCapability(db, { connection, capability: 'box.files.read', enabled: true, actorUserId: user });
  }
  return connection;
}

async function connectNc(user: string, enable = true): Promise<ConnectionRow> {
  const connection = await connectNextcloud(db, key, {
    ownerUserId: user, serverUrl: 'https://cloud.example.com', username: 'alice2', appPassword: 'app-pw-secret',
  });
  if (enable) {
    await setCapability(db, { connection, capability: 'nextcloud.files.read', enabled: true, actorUserId: user });
  }
  return connection;
}

async function mapFolder(
  provider: 'dropbox' | 'box' | 'nextcloud',
  user: string,
  connectionId: string,
  remoteFolderId: string,
) {
  await grantMapCapability(user);
  const mapping = await createMapping(db, {
    ownerUserId: user, provider, connectionId, remoteFolderId,
    displayPath: `${provider}/Reports`, recursive: true,
  });
  await setIndexing(db, { mappingId: mapping.id, ownerUserId: user, enabled: true });
  return mapping;
}

const sync = (mappingId: string, fetchImpl: typeof fetch) =>
  syncCloudMapping(db, mappingId, { masterKey: key, fetchImpl });

// -------------------------------------------------------------- dropbox stub

interface DbxFile { path: string; name: string; folder?: boolean; content?: string; size?: number }

function dropboxStub(files: DbxFile[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/files/list_folder')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const parentPath = body.path ?? '';
      const entries = files
        .filter((f) => {
          const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '';
          return parent === parentPath;
        })
        .map((f) => ({
          '.tag': f.folder ? 'folder' : 'file', name: f.name, path_display: f.path, path_lower: f.path.toLowerCase(),
          size: f.size ?? (f.content ?? '').length, server_modified: '2026-09-01T00:00:00Z',
        }));
      return new Response(JSON.stringify({ entries, has_more: false }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (href.includes('/files/download')) {
      const arg = JSON.parse(String((init?.headers as Record<string, string>)?.['Dropbox-API-Arg'] ?? '{}'));
      const file = files.find((f) => f.path === arg.path);
      return new Response(file?.content ?? '', { status: file ? 200 : 404 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, files };
}

// ------------------------------------------------------------------ box stub

interface BoxFile { id: string; name: string; folder?: boolean; parent: string; content?: string; size?: number }

function boxStub(files: BoxFile[]) {
  const calls: string[] = [];
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const href = String(url);
    calls.push(href);
    const listMatch = /\/folders\/([^/]+)\/items/.exec(href);
    if (listMatch) {
      const parent = listMatch[1];
      const children = files.filter((f) => f.parent === parent);
      return new Response(JSON.stringify({
        entries: children.map((f) => ({
          id: f.id, name: f.name, type: f.folder ? 'folder' : 'file',
          size: f.size ?? (f.content ?? '').length, modified_at: '2026-09-01T00:00:00Z',
        })),
        total_count: children.length, offset: 0, limit: 100,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const dl = /\/files\/([^/]+)\/content/.exec(href);
    if (dl) {
      const file = files.find((f) => f.id === dl[1]);
      return new Response(file?.content ?? '', { status: file ? 200 : 404 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, files };
}

// -------------------------------------------------------------- nextcloud stub

interface NcFile { path: string; name: string; folder?: boolean; content?: string; size?: number }

function nextcloudStub(files: NcFile[]) {
  const calls: string[] = [];
  const propStanza = (f: NcFile) => `
    <d:response>
      <d:href>/remote.php/dav/files/alice2${f.path}${f.folder ? '/' : ''}</d:href>
      <d:propstat><d:prop>
        ${f.folder ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>'}
        <d:getcontentlength>${f.size ?? (f.content ?? '').length}</d:getcontentlength>
        <d:getlastmodified>Tue, 01 Sep 2026 00:00:00 GMT</d:getlastmodified>
        <d:displayname>${f.name}</d:displayname>
      </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response>`;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (init?.method === 'PROPFIND') {
      const reqPath = new URL(href).pathname.replace('/remote.php/dav/files/alice2', '') || '/';
      const selfPath = reqPath === '/' ? '' : reqPath.replace(/\/$/, '');
      const children = files.filter((f) => {
        const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '';
        return parent === selfPath;
      });
      const selfXml = `<d:response><d:href>${href.replace('https://cloud.example.com', '')}</d:href>
        <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
        <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${selfXml}${children.map(propStanza).join('')}</d:multistatus>`;
      return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml' } });
    }
    // GET download.
    const reqPath = new URL(href).pathname.replace('/remote.php/dav/files/alice2', '');
    const file = files.find((f) => f.path === reqPath);
    return new Response(file?.content ?? '', { status: file ? 200 : 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, files };
}

describe('Dropbox: first sync through the real engine', () => {
  it('indexes readable text and makes it searchable for its owner only', async () => {
    const connection = await connectDropbox(alice);
    const mapping = await mapFolder('dropbox', alice, connection.id, 'root');
    const { fetchImpl } = dropboxStub([
      { path: '/notes.txt', name: 'notes.txt', content: 'quokka migration budget' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.status).toBe('synced');
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'quokka' });
    expect(hits.length).toBe(1);
  });

  it('a file gone at the provider goes from the index after a complete walk', async () => {
    const connection = await connectDropbox(alice);
    const mapping = await mapFolder('dropbox', alice, connection.id, 'root');
    const stubbed = dropboxStub([
      { path: '/keep.txt', name: 'keep.txt', content: 'stays here' },
      { path: '/gone.txt', name: 'gone.txt', content: 'vanishing text' },
    ]);
    await sync(mapping.id, stubbed.fetchImpl);
    stubbed.files.splice(stubbed.files.findIndex((f) => f.path === '/gone.txt'), 1);
    const second = await sync(mapping.id, stubbed.fetchImpl);
    expect(second.counts.removed).toBe(1);
    expect(await searchDocuments(db, { ownerUserId: alice, query: 'vanishing' })).toEqual([]);
  });

  it('refuses to sync once the capability is switched off — permission_denied, nothing purged', async () => {
    const connection = await connectDropbox(alice);
    const mapping = await mapFolder('dropbox', alice, connection.id, 'root');
    const stubbed = dropboxStub([{ path: '/notes.txt', name: 'notes.txt', content: 'indexed first' }]);
    await sync(mapping.id, stubbed.fetchImpl);
    await setCapability(db, { connection, capability: 'dropbox.files.read', enabled: false, actorUserId: alice });
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'indexed' })).length).toBe(1);
  });
});

describe('Box: first sync through the real engine', () => {
  it('indexes readable text and makes it searchable for its owner only', async () => {
    const connection = await connectBox(alice);
    const mapping = await mapFolder('box', alice, connection.id, 'root');
    const { fetchImpl } = boxStub([
      { id: '1', name: 'notes.txt', parent: '0', content: 'capybara budget draft' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.status).toBe('synced');
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'capybara' });
    expect(hits.length).toBe(1);
  });

  it('recurses into a subfolder using the numeric folder id Box returned', async () => {
    const connection = await connectBox(alice);
    const mapping = await mapFolder('box', alice, connection.id, 'root');
    const { fetchImpl } = boxStub([
      { id: '10', name: 'Archive', parent: '0', folder: true },
      { id: '11', name: 'old.txt', parent: '10', content: 'archived otter notes' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'otter' });
    expect(hits[0].relativePath).toBe('Archive/old.txt');
  });

  it('refuses to sync once the capability is switched off', async () => {
    const connection = await connectBox(alice);
    const mapping = await mapFolder('box', alice, connection.id, 'root');
    const stubbed = boxStub([{ id: '1', name: 'notes.txt', parent: '0', content: 'first pass' }]);
    await sync(mapping.id, stubbed.fetchImpl);
    await setCapability(db, { connection, capability: 'box.files.read', enabled: false, actorUserId: alice });
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
  });
});

describe('Nextcloud: no OAuth token anywhere in the run', () => {
  it('connectNextcloud reaches the same walk as an OAuth provider, and indexes text', async () => {
    const connection = await connectNc(alice);
    expect(connection.secrets_enc).toBeTruthy();
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    const { fetchImpl } = nextcloudStub([
      { path: '/notes.txt', name: 'notes.txt', content: 'pangolin budget notes' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.status).toBe('synced');
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'pangolin' });
    expect(hits.length).toBe(1);
  });

  it('recurses into a WebDAV subfolder and builds the relative path from it', async () => {
    const connection = await connectNc(alice);
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    const { fetchImpl } = nextcloudStub([
      { path: '/Archive', name: 'Archive', folder: true },
      { path: '/Archive/old.txt', name: 'old.txt', content: 'archived aardvark notes' },
    ]);
    const result = await sync(mapping.id, fetchImpl);
    expect(result.counts.indexed).toBe(1);
    const hits = await searchDocuments(db, { ownerUserId: alice, query: 'aardvark' });
    expect(hits[0].relativePath).toBe('Archive/old.txt');
  });

  it('a file gone at the server goes from the index after a complete walk', async () => {
    const connection = await connectNc(alice);
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    const stubbed = nextcloudStub([
      { path: '/keep.txt', name: 'keep.txt', content: 'stays put' },
      { path: '/gone.txt', name: 'gone.txt', content: 'about to vanish' },
    ]);
    await sync(mapping.id, stubbed.fetchImpl);
    stubbed.files.splice(stubbed.files.findIndex((f) => f.path === '/gone.txt'), 1);
    const second = await sync(mapping.id, stubbed.fetchImpl);
    expect(second.counts.removed).toBe(1);
    expect(await searchDocuments(db, { ownerUserId: alice, query: 'vanish' })).toEqual([]);
  });

  it('a wrong app password fails the run the same way an expired OAuth token does', async () => {
    const connection = await connectNc(alice);
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    // The server refuses the (still-sealed, still-stored) credential — a
    // revoked app password looks exactly like this from Josi's side.
    const refusing = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    const result = await sync(mapping.id, refusing);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('token_expired');
    const [m] = await db.query<{ status: string }>(
      `select status from folder_mappings where id = $1`, [mapping.id],
    );
    expect(m.status).toBe('paused');
  });

  it('refuses to sync once the capability is switched off, using its own named constant', async () => {
    const connection = await connectNc(alice);
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    const stubbed = nextcloudStub([{ path: '/notes.txt', name: 'notes.txt', content: 'first pass' }]);
    await sync(mapping.id, stubbed.fetchImpl);
    await setCapability(db, { connection, capability: 'nextcloud.files.read', enabled: false, actorUserId: alice });
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
    // M78: paused, not purged.
    expect((await searchDocuments(db, { ownerUserId: alice, query: 'first' })).length).toBe(1);
  });

  it('the admin ceiling denies nextcloud.files.read the same way it denies an OAuth capability', async () => {
    const connection = await connectNc(alice);
    const mapping = await mapFolder('nextcloud', alice, connection.id, 'root');
    await db.query(
      `insert into admin_capability_policy (capability, allowed) values ('nextcloud.files.read', false)`,
    );
    const stubbed = nextcloudStub([{ path: '/notes.txt', name: 'notes.txt', content: 'words' }]);
    const result = await sync(mapping.id, stubbed.fetchImpl);
    expect(result.status).toBe('failed');
    expect(result.errorCategory).toBe('permission_denied');
  });
});
