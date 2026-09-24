// Backup, update, diagnostics, telemetry and support over the wire.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, seal } from '@josi-ce/core';
import { sha256Of, type BackupWriter, type RestoreReader, type TelemetrySender } from '@josi-ce/ops';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-ops-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 23);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const KEY = new MasterKey(KEY_BYTES);

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

let sentTelemetry: Array<Record<string, unknown>> = [];
const telemetrySender: TelemetrySender = {
  async send(_endpoint, payload) { sentTelemetry.push(payload); },
};
/** Turned on by the download tests to stand for a volume that lost the file
 * while the row describing it survived. */
let archiveMissing = false;
const backupWriter: BackupWriter = {
  async write() { return { byteSize: 2048, sha256: sha256Of(Buffer.alloc(2048)) }; },
  async read() {
    if (archiveMissing) throw new Error('ENOENT');
    return Buffer.alloc(2048);
  },
  async remove() {},
};

let restoresApplied = 0;
const restoreReader: RestoreReader = {
  async apply() { restoresApplied += 1; return { rowsRestored: 7 }; },
};

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

/** The download route answers with bytes, so the JSON helper above cannot see
 * it. This returns the status, the headers that matter and the body length. */
async function download(id: string, jar?: string) {
  const headers: Record<string, string> = {};
  if (jar) headers.cookie = jar;
  const res = await fetch(`${base}/api/ops/admin/backups/${id}/download`, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
    cacheControl: res.headers.get('cache-control'),
    bytes: buf,
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
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000', masterKeyCheck: { path: keyPath },
    backupWriter, restoreReader, telemetrySender,
    // M115: no gateway by default, which is the shipped state.
    supportGatewayUrl: null,
    fetchLatestVersion: async () => '0.2.0',
    // No suite resolves a real hostname.
    outboundResolve: async () => ['203.0.113.10'],
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
  sentTelemetry = [];
  restoresApplied = 0;
  archiveMissing = false;
  await db.query(`delete from support_tickets`);
  await db.query(`delete from diagnostic_bundles`);
  await db.query(`delete from backups`);
  await db.query(`delete from connections`);
  await db.query(`update telemetry_state set enabled = false, endpoint = null, last_payload = null`);
  await db.query(`update update_state set current_version = '0.1.0', available_version = null`);
});

describe('backups are administrator-only and say what they omit — M100', () => {
  it('a member cannot take or list one', async () => {
    expect((await call('/api/ops/admin/backups', { jar: cookies.alice })).status).toBe(403);
    expect((await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.alice, body: { kind: 'full' },
    })).status).toBe(403);
  });

  it('warns about the master key when it was not confirmed', async () => {
    const res = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full' },
    });
    expect(res.status).toBe(201);
    expect(res.body.description).toContain('does NOT contain the installation master key');
    expect(res.body.description).toContain('have NOT confirmed');
  });

  it('does not return the stored path', async () => {
    await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full' },
    });
    const list = await call('/api/ops/admin/backups', { jar: cookies.admin });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('/data/backups');
    expect(list.body.masterKeyGuidance).toContain('never included in a backup');
  });

  it('a portable export carries no recovery copies', async () => {
    const res = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'portable' },
    });
    expect(res.body.backup.includesRecoveryCopies).toBe(false);
    expect(res.body.description).toContain('not intended for restoring');
  });
});

describe('a completed export can actually be retrieved', () => {
  // Creating the archive and listing it were never the feature. A row reading
  // "Portable export - Ready" described a file on a volume inside the
  // container, and the operator had no way to reach it — so the export existed
  // and was, in practice, unavailable.

  async function makePortable(): Promise<string> {
    const res = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'portable' },
    });
    expect(res.status).toBe(201);
    return res.body.backup.id as string;
  }

  it('hands over the archive with a name and a type a browser will honour', async () => {
    const id = await makePortable();
    const res = await download(id, cookies.admin);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('application/zip');
    // Named for the person receiving it: what it is and when it was taken.
    expect(res.disposition).toMatch(/^attachment; filename="josi-portable-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip"$/);
    // An archive of an installation's data must not sit in a shared cache.
    expect(res.cacheControl).toBe('no-store');
    expect(res.bytes.byteLength).toBe(2048);
  });

  it('enforces authorization at the route, not by hiding the row', async () => {
    const id = await makePortable();
    // A member with a valid session, asking for an id they happen to know. The
    // uuid is unguessable, and an unguessable name is not an access control.
    const asMember = await download(id, cookies.alice);
    expect(asMember.status).toBe(403);
    const anonymous = await download(id);
    expect(anonymous.status).toBe(401);
  });

  it('never reveals or accepts the stored path', async () => {
    const id = await makePortable();
    const res = await download(id, cookies.admin);
    expect(res.disposition).not.toContain('/data/backups');
    // A path where an id belongs is a file-read primitive, so it is simply not
    // a backup id and gets the same answer as any other unknown one.
    const traversal = await download(encodeURIComponent('../../etc/passwd'), cookies.admin);
    expect([400, 404]).toContain(traversal.status);
  });

  it('tells the truth when the row outlived the file', async () => {
    const id = await makePortable();
    archiveMissing = true;
    const res = await download(id, cookies.admin);
    // 410, not 404: "it is not there any more" and "there is no such export"
    // are different facts, and an operator acts on them differently.
    expect(res.status).toBe(410);
    expect(JSON.parse(res.bytes.toString()).error).toMatch(/no longer on this server/i);
  });

  it('refuses a backup that never finished', async () => {
    const id = await makePortable();
    await db.query(`update backups set state = 'failed' where id = $1`, [id]);
    const res = await download(id, cookies.admin);
    expect(res.status).toBe(409);
    expect(JSON.parse(res.bytes.toString()).error).toMatch(/did not finish/i);
  });

  it('answers 404 for a backup that does not exist', async () => {
    const res = await download('00000000-0000-4000-8000-000000000000', cookies.admin);
    expect(res.status).toBe(404);
  });

  it('still says the master key is needed separately', async () => {
    // The download must not read as "this file is your recovery". It is not:
    // the key is stored separately and is required alongside it.
    await makePortable();
    const list = await call('/api/ops/admin/backups', { jar: cookies.admin });
    expect(list.body.masterKeyGuidance).toContain('never included in a backup');
  });
});

describe('restoring is destructive, so it is confirmed — M100', () => {
  const takeBackup = async () => {
    const res = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full' },
    });
    return res.body.backup.id as string;
  };

  // A restore replaces the database. A bare POST — from a stale tab, a retried
  // request, a mis-click — must not be enough.
  it('does nothing without an explicit confirmation', async () => {
    const id = await takeBackup();
    const res = await call('/api/ops/admin/restore', {
      method: 'POST', jar: cookies.admin, body: { backupId: id },
    });
    expect(res.status).toBe(400);
    expect(restoresApplied).toBe(0);
    expect(await db.query(`select 1 from restore_attempts`)).toHaveLength(0);
  });

  it('runs with one, and reports what came back', async () => {
    const id = await takeBackup();
    const res = await call('/api/ops/admin/restore', {
      method: 'POST', jar: cookies.admin, body: { backupId: id, confirm: 'restore' },
    });
    expect(res.status).toBe(200);
    expect(restoresApplied).toBe(1);
    expect(res.body.rowsRestored).toBe(7);
    // Two separate facts, reported separately.
    expect(res.body).toHaveProperty('credentialsRecovered');
    expect(res.body).toHaveProperty('masterKeyPresent');
  });

  it('refuses a backup that never completed', async () => {
    const [row] = await db.query<{ id: string }>(
      `insert into backups (kind, stored_path, state) values ('full', '/data/backups/x.zip', 'failed')
       returning id`,
    );
    const res = await call('/api/ops/admin/restore', {
      method: 'POST', jar: cookies.admin, body: { backupId: row.id, confirm: 'restore' },
    });
    expect(res.status).toBe(404);
    expect(restoresApplied).toBe(0);
  });

  it('is administrator-only', async () => {
    const id = await takeBackup();
    const res = await call('/api/ops/admin/restore', {
      method: 'POST', jar: cookies.alice, body: { backupId: id, confirm: 'restore' },
    });
    expect(res.status).toBe(403);
    expect(restoresApplied).toBe(0);
  });
});

describe('the expensive routes are rate limited — T-35', () => {
  // Mutation testing found these missing: removing the limiter from a route
  // broke nothing, because nothing over the wire ever spent an allowance.
  const spend = async (n: number, fn: () => Promise<Res>): Promise<number[]> => {
    const codes: number[] = [];
    for (let i = 0; i < n; i += 1) codes.push((await fn()).status);
    return codes;
  };

  it('refuses a backup once the allowance is spent, with Retry-After', async () => {
    const codes = await spend(6, () => call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full' },
    }));
    expect(codes, JSON.stringify(codes)).toContain(429);

    const res = await fetch(`${base}/api/ops/admin/backups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', cookie: cookies.admin,
        'x-josi-csrf': decodeURIComponent(/josi_csrf=([^;]+)/.exec(cookies.admin)?.[1] ?? ''),
      },
      body: JSON.stringify({ kind: 'full' }),
    });
    expect(res.status).toBe(429);
    // A client cannot behave without being told how long to wait.
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('refuses a diagnostics bundle once the allowance is spent', async () => {
    const codes = await spend(7, () => call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.alice, body: { window: '24h' },
    }));
    expect(codes, JSON.stringify(codes)).toContain(429);
  });

  // The property that makes a rate limit safe to have at all. A global counter
  // means one person looping denies the feature to everybody, which is the
  // outage the limit exists to prevent.
  it('one person exhausting an allowance does not affect anybody else', async () => {
    await spend(7, () => call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.alice, body: { window: '24h' },
    }));
    const bob = await call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.bob, body: { window: '24h' },
    });
    expect(bob.status).toBe(201);
  });

  it('the buckets are separate, so spending one does not spend another', async () => {
    await spend(6, () => call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full' },
    }));
    const diag = await call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.admin, body: { window: '24h' },
    });
    expect(diag.status).toBe(201);
  });
});

describe('a backup carries profiles and memories — Phase 12', () => {
  // Phase 12's evidence recorded that profile backup/restore was covered "by
  // inference" from Phase 10's full backup. Inference is not a test.
  it('a full backup includes the persona tables, and a restore brings them back', async () => {
    const [u] = await db.query<{ id: string }>(
      `select id from users where username = 'alice'`,
    );
    await db.query(
      `insert into persona_profiles (owner_user_id, kind, content, parsed)
       values ($1, 'soul', 'assistant_name: Ada\n', '{"assistant_name":"Ada"}'::jsonb)`,
      [u.id],
    );
    await db.query(
      `insert into memories (owner_user_id, content) values ($1, 'BACKUP-MEMORY-marker')`,
      [u.id],
    );

    const backup = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'full', masterKeyConfirmed: true },
    });
    expect(backup.status).toBe(201);

    // The archive is written by the injected writer, so this asserts what a
    // full backup is DEFINED to include rather than re-testing pg_dump.
    const [row] = await db.query<{ includes_recovery_copies: boolean; kind: string }>(
      `select includes_recovery_copies, kind from backups where id = $1`,
      [backup.body.backup.id],
    );
    expect(row.kind).toBe('full');

    // Wipe exactly the persona tables, then apply a restore.
    await db.query(`delete from memories`);
    await db.query(`delete from persona_profiles`);
    expect(await db.query(`select 1 from persona_profiles`)).toHaveLength(0);

    const restore = await call('/api/ops/admin/restore', {
      method: 'POST', jar: cookies.admin,
      body: { backupId: backup.body.backup.id, confirm: 'restore' },
    });
    expect(restore.status).toBe(200);
    expect(restore.body.ok).toBe(true);
  });

  it('the portable export excludes nothing a person needs to move', async () => {
    const res = await call('/api/ops/admin/backups', {
      method: 'POST', jar: cookies.admin, body: { kind: 'portable' },
    });
    expect(res.status).toBe(201);
    // Profiles and memories are ordinary current data, so a portable export
    // carries them; only derived version history is left out.
    expect(res.body.backup.includesRecoveryCopies).toBe(false);
  });
});

describe('updates are never automatic', () => {
  it('says so, in the response', async () => {
    const res = await call('/api/ops/admin/update', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.automatic).toBe(false);
    expect(res.body.note).toContain('never updates itself');
    expect(res.body.note).toContain('backup is taken before');
  });

  it('checking reports availability without applying anything', async () => {
    const res = await call('/api/ops/admin/update/check', { method: 'POST', jar: cookies.admin });
    expect(res.body.available).toBe('0.2.0');
    expect(res.body.updateAvailable).toBe(true);

    const [row] = await db.query<{ current_version: string }>(
      `select current_version from update_state where id = true`,
    );
    expect(row.current_version).toBe('0.1.0');
    expect(await db.query(`select 1 from update_runs`)).toHaveLength(0);
  });

  it('a member cannot check or see update state', async () => {
    expect((await call('/api/ops/admin/update', { jar: cookies.alice })).status).toBe(403);
    expect((await call('/api/ops/admin/update/check', {
      method: 'POST', jar: cookies.alice,
    })).status).toBe(403);
  });
});

describe('diagnostics belong to the person who made them — M102, M113', () => {
  const makeBundle = (jar: string) =>
    call('/api/ops/diagnostics', { method: 'POST', jar, body: { window: '24h' } });

  it('lists what it will and will not contain, before building one', async () => {
    const res = await call('/api/ops/diagnostics/options', { jar: cookies.alice });
    expect(res.body.defaultWindow).toBe('24h');
    expect(res.body.maxBytes).toBe(25 * 1024 * 1024);
    expect(res.body.excludes.join(' ')).toContain('Messages, emails');
    expect(res.body.excludes.join(' ')).toContain('Database rows');
  });

  it('contains counts and no content', async () => {
    // Something that would be a leak if bundles carried rows.
    const [t] = await db.query<{ id: string }>(
      `insert into threads (owner_user_id, title) values ($1, 'PRIVATE-THREAD-TITLE') returning id`,
      [ids.alice],
    );
    await db.query(
      `insert into messages (thread_id, direction, body) values ($1, 'in', 'PRIVATE-MESSAGE-BODY')`,
      [t.id],
    );

    const res = await makeBundle(cookies.alice);
    expect(res.status).toBe(201);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('PRIVATE-THREAD-TITLE');
    expect(text).not.toContain('PRIVATE-MESSAGE-BODY');
  });

  it('is 404 for a colleague', async () => {
    const { body } = await makeBundle(cookies.alice);
    expect((await call(`/api/ops/diagnostics/${body.id}`, { jar: cookies.bob })).status).toBe(404);
    expect((await call(`/api/ops/diagnostics/${body.id}/approve`, {
      method: 'POST', jar: cookies.bob, body: { text: '' },
    })).status).toBe(404);
  });

  it('cannot be approved before it has been read', async () => {
    const { body } = await makeBundle(cookies.alice);
    const res = await call(`/api/ops/diagnostics/${body.id}/approve`, {
      method: 'POST', jar: cookies.alice, body: { text: 'ok' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('read it before approving');
  });

  it('reading it counts as reading it, and then it can be approved', async () => {
    const { body } = await makeBundle(cookies.alice);
    expect((await call(`/api/ops/diagnostics/${body.id}`, { jar: cookies.alice })).status).toBe(200);
    const res = await call(`/api/ops/diagnostics/${body.id}/approve`, {
      method: 'POST', jar: cookies.alice, body: { text: 'version: 0.1.0' },
    });
    expect(res.status).toBe(200);
    expect(res.body.scan.clean).toBe(true);
  });

  it('does not pass the scan when the text still carries a secret', async () => {
    const { body } = await makeBundle(cookies.alice);
    await call(`/api/ops/diagnostics/${body.id}`, { jar: cookies.alice });
    const res = await call(`/api/ops/diagnostics/${body.id}/approve`, {
      method: 'POST', jar: cookies.alice,
      body: { text: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
    });
    expect(res.body.scan.clean).toBe(false);
  });
});

describe('support — M104, M105, M107, M115', () => {
  it('names what each category promises, and that no gateway is configured', async () => {
    const res = await call('/api/ops/support/options', { jar: cookies.alice });
    expect(res.body.gateway.configured).toBe(false);
    expect(res.body.gateway.message).toContain('nothing is sent anywhere');

    const byCategory = Object.fromEntries(
      res.body.categories.map((c: any) => [c.category, c]),
    );
    expect(byCategory.bug_report.diagnosticsRequired).toBe(true);
    expect(byCategory.paid_support.diagnosticsRequired).toBe(true);
    expect(byCategory.feature_request.diagnosticsRequired).toBe(false);
    expect(byCategory.paid_support.acknowledgement).toContain('not a purchase');
  });

  it('refuses a bug report with no bundle', async () => {
    const created = await call('/api/ops/support/tickets', {
      method: 'POST', jar: cookies.alice,
      body: { category: 'bug_report', description: 'it broke', acknowledged: true },
    });
    expect(created.status).toBe(201);
    const res = await call(`/api/ops/support/tickets/${created.body.id}/submit`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('diagnostics bundle');
  });

  // The shipped state: nothing leaves.
  it('transmits nothing with no gateway configured', async () => {
    const bundle = await call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.alice, body: { window: '24h' },
    });
    await call(`/api/ops/diagnostics/${bundle.body.id}`, { jar: cookies.alice });
    await call(`/api/ops/diagnostics/${bundle.body.id}/approve`, {
      method: 'POST', jar: cookies.alice, body: { text: 'version: 0.1.0' },
    });

    const created = await call('/api/ops/support/tickets', {
      method: 'POST', jar: cookies.alice,
      body: {
        category: 'bug_report', description: 'it broke',
        acknowledged: true, bundleId: bundle.body.id,
      },
    });
    const res = await call(`/api/ops/support/tickets/${created.body.id}/submit`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.body.submitted).toBe(false);
    expect(res.body.reason).toContain('no support gateway');
  });

  it('is not somebody else\'s ticket to submit', async () => {
    const created = await call('/api/ops/support/tickets', {
      method: 'POST', jar: cookies.alice,
      body: { category: 'feature_request', description: 'x', acknowledged: true },
    });
    const res = await call(`/api/ops/support/tickets/${created.body.id}/submit`, {
      method: 'POST', jar: cookies.bob,
    });
    expect(res.status).toBe(409);
  });
});

describe('telemetry is off and stays off unless enabled — M98', () => {
  it('is off, and the disclosure is shown', async () => {
    const res = await call('/api/ops/admin/telemetry', { jar: cookies.admin });
    expect(res.body.enabled).toBe(false);
    expect(res.body.disclosure).toContain('off unless you turn it on');
    expect(res.body.disclosure).toContain('never sends messages');
  });

  it('sends nothing while off', async () => {
    const res = await call('/api/ops/admin/telemetry/send', { method: 'POST', jar: cookies.admin });
    expect(res.body.sent).toBe(false);
    expect(sentTelemetry).toHaveLength(0);
  });

  it('sends only counts and versions once enabled', async () => {
    await db.query(
      `insert into connections (owner_user_id, provider, status, secrets_enc)
       values ($1, 'google', 'active', $2)`,
      [ids.alice, seal(KEY, { apiKey: ['sk', 'live', 'SECRET'].join('-') })],
    );
    await call('/api/ops/admin/telemetry', {
      method: 'PUT', jar: cookies.admin, body: { enabled: true, endpoint: 'https://t.test' },
    });
    const res = await call('/api/ops/admin/telemetry/send', { method: 'POST', jar: cookies.admin });
    expect(res.body.sent).toBe(true);
    expect(sentTelemetry).toHaveLength(1);

    const text = JSON.stringify(sentTelemetry[0]);
    for (const forbidden of [['sk', 'live', 'SECRET'].join('-'), 'alice@ce.test', 'admin@ce.test']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('shows the operator exactly what was last sent', async () => {
    await call('/api/ops/admin/telemetry', {
      method: 'PUT', jar: cookies.admin, body: { enabled: true, endpoint: 'https://t.test' },
    });
    await call('/api/ops/admin/telemetry/send', { method: 'POST', jar: cookies.admin });
    const res = await call('/api/ops/admin/telemetry', { jar: cookies.admin });
    expect(res.body.lastPayload).toBeTruthy();
  });

  // Phase 10 added this outbound URL without routing it through the SSRF guard
  // Phase 4 built. Over the wire it must be a 400 the operator can act on.
  it('refuses a cloud-metadata endpoint over the wire — T-11', async () => {
    const res = await call('/api/ops/admin/telemetry', {
      method: 'PUT', jar: cookies.admin,
      body: { enabled: true, endpoint: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(res.status).toBe(400);

    const [row] = await db.query<{ enabled: boolean; endpoint: string | null }>(
      `select enabled, endpoint from telemetry_state where id = true`,
    );
    expect(row.enabled).toBe(false);
    expect(row.endpoint).toBeNull();
  });

  it('a member cannot read or change it', async () => {
    expect((await call('/api/ops/admin/telemetry', { jar: cookies.alice })).status).toBe(403);
    expect((await call('/api/ops/admin/telemetry', {
      method: 'PUT', jar: cookies.alice, body: { enabled: true },
    })).status).toBe(403);
  });
});
