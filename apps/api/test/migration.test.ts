import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { LIMITS } from '../../../packages/persona/src/migration/types.js';

let db: TestDb, server: Server, base: string;
const jars: Record<string, string> = {}, ids: Record<string, string> = {};
const secret = 'password: synthetic-wire-example';
let failInsert = false;

function merge(jar: string, cookies: string[]): string {
  const pairs = new Map(jar.split(';').filter(Boolean).map(part => { const i = part.indexOf('='); return [part.slice(0, i).trim(), part.slice(i + 1).trim()]; }));
  for (const cookie of cookies) { const part = cookie.split(';')[0], i = part.indexOf('='); pairs.set(part.slice(0, i), part.slice(i + 1)); }
  return [...pairs].map(([key, value]) => `${key}=${value}`).join('; ');
}
async function requestAt(origin: string, path: string, method = 'GET', body?: unknown, as = 'alice', csrf = true) {
  const headers: Record<string, string> = {};
  if (jars[as]) headers.cookie = jars[as];
  if (csrf && jars[as]) headers['x-josi-csrf'] = decodeURIComponent(/josi_csrf=([^;]+)/.exec(jars[as])?.[1] ?? '');
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}/api${path}`, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}
const request = (path: string, method = 'GET', body?: unknown, as = 'alice', csrf = true) => requestAt(base, path, method, body, as, csrf);
function form(path = 'MEMORY.md', content: string | Uint8Array = '- Synthetic morning preference') {
  const body = new FormData(); body.append('files', new Blob([content]), path); return body;
}
async function scan(content = '- Synthetic morning preference', source = 'openclaw', as = 'alice') {
  const result = await request(`/migrations/scan?source=${source}`, 'POST', form('MEMORY.md', content), as);
  expect(result.status).toBe(200); return result.body;
}
async function reviewed(content?: string) {
  const preview = await scan(content);
  const result = await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: preview.manifest.items.filter((item: any) => item.content).map((item: any) => ({ id: item.id })) });
  expect(result.status).toBe(200); return { ...preview, ...result.body };
}
beforeAll(async () => {
  db = await testDb(); await ensureWorkspace(db);
  for (const name of ['alice', 'bob', 'admin']) ids[name] = (await createUser(db, { email: `migration-${name}@example.test`, username: `migration-${name}`, role: name === 'admin' ? 'super_admin' : 'member', password: 'synthetic-test-password-123' })).id;
  const wrapped: TestDb = { ...db, transaction: work => db.transaction!(tx => work({ query: async <T>(sql: string, params?: unknown[]) => {
    if (failInsert && sql.startsWith('insert into memories')) throw new Error('Synthetic private-content SQL parameter');
    return tx.query<T>(sql, params);
  } })) };
  const app = createApp(wrapped, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: false });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const name of ['alice', 'bob', 'admin']) {
    const pre = await fetch(`${base}/api/auth/csrf`); let jar = merge('', pre.headers.getSetCookie());
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar,
      'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(jar)![1]) }, body: JSON.stringify({ identifier: `migration-${name}`, password: 'synthetic-test-password-123' }) });
    expect(login.status).toBe(200); jars[name] = merge(jar, login.headers.getSetCookie());
  }
});
beforeEach(async () => { failInsert = false; vi.restoreAllMocks(); await db.exec('delete from migration_previews; delete from migration_archives; delete from persona_versions; delete from persona_profiles; delete from memories; delete from migration_batches;'); });
afterAll(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => server.close(() => resolve())); });

describe('migration HTTP boundaries', () => {
  it('requires a session and CSRF before accepting an upload', async () => {
    expect((await request('/migrations/scan', 'POST', form(), 'anonymous')).status).toBeGreaterThanOrEqual(400);
    expect((await request('/migrations/scan', 'POST', form(), 'alice', false)).status).toBe(403);
    expect((await request('/migrations/batches', 'GET', undefined, 'anonymous')).status).toBe(401);
  });
  it('scans ephemerally, edits memories, reviews and commits exactly once with provenance', async () => {
    const preview = await scan();
    expect(await db.query('select id from migration_batches')).toHaveLength(0); expect(await db.query('select id from memories')).toHaveLength(0);
    const item = preview.manifest.items.find((value: any) => value.category === 'memory');
    const review = await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: [{ id: item.id, content: 'Redacted synthetic memory' }] });
    expect(review.status).toBe(200); expect(review.body.manifest.items[0].classification).toBe('transformed');
    const commitBody = { revision: review.body.revision, confirm: 'import', ownerUserId: ids.bob, tenantId: randomUUID() };
    const committed = await request(`/migrations/${preview.previewId}/commit`, 'POST', commitBody);
    expect(committed.status).toBe(200); expect(committed.body.receipt.created).toBe(1);
    expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', commitBody)).body).toEqual(committed.body);
    const [row] = await db.query<any>('select * from memories'); expect(row.owner_user_id).toBe(ids.alice); expect(row.content).toBe('Redacted synthetic memory');
    expect(row.migration_batch_id).toBe(committed.body.receipt.batchId); expect(row.source_provenance.path).toBe('MEMORY.md');
    expect(committed.headers.get('cache-control')).toBe('no-store');
  });
  it('refuses direct commit, forged item IDs and stale review revisions', async () => {
    const preview = await scan();
    expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import' })).status).toBe(409);
    expect((await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: [{ id: 'forged' }] })).status).toBe(400);
    const review = await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: [{ id: preview.manifest.items[0].id }] });
    expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: randomUUID() })).status).toBe(409);
    expect(review.status).toBe(200); expect(await db.query('select id from memories')).toHaveLength(0);
  });
  it('refuses secrets before preview and rescans memory edits', async () => {
    const refused = await scan(secret);
    expect(refused.manifest.items[0].classification).toBe('sensitive/refused'); expect(JSON.stringify(refused)).not.toContain(secret);
    const preview = await scan();
    const edited = await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: [{ id: preview.manifest.items[0].id, content: secret }] });
    expect(edited.status).toBe(400); expect(JSON.stringify(edited.body)).not.toContain(secret);
  });
  it('isolates previews, batch receipts and rollback from both colleagues and administrators', async () => {
    const preview = await reviewed();
    for (const user of ['bob', 'admin']) {
      expect((await request(`/migrations/${preview.previewId}/review`, 'POST', { selections: [] }, user)).status).toBe(404);
      expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: preview.revision }, user)).status).toBe(404);
      expect((await request(`/migrations/previews/${preview.previewId}`, 'DELETE', undefined, user)).status).toBe(404);
    }
    const result = await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: preview.revision });
    for (const user of ['bob', 'admin']) {
      expect((await request('/migrations/batches', 'GET', undefined, user)).body.batches).toEqual([]);
      expect((await request(`/migrations/batches/${result.body.receipt.batchId}`, 'GET', undefined, user)).status).toBe(404);
      expect((await request(`/migrations/batches/${result.body.receipt.batchId}/rollback`, 'POST', { confirm: 'rollback' }, user)).status).toBe(404);
    }
  });
  it('reviews and commits a durable preview through a different API replica', async () => {
    const replica = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: false }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => replica.once('listening', resolve));
    const origin = `http://127.0.0.1:${(replica.address() as AddressInfo).port}`;
    try {
      const preview = await scan();
      const review = await requestAt(origin, `/migrations/${preview.previewId}/review`, 'POST', { selections: [{ id: preview.manifest.items[0].id }] });
      expect(review.status).toBe(200);
      const committed = await requestAt(origin, `/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: review.body.revision });
      expect(committed.status).toBe(200); expect(committed.body.receipt.created).toBe(1);
      expect(await db.query('select id from migration_previews where id=$1', [preview.previewId])).toHaveLength(0);
      const retry = await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: review.body.revision });
      expect(retry.body).toEqual(committed.body);
    } finally { await new Promise<void>(resolve => replica.close(() => resolve())); }
  });
  it('binds durable previews to the installation identity, rejecting a foreign tenant', async () => {
    const preview = await reviewed();
    const [identity] = await db.query<{ install_id: string }>('select install_id from install_identity');
    await db.query('update install_identity set install_id = $1', [randomUUID()]);
    try { expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: preview.revision })).status).toBe(404); }
    finally { await db.query('update install_identity set install_id = $1', [identity.install_id]); }
  });
  it('discards and expires durable sanitized previews without creating import rows', async () => {
    const first = await scan();
    expect((await request(`/migrations/previews/${first.previewId}`, 'DELETE')).status).toBe(200);
    expect((await request(`/migrations/${first.previewId}/review`, 'POST', { selections: [] })).status).toBe(404);
    const second = await scan(); const future = Date.now() + LIMITS.previewMs + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect((await request(`/migrations/${second.previewId}/review`, 'POST', { selections: [] })).status).toBe(404);
    expect(await db.query('select id from migration_batches')).toHaveLength(0);
    expect(await db.query('select id from migration_previews')).toHaveLength(0);
  });
  it('refuses ZIP-slip and oversized multipart entries before preview', async () => {
    const zip = zipSync({ '../MEMORY.md': strToU8('Synthetic') });
    expect((await request('/migrations/scan?source=openclaw', 'POST', form('hostile.zip', zip))).status).toBe(413);
    expect((await request('/migrations/scan?source=openclaw', 'POST', form('MEMORY.md', 'x'.repeat(LIMITS.entryBytes + 1)))).status).toBe(413);
    expect(await db.query('select id from memories')).toHaveLength(0);
  });
  it('applies the aggregate multipart limit while receiving many individually bounded files', async () => {
    const body = new FormData(); for (let i = 0; i < 9; i++) body.append('files', new Blob(['x'.repeat(LIMITS.entryBytes)]), `memory${i}.md`);
    expect((await request('/migrations/scan?source=openclaw', 'POST', body)).status).toBe(413);
  });
  it('reports database failure safely and atomically without logging content', async () => {
    const preview = await reviewed('Synthetic private-content marker');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined); failInsert = true;
    const result = await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: preview.revision });
    expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain('private-content'); expect(log).not.toHaveBeenCalled();
    expect(await db.query('select id from memories')).toHaveLength(0); expect(await db.query('select id from migration_batches')).toHaveLength(0);
    failInsert = false;
    expect((await request(`/migrations/${preview.previewId}/commit`, 'POST', { confirm: 'import', revision: preview.revision })).status).toBe(200);
  });
  it('supports complete rollback and refuses duplicate races without partial import', async () => {
    const first = await reviewed();
    await db.query('insert into memories(owner_user_id,content) values($1,$2)', [ids.alice, 'Synthetic morning preference']);
    expect((await request(`/migrations/${first.previewId}/commit`, 'POST', { confirm: 'import', revision: first.revision })).status).toBe(409);
    const second = await reviewed('A new unrelated synthetic fact');
    const saved = await request(`/migrations/${second.previewId}/commit`, 'POST', { confirm: 'import', revision: second.revision });
    expect((await request(`/migrations/batches/${saved.body.receipt.batchId}/rollback`, 'POST', { confirm: 'rollback' })).body.removed).toBe(1);
    expect((await request(`/migrations/${second.previewId}/commit`, 'POST', { confirm: 'import', revision: second.revision })).status).toBe(409);
    expect(await db.query('select id from memories')).toHaveLength(1);
  });
  it('archives cannot be written, resumed or read by another owner and stay out of prompts', async () => {
    const record = { id: 'synthetic', source: 'cli', started_at: 1789722000, messages: [{ id: 1, session_id: 'synthetic', timestamp: 1789722000, role: 'user', content: 'Synthetic historical marker <script>alert(1)</script>' }] };
    const preview = await request('/migrations/scan?source=hermes', 'POST', form('history.jsonl', JSON.stringify(record)));
    const item = preview.body.manifest.items.find((value: any) => value.category === 'conversation' && value.content);
    const review = await request(`/migrations/${preview.body.previewId}/review`, 'POST', { selections: [{ id: item.id }] });
    expect((await request(`/migrations/${preview.body.previewId}/commit`, 'POST', { confirm: 'import', revision: review.body.revision })).status).toBe(200);
    const archives = await request('/migrations/archives?q=historical'); const id = archives.body.archives[0].id;
    expect((await request(`/migrations/archives/${id}`)).body.archive.content).toContain('<script>'); // Returned as JSON/plain text, never interpreted as HTML.
    for (const user of ['bob', 'admin']) expect((await request(`/migrations/archives/${id}`, 'GET', undefined, user)).status).toBe(404);
    expect((await request(`/migrations/archives/${id}`, 'PUT', { content: 'Overwrite' })).status).toBe(404);
    expect((await request(`/migrations/archives/${id}/resume`, 'POST')).status).toBe(404);
    const prompt = await request('/persona/preview', 'POST', { request: 'Historical marker' });
    expect(prompt.body.text).not.toContain('Synthetic historical');
  });
  it('legacy profile import returns a batch receipt and imports MEMORY safely', async () => {
    const result = await request('/persona/import', 'POST', { version: 1, exported_at: 'synthetic', files: { memory: '- A portable fact  <!-- Synthetic note -->\n', agents_admin: 'proactivity: act_on_routine' } });
    expect(result.status).toBe(200); expect(result.body.receipt.created).toBe(1);
    expect((await request('/persona/export')).body.files.memory).toBe('- A portable fact  <!-- Synthetic note -->\n');
    expect(await db.query("select id from persona_profiles where kind='agents_admin'")).toHaveLength(0);
  });
});
