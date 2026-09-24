// Documents and storage over the wire.
//
// The questions this file exists to answer, all of them about the GRANT rather
// than the parser:
//
//   * can an administrator map a folder for somebody else?      (M47)
//   * can a colleague see, change, or unmap a mapping?          (M68)
//   * does the administrator's view ever contain a path?        (M72)
//   * does revoking really destroy the derived data?            (M54)
//   * does a path leave the mapped folder, ever?                (M45)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey } from '@josi-ce/core';
import { registerRoot } from '@josi-ce/storage';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-storage-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 17);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
void new MasterKey(KEY_BYTES);

const rootsBase = join(dir, 'roots');
const docsRoot = join(rootsBase, 'docs');

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};
let rootId: string;

// The folder name is the thing that must never reach an administrator.
const FOLDER = 'layoffs-legal-review';

interface Res { status: number; body: any }

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
  return { status: res.status, body: await res.json().catch(() => null) };
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
  const pre = await fetch(`${base}/api/auth/csrf`);
  const jar = mergeJar(undefined, pre.headers.getSetCookie?.() ?? []);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', cookie: jar,
      'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)?.[1] ?? ''),
    },
    body: JSON.stringify({ identifier, password }),
  });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.headers.getSetCookie?.() ?? []);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

beforeAll(async () => {
  await mkdir(join(docsRoot, FOLDER), { recursive: true });
  await mkdir(join(dir, 'outside'), { recursive: true });
  await symlink(join(dir, 'outside'), join(docsRoot, 'escape'));

  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin, displayName: 'Ada Admin' })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice, displayName: 'Alice Smith' })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: { path: keyPath },
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  // The limiter is per user and persists across requests, so a suite that takes
  // several backups in one run would otherwise exhaust a real allowance.
  await db.query(`delete from rate_limits`);
  await db.query(`delete from folder_mappings`);
  await db.query(`delete from storage_roots`);
  await db.query(`delete from storage_capabilities`);
  await db.query(`delete from resource_shares`);
  rootId = (await registerRoot(db, {
    containerPath: docsRoot, label: 'Documents', writable: true, base: rootsBase,
  })).id;
});

const enable = (user: string, over: Record<string, boolean> = {}) =>
  call(`/api/storage/admin/capabilities/${ids[user]}`, {
    method: 'PUT', jar: cookies.admin,
    body: {
      mayMapLocal: over.local ?? true,
      mayMapCloud: over.cloud ?? false,
      mayIndex: over.index ?? false,
    },
  });

const mapFolder = (jar: string, over: Record<string, unknown> = {}) =>
  call('/api/storage/mappings', {
    method: 'POST', jar,
    body: { provider: 'local', rootId, relativePath: FOLDER, ...over },
  });

describe('the dual gate over the wire — M47', () => {
  it('refuses before an administrator enables it', async () => {
    const res = await mapFolder(cookies.alice);
    expect(res.status).toBe(403);
    expect((await db.query(`select 1 from folder_mappings`))).toHaveLength(0);
  });

  it('works once enabled, and the mapping belongs to the person who asked', async () => {
    await enable('alice');
    const res = await mapFolder(cookies.alice);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.mapping.owner_user_id).toBe(ids.alice);
  });

  // The heart of M47. An administrator cannot do the user's half.
  it('an administrator cannot map a folder for somebody else', async () => {
    await enable('alice');
    // There is no admin mapping route at all; the closest thing is calling the
    // member route while trying to name someone else as the owner.
    const res = await call('/api/storage/mappings', {
      method: 'POST', jar: cookies.admin,
      body: { provider: 'local', rootId, relativePath: FOLDER, ownerUserId: ids.alice, owner_user_id: ids.alice },
    });
    // Either refused outright (the admin has no capability of their own), or
    // created as the ADMIN's own mapping. Never as Alice's.
    const [row] = await db.query<{ owner_user_id: string }>(`select owner_user_id from folder_mappings`);
    if (res.status === 201) expect(row.owner_user_id).toBe(ids.admin);
    else expect(row).toBeUndefined();
  });

  it('the capability route cannot be reached by a member', async () => {
    const res = await call(`/api/storage/admin/capabilities/${ids.bob}`, {
      method: 'PUT', jar: cookies.alice, body: { mayMapLocal: true },
    });
    expect(res.status).toBe(403);
  });
});

describe('per-user storage quota — item 40h-DECIDED', () => {
  it('a new person has no override: the capability list shows max_bytes null', async () => {
    // Nobody has set anything for bob yet. The list route left-joins
    // storage_capabilities, so a person with no row at all still appears, with
    // max_bytes null — meaning "the workspace default (20GB) applies", not
    // "zero".
    const res = await call('/api/storage/admin/capabilities', { jar: cookies.admin });
    expect(res.status).toBe(200);
    const bob = res.body.users.find((u: any) => u.username === 'bob');
    expect(bob).toBeTruthy();
    expect(bob.max_bytes).toBeNull();
  });

  it('an administrator can set a custom per-user byte quota', async () => {
    const raised = 50 * 1024 * 1024 * 1024; // 50GB, deliberately ABOVE the 20GB default
    const put = await call(`/api/storage/admin/capabilities/${ids.bob}`, {
      method: 'PUT', jar: cookies.admin,
      body: { mayMapLocal: true, mayMapCloud: false, mayIndex: false, maxBytes: raised },
    });
    expect(put.status).toBe(200);

    const res = await call('/api/storage/admin/capabilities', { jar: cookies.admin });
    const bob = res.body.users.find((u: any) => u.username === 'bob');
    expect(Number(bob.max_bytes)).toBe(raised);
  });

  it('a member cannot set their own quota override', async () => {
    const res = await call(`/api/storage/admin/capabilities/${ids.alice}`, {
      method: 'PUT', jar: cookies.alice, body: { maxBytes: 999999999999 },
    });
    expect(res.status).toBe(403);
  });

  it('clearing the override (maxBytes: null) falls back to the workspace default', async () => {
    await call(`/api/storage/admin/capabilities/${ids.bob}`, {
      method: 'PUT', jar: cookies.admin,
      body: { mayMapLocal: true, maxBytes: 5 * 1024 * 1024 * 1024 },
    });
    const cleared = await call(`/api/storage/admin/capabilities/${ids.bob}`, {
      method: 'PUT', jar: cookies.admin,
      body: { mayMapLocal: true, maxBytes: null },
    });
    expect(cleared.status).toBe(200);

    const res = await call('/api/storage/admin/capabilities', { jar: cookies.admin });
    const bob = res.body.users.find((u: any) => u.username === 'bob');
    expect(bob.max_bytes).toBeNull();
  });
});

describe('containment over the wire — M45', () => {
  beforeEach(() => enable('alice'));

  it('refuses traversal', async () => {
    for (const bad of ['../outside', `${FOLDER}/../../outside`, '/etc']) {
      const res = await mapFolder(cookies.alice, { relativePath: bad });
      expect(res.status, bad).toBe(400);
    }
    expect((await db.query(`select 1 from folder_mappings`))).toHaveLength(0);
  });

  it('refuses a symlink that leaves the root', async () => {
    const res = await mapFolder(cookies.alice, { relativePath: 'escape' });
    expect(res.status).toBe(400);
    expect((await db.query(`select 1 from folder_mappings`))).toHaveLength(0);
  });

  it('refuses a root that was never registered', async () => {
    const res = await mapFolder(cookies.alice, { rootId: '00000000-0000-4000-8000-000000000000' });
    expect(res.status).toBe(400);
  });
});

describe('a mapping is private — M68', () => {
  let mappingId: string;
  beforeEach(async () => {
    await enable('alice');
    mappingId = (await mapFolder(cookies.alice)).body.mapping.id;
  });

  it('is 404 for a colleague and for the administrator', async () => {
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/storage/mappings/${mappingId}`, { jar: cookies[who] });
      expect(res.status, who).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(FOLDER);
    }
  });

  it('does not appear in a colleague list', async () => {
    const res = await call('/api/storage/mappings', { jar: cookies.bob });
    expect(res.body.mappings).toHaveLength(0);
  });

  it('cannot be unmapped by a colleague or the administrator', async () => {
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/storage/mappings/${mappingId}`, { method: 'DELETE', jar: cookies[who] });
      expect(res.status, who).toBe(404);
    }
    expect((await db.query(`select 1 from folder_mappings where id = $1`, [mappingId]))).toHaveLength(1);
  });

  it('cannot have its permissions changed by a colleague', async () => {
    const res = await call(`/api/storage/mappings/${mappingId}/permissions`, {
      method: 'PUT', jar: cookies.bob, body: { edit: true },
    });
    expect(res.status).toBe(404);
  });

  // A share lets a colleague READ. It does not let them widen or end the grant —
  // the same rule Phase 8 established for mail threads.
  it('a share grants reading and nothing else', async () => {
    await db.query(
      `insert into resource_shares (resource_type, resource_id, owner_user_id, shared_with_user_id, can_write)
       values ('folder_mapping', $1, $2, $3, true)`,
      [mappingId, ids.alice, ids.bob],
    );
    expect((await call(`/api/storage/mappings/${mappingId}`, { jar: cookies.bob })).status).toBe(200);

    const unmap = await call(`/api/storage/mappings/${mappingId}`, { method: 'DELETE', jar: cookies.bob });
    expect(unmap.status).toBe(404);
    const perms = await call(`/api/storage/mappings/${mappingId}/permissions`, {
      method: 'PUT', jar: cookies.bob, body: { delete: true },
    });
    expect(perms.status).toBe(404);

    // Access does not compound, and this needs a colleague with WRITE access to
    // prove. The sharing tests below give Bob read-only, so they are satisfied
    // whether the route requires `write` or `owner` — mutation testing found
    // that: downgrading the guard to `write` broke nothing.
    const onward = await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.bob, body: { workspace: true },
    });
    expect(onward.status).toBe(404);
    expect(await db.query(
      `select 1 from resource_shares where resource_id = $1 and shared_with_workspace = true`,
      [mappingId],
    )).toHaveLength(0);
  });
});

describe('what a mapping starts as — M47', () => {
  beforeEach(() => enable('alice'));

  it('read-only, unindexed, not recursive', async () => {
    const m = (await mapFolder(cookies.alice)).body.mapping;
    expect(m.may_create).toBe(false);
    expect(m.may_edit).toBe(false);
    expect(m.may_move).toBe(false);
    expect(m.may_delete).toBe(false);
    expect(m.indexing_enabled).toBe(false);
    expect(m.recursive).toBe(false);
  });

  it('says out loud that delete still needs approval every time', async () => {
    const m = (await mapFolder(cookies.alice)).body.mapping;
    const res = await call(`/api/storage/mappings/${m.id}/permissions`, {
      method: 'PUT', jar: cookies.alice, body: { delete: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.notice).toContain('needs your approval');
  });
});

describe('the consent sentence — M49, M50', () => {
  beforeEach(() => enable('alice'));

  it('states that a recursive scope covers future subfolders', async () => {
    const res = await call('/api/storage/consent-preview', {
      method: 'POST', jar: cookies.alice,
      body: { rootId, relativePath: FOLDER, recursive: true, indexing: false },
    });
    expect(res.body.consent).toContain('any subfolder added to it in future');
  });

  it('warns that indexing sends text to the model', async () => {
    const res = await call('/api/storage/consent-preview', {
      method: 'POST', jar: cookies.alice,
      body: { rootId, relativePath: FOLDER, recursive: false, indexing: true },
    });
    expect(res.body.consent).toContain('language model');
  });
});

describe('indexing is a separate consent — M49, M54', () => {
  let mappingId: string;
  beforeEach(async () => {
    await enable('alice', { index: true });
    mappingId = (await mapFolder(cookies.alice)).body.mapping.id;
  });

  const seed = (n: number) => Promise.all(
    Array.from({ length: n }, (_, i) => db.query(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename)
       values ($1, $2, $3, $4)`,
      [mappingId, ids.alice, `f${i}.txt`, `f${i}.txt`],
    )),
  );

  it('turning it off purges the derived data through the route', async () => {
    await call(`/api/storage/mappings/${mappingId}/indexing`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    await seed(4);

    const off = await call(`/api/storage/mappings/${mappingId}/indexing`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.purged.documents).toBe(4);
    expect((await db.query(`select 1 from documents where mapping_id = $1`, [mappingId]))).toHaveLength(0);
  });

  it('unmapping purges too', async () => {
    await seed(2);
    const res = await call(`/api/storage/mappings/${mappingId}`, { method: 'DELETE', jar: cookies.alice });
    expect(res.body.purged.documents).toBe(2);
  });

  // M47's "admin may tighten": taking the capability away must actually take
  // the data too, or the switch is decorative.
  it('an administrator revoking the capability purges what was indexed', async () => {
    await call(`/api/storage/mappings/${mappingId}/indexing`, {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    });
    await seed(3);

    const res = await enable('alice', { index: false });
    expect(res.status).toBe(200);
    expect(res.body.purged).toEqual({ mappings: 1, documents: 3 });
    expect((await db.query(`select 1 from documents where mapping_id = $1`, [mappingId]))).toHaveLength(0);

    const [row] = await db.query<{ indexing_enabled: boolean }>(
      `select indexing_enabled from folder_mappings where id = $1`, [mappingId],
    );
    expect(row.indexing_enabled).toBe(false);
  });
});

describe('the administrator sees metadata and no paths — M72, M74', () => {
  beforeEach(async () => {
    await enable('alice');
    await mapFolder(cookies.alice);
  });

  it('the capability list has counts, not folder names', async () => {
    const res = await call('/api/storage/admin/capabilities', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FOLDER);
    const alice = res.body.users.find((u: any) => u.username === 'alice');
    expect(alice.mappings).toBe(1);
  });

  it('the health view has states, not paths', async () => {
    const res = await call('/api/storage/admin/health', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FOLDER);
  });

  it('the audit log never records the folder name', async () => {
    const rows = await db.query<{ p: string }>(
      `select payload::text as p from events where kind like 'storage.%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.p).not.toContain(FOLDER);
  });

  it('members cannot reach the admin views', async () => {
    for (const path of ['/api/storage/admin/capabilities', '/api/storage/admin/health', '/api/storage/admin/policy']) {
      expect((await call(path, { jar: cookies.alice })).status, path).toBe(403);
    }
  });
});

describe('removing a user — M70', () => {
  it('names shared mappings, and says what happens to private ones', async () => {
    await enable('alice');
    const m = (await mapFolder(cookies.alice)).body.mapping;

    const clean = await call(`/api/storage/admin/users/${ids.alice}/blocking`, { jar: cookies.admin });
    expect(clean.body.blocking).toHaveLength(0);
    expect(clean.body.instruction).toContain('will delete');

    await db.query(
      `insert into resource_shares (resource_type, resource_id, owner_user_id, shared_with_user_id)
       values ('folder_mapping', $1, $2, $3)`,
      [m.id, ids.alice, ids.bob],
    );
    const blocked = await call(`/api/storage/admin/users/${ids.alice}/blocking`, { jar: cookies.admin });
    expect(blocked.body.blocking).toHaveLength(1);
    expect(blocked.body.instruction).toContain('Transfer it');
  });
});

describe('search is owner-scoped over the wire — M68', () => {
  const SECRET = 'northern-region-restructuring';

  const addDoc = async (who: 'alice' | 'bob', mappingId: string, text: string) => {
    const [doc] = await db.query<{ id: string }>(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
       values ($1, $2, $3, $3, 'indexed') returning id`,
      [mappingId, ids[who], `${who}.pdf`],
    );
    await db.query(
      `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
       values ($1, $2, 0, 'page', '3', $3)`,
      [doc.id, ids[who], text],
    );
    return doc.id;
  };

  it('never returns a colleague\'s document', async () => {
    await enable('alice');
    await enable('bob');
    const aliceMap = (await mapFolder(cookies.alice)).body.mapping.id;
    const bobMap = (await call('/api/storage/mappings', {
      method: 'POST', jar: cookies.bob,
      body: { provider: 'local', rootId, relativePath: '' },
    })).body.mapping.id;

    await addDoc('alice', aliceMap, `The ${SECRET} plan is confidential.`);
    await addDoc('bob', bobMap, 'Bob has his own unrelated notes.');

    const mine = await call(`/api/storage/search?q=${encodeURIComponent(SECRET)}`, { jar: cookies.alice });
    expect(mine.body.hits).toHaveLength(1);
    expect(mine.body.hits[0].citation).toContain('page 3');

    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/storage/search?q=${encodeURIComponent(SECRET)}`, { jar: cookies[who] });
      expect(res.body.hits, who).toHaveLength(0);
      expect(JSON.stringify(res.body), who).not.toContain(SECRET);
    }
  });

  it('cannot be widened by a parameter', async () => {
    await enable('alice');
    const aliceMap = (await mapFolder(cookies.alice)).body.mapping.id;
    await addDoc('alice', aliceMap, `The ${SECRET} plan is confidential.`);

    // Anything a caller might try to pass to escape the owner scope. The owner
    // comes from the session and there is no parameter for it.
    for (const q of [
      `q=${SECRET}&ownerUserId=${ids.alice}`,
      `q=${SECRET}&owner_user_id=${ids.alice}`,
      `q=${SECRET}&mappingId=${aliceMap}`,
    ]) {
      const res = await call(`/api/storage/search?${q}`, { jar: cookies.bob });
      expect(res.body.hits, q).toHaveLength(0);
    }
  });
});

describe('search is rate limited — T-35', () => {
  beforeEach(() => enable('alice'));

  // The allowance is 120 a minute, which is right for a thing people do
  // repeatedly and wrong to spend literally in a test. Pre-filling the bucket
  // asserts the same property in one request.
  it('refuses once the allowance is spent', async () => {
    await db.query(
      `insert into rate_limits (bucket, subject, window_started_at, count)
       values ('search', $1, now(), 120)`,
      [`search:${ids.alice}`],
    );
    const res = await call('/api/storage/search?q=anything', { jar: cookies.alice });
    expect(res.status).toBe(429);
  });

  it('and a colleague is unaffected', async () => {
    await db.query(
      `insert into rate_limits (bucket, subject, window_started_at, count)
       values ('search', $1, now(), 120)`,
      [`search:${ids.alice}`],
    );
    const res = await call('/api/storage/search?q=anything', { jar: cookies.bob });
    expect(res.status).toBe(200);
  });
});

describe('semantic search over the wire — M51', () => {
  beforeEach(() => enable('alice'));

  it('is unavailable until the administrator enables it', async () => {
    const res = await call('/api/storage/semantic', { jar: cookies.alice });
    expect(res.body.available).toBe(false);
    expect(res.body.disclosure).toContain('leaves this server');
  });

  it('refuses consent in Local-only, and says so', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await db.query(`update security_policy set local_only = true`);

    const res = await call('/api/storage/semantic/consent', {
      method: 'POST', jar: cookies.alice, body: { provider: 'openai' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Local-only');
    expect(await db.query(`select 1 from semantic_consents`)).toHaveLength(0);
    await db.query(`update security_policy set local_only = false`);
  });

  it('records consent, then withdrawing it purges the vectors', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    const on = await call('/api/storage/semantic/consent', {
      method: 'POST', jar: cookies.alice, body: { provider: 'openai' },
    });
    expect(on.status).toBe(200);

    const off = await call('/api/storage/semantic/consent', { method: 'DELETE', jar: cookies.alice });
    expect(off.status).toBe(200);
    expect(off.body.consented).toBe(false);
    expect(await db.query(`select 1 from semantic_consents`)).toHaveLength(0);
  });
});

describe('sharing a folder — M69', () => {
  let mappingId: string;
  beforeEach(async () => {
    await enable('alice');
    mappingId = (await mapFolder(cookies.alice)).body.mapping.id;
    await db.query(`update storage_policy set sharing_enabled = true, workspace_sharing_enabled = true`);
  });

  it('lets a colleague read, and nothing more', async () => {
    const res = await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.alice, body: { userId: ids.bob },
    });
    expect(res.status).toBe(200);
    expect(res.body.notice).toContain('cannot change it or share it on');

    expect((await call(`/api/storage/mappings/${mappingId}`, { jar: cookies.bob })).status).toBe(200);
    expect((await call(`/api/storage/mappings/${mappingId}`, { method: 'DELETE', jar: cookies.bob })).status).toBe(404);
    expect((await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.bob, body: { workspace: true },
    })).status).toBe(404);
  });

  it('the administrator can turn sharing off entirely', async () => {
    await db.query(`update storage_policy set sharing_enabled = false`);
    const res = await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.alice, body: { userId: ids.bob },
    });
    expect(res.status).toBe(403);
    expect((await call(`/api/storage/mappings/${mappingId}`, { jar: cookies.bob })).status).toBe(404);
  });

  it('can forbid workspace-wide while allowing person-to-person', async () => {
    await db.query(`update storage_policy set workspace_sharing_enabled = false`);
    const broadcast = await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.alice, body: { workspace: true },
    });
    expect(broadcast.status).toBe(403);
    expect(broadcast.body.error).toContain('not with everyone');

    const direct = await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.alice, body: { userId: ids.bob },
    });
    expect(direct.status).toBe(200);
  });

  it('unsharing takes the access back', async () => {
    await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'POST', jar: cookies.alice, body: { userId: ids.bob },
    });
    await call(`/api/storage/mappings/${mappingId}/share`, {
      method: 'DELETE', jar: cookies.alice, body: { userId: ids.bob },
    });
    expect((await call(`/api/storage/mappings/${mappingId}`, { jar: cookies.bob })).status).toBe(404);
  });
});

describe('the global pause and Sync now — M75, M77', () => {
  let mappingId: string;
  beforeEach(async () => {
    await enable('alice');
    mappingId = (await mapFolder(cookies.alice)).body.mapping.id;
    await db.query(`update storage_policy set processing_paused = false, manual_sync_enabled = true`);
    await db.query(`delete from sync_state`);
  });

  it('pausing deletes nothing and says so', async () => {
    const res = await call('/api/storage/admin/pause', {
      method: 'PUT', jar: cookies.admin, body: { paused: true },
    });
    expect(res.status).toBe(200);
    expect(res.body.notice).toContain('Nothing has been deleted');
    expect(res.body.notice).toContain('existing search still works');
  });

  it('a member cannot pause the installation', async () => {
    const res = await call('/api/storage/admin/pause', {
      method: 'PUT', jar: cookies.alice, body: { paused: true },
    });
    expect(res.status).toBe(403);
  });

  it('Sync now is rate-limited', async () => {
    const first = await call(`/api/storage/mappings/${mappingId}/sync`, { method: 'POST', jar: cookies.alice });
    expect(first.status).toBe(200);
    const second = await call(`/api/storage/mappings/${mappingId}/sync`, { method: 'POST', jar: cookies.alice });
    expect(second.status).toBe(429);
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('Sync now cannot bypass the global pause', async () => {
    await call('/api/storage/admin/pause', {
      method: 'PUT', jar: cookies.admin, body: { paused: true },
    });
    const res = await call(`/api/storage/mappings/${mappingId}/sync`, { method: 'POST', jar: cookies.alice });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('paused for the whole installation');
    await call('/api/storage/admin/pause', {
      method: 'PUT', jar: cookies.admin, body: { paused: false },
    });
  });
});

describe('the policy screen says what the settings do — M61, M62, M73', () => {
  it('lets the super admin configure indexing and bounded archive limits', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin,
      body: {
        maxFileBytes: 50 * 1024 * 1024,
        maxTotalBytesPerUser: 4096 * 1024 * 1024,
        maxFilesPerUser: 50_000,
        allowedExtensions: ['txt', 'pdf', 'zip'],
        archivesEnabled: true,
        archiveMaxEntries: 250,
        archiveMaxTotalBytes: 200 * 1024 * 1024,
        archiveMaxDepth: 2,
        archiveMaxSeconds: 60,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.policy).toMatchObject({
      max_file_bytes: 52428800,
      max_total_bytes_per_user: 4294967296,
      max_files_per_user: 50_000,
      allowed_extensions: ['txt', 'pdf', 'zip'],
      archives_enabled: true,
      archive_max_entries: 250,
      archive_max_total_bytes: 209715200,
      archive_max_depth: 2,
      archive_max_seconds: 60,
    });
  });

  it('rejects unsafe or malformed storage-policy values without changing them', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin,
      body: { maxFileBytes: 0, allowedExtensions: ['pdf', '../exe'], archiveMaxDepth: 9 },
    });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toEqual(expect.arrayContaining([
      'maxFileBytes', 'allowedExtensions', 'archiveMaxDepth',
    ]));
  });

  it('spells out that recovery copies are not encrypted', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin,
      body: { historyMode: 'two', historyKind: 'recovery_copy' },
    });
    expect(res.status).toBe(200);
    expect(res.body.historyDisclosure).toContain('NOT encrypted by Josi');
    expect(res.body.historyDisclosure).toContain('full-disk or volume encryption');
  });

  it('warns that keeping the audit trail forever grows without limit', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin, body: { auditRetention: 'forever' },
    });
    expect(res.body.auditNotice).toContain('grows without limit');
    await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin, body: { auditRetention: 'one_year' },
    });
  });

  // A 400 naming the bad fields, not a 500 from the database and not a silent
  // shrug. The first version of this test only checked that the value was not
  // stored — which the CHECK constraint guaranteed on its own, so the route's
  // own validation was never exercised. Mutation testing found it.
  //
  // Saying which field was rejected is the same principle Phase 12 states for
  // profile imports: an ignored instruction must be visible, not silently
  // pretended to have applied.
  it('names a value outside the allowed set rather than storing or crashing on it', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.admin, body: { historyMode: 'everything', auditRetention: 'never' },
    });
    expect(res.status).toBe(400);
    expect(res.body.rejected).toContain('historyMode');
    expect(res.body.rejected).toContain('auditRetention');

    const [row] = await db.query<{ history_mode: string; audit_retention: string }>(
      `select history_mode, audit_retention from storage_policy where id = true`,
    );
    expect(row.history_mode).not.toBe('everything');
    expect(row.audit_retention).not.toBe('never');
  });

  it('members cannot change it', async () => {
    const res = await call('/api/storage/admin/policy', {
      method: 'PUT', jar: cookies.alice, body: { historyMode: 'two' },
    });
    expect(res.status).toBe(403);
  });
});

describe('what a person can see about their own options', () => {
  it('shows no roots at all before the administrator enables mapping', async () => {
    const res = await call('/api/storage/available', { jar: cookies.bob });
    expect(res.body.capability.may_map_local).toBe(false);
    expect(res.body.roots).toHaveLength(0);
  });

  it('shows the operator-declared roots once enabled', async () => {
    await enable('alice');
    const res = await call('/api/storage/available', { jar: cookies.alice });
    expect(res.body.roots).toHaveLength(1);
    expect(res.body.roots[0].label).toBe('Documents');
    // The container path is deployment detail; it is not the user's business
    // and it tells them about the host filesystem.
    expect(JSON.stringify(res.body)).not.toContain(docsRoot);
  });
});
