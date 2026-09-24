// Configuring where backups are kept, without touching the host.
//
// The form this replaces asked for a "secret prefix" — a string like `primary`
// naming files the operator was expected to create on the host and mount into
// the container before any of it worked. That is a deployment procedure wearing
// a settings form, and it put the one thing that saves an installation behind
// the one skill most of its operators do not have.
//
// So the assertions are about two things: that a person can configure this by
// typing into a form, and that what they type is handled as a credential —
// sealed with the master key, never echoed back, and proved against the bucket
// before the destination is called working.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { looksSealed } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-dest-'));
const keyPath = join(dir, 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 11).toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const nasCalls: Array<{ operation: string; body?: unknown }> = [];

// Not credential-shaped on purpose: the pre-commit scanner rejects anything
// that looks real, and what matters here is only that distinct secret fields
// survive the round trip and never come back out.
const ACCESS_KEY = 'not-a-real-access-key-id';
const SECRET_KEY = 'not-a-real-secret-value-for-tests';

/** What the bucket answers. Each test turns this to the case it is about; no
 * suite reaches a real storage service. */
let bucketReply: { status: number; body: string } | 'throw' = { status: 200, body: '<ListBucketResult/>' };
const requests: Array<{ url: string; headers: Record<string, string> }> = [];
const destinationFetch: typeof fetch = async (url, init) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[k.toLowerCase()] = v;
  }
  requests.push({ url: String(url), headers });
  if (bucketReply === 'throw') throw new Error('ECONNREFUSED');
  return new Response(bucketReply.body, { status: bucketReply.status });
};

interface Res { status: number; body: any }
let adminJar = '';
let memberJar = '';

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const jar = opts.jar ?? adminJar;
  if (jar) headers.cookie = jar;
  const token = /josi_csrf=([^;]+)/.exec(jar)?.[1];
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const method = opts.method ?? 'GET';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: method !== 'GET' && opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

/** A signed-in session for each role, so authorization is tested rather than
 * assumed from the route table. */
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

beforeEach(async () => {
  db = await testDb();
  requests.length = 0;
  bucketReply = { status: 200, body: '<ListBucketResult/>' };
  nasCalls.length = 0;
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: { path: keyPath },
    destinationFetch,
    nasController: {
      async browse(body) { nasCalls.push({ operation: 'browse', body }); return ['daily', 'offsite']; },
      async configure(body) { nasCalls.push({ operation: 'configure', body }); return { mountedPath: '/mnt/josi-nas/offsite' }; },
      async remove() { nasCalls.push({ operation: 'remove' }); },
    },
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await ensureWorkspace(db);
  await createUser(db, {
    email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: 'admin-password-123',
  });
  await createUser(db, {
    email: 'alice@ce.test', username: 'alice', role: 'member', password: 'alice-password-123',
  });
  adminJar = await signIn('admin', 'admin-password-123');
  memberJar = await signIn('alice', 'alice-password-123');
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const S3 = {
  kind: 's3', bucket: 'josi-backups', region: 'us-east-1',
  accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY,
};

describe('the form asks for what each vendor actually calls things', () => {
  it('offers S3, R2 and B2 with their own field names', async () => {
    const res = await call('/api/ops/admin/backups/destination');
    expect(res.status).toBe(200);
    const kinds = (res.body.catalog as Array<{ kind: string }>).map((c) => c.kind);
    expect(kinds).toEqual(['nas', 's3', 'r2', 'b2']);

    const byKind = new Map(
      (res.body.catalog as Array<any>).map((c) => [c.kind, c]),
    );
    expect(byKind.get('nas').fields.map((f: any) => f.label)).toEqual(expect.arrayContaining([
      'NAS address', 'Share or export', 'Username', 'Password', 'Folder on the share',
    ]));
    // Backblaze shows keyID and applicationKey. Labelling those with the
    // protocol's names sends an operator hunting their console for fields that
    // are not there.
    const b2Labels = byKind.get('b2').fields.map((f: any) => f.label);
    expect(b2Labels).toContain('keyID');
    expect(b2Labels).toContain('applicationKey');

    // R2 has no region to ask for and does need an account id.
    const r2Keys = byKind.get('r2').fields.map((f: any) => f.key);
    expect(r2Keys).toContain('accountId');
    expect(r2Keys).not.toContain('region');

    // Bucket, region and endpoint are labelled in plain words everywhere.
    const s3Labels = byKind.get('s3').fields.map((f: any) => f.label);
    expect(s3Labels).toContain('Bucket name');
    expect(s3Labels).toContain('Region');
  });

  it('asks for no secret prefix and names no host file', async () => {
    const res = await call('/api/ops/admin/backups/destination');
    const serialised = JSON.stringify(res.body);
    // The whole point of the item: `primary` was a prefix naming host secret
    // files an operator had to create and mount themselves.
    expect(serialised).not.toMatch(/secret[ _-]?prefix/i);
    expect(serialised).not.toMatch(/\/run\/secrets/);
    // `objectPrefix` is legitimate — it names a folder inside the bucket. What
    // must not come back is a field naming a host secret file.
    for (const field of res.body.catalog.flatMap((c: any) => c.fields)) {
      expect(field.key).not.toBe('secretPrefix');
      expect(field.label).not.toMatch(/secret prefix/i);
    }
    // And it says where backups already go, so "no destination" is never
    // confused with "backups are not kept anywhere".
    expect(res.body.localPath).toBe('/data/backups');
  });
});

describe('the credential is managed, not mounted', () => {
  it('authenticates, browses, and mounts an SMB share through the restricted controller', async () => {
    const browsed = await call('/api/ops/admin/backups/destination/nas/browse', { method: 'POST', body: { shareProtocol: 'smb', shareHost: '10.0.0.8', shareName: 'backup', username: 'roman', password: 'test-only-password' } });
    expect(browsed.status).toBe(200);
    expect(browsed.body.folders).toEqual(['daily', 'offsite']);
    const saved = await call('/api/ops/admin/backups/destination', { method: 'PUT', body: { kind: 'nas', shareProtocol: 'smb', shareHost: '10.0.0.8', shareName: 'backup', folder: 'offsite', username: 'roman', password: 'test-only-password', encryptionEnabled: false } });
    expect(saved.status).toBe(200);
    const view = await call('/api/ops/admin/backups/destination');
    expect(view.body.destination).toMatchObject({ shareProtocol: 'smb', shareHost: '10.0.0.8', shareName: 'backup' });
    expect(JSON.stringify(view.body)).not.toContain('test-only-password');
    expect(nasCalls.map((c) => c.operation)).toEqual(['browse', 'configure']);
  });
  it('seals what was typed and never returns it', async () => {
    const saved = await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const [row] = await db.query<{ credentials_enc: string | null }>(
      `select credentials_enc from backup_destination where id = true`,
    );
    expect(looksSealed(row.credentials_enc!)).toBe(true);
    expect(row.credentials_enc).not.toContain(ACCESS_KEY);
    expect(row.credentials_enc).not.toContain(SECRET_KEY);

    // Nothing about the credential comes back out — not the secret, not the
    // key id, not a masked version of either.
    const view = await call('/api/ops/admin/backups/destination');
    const serialised = JSON.stringify(view.body);
    expect(serialised).not.toContain(ACCESS_KEY);
    expect(serialised).not.toContain(SECRET_KEY);
    expect(view.body.destination.credentialsSet).toBe(true);
  });

  it('keeps a stored credential on edit, but not across a change of vendor', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    const [before] = await db.query<{ credentials_enc: string }>(
      `select credentials_enc from backup_destination where id = true`,
    );

    // Same vendor, blank secrets: the stored envelope is carried forward.
    const edited = await call('/api/ops/admin/backups/destination', {
      method: 'PUT', body: { kind: 's3', bucket: 'renamed', region: 'us-east-1' },
    });
    expect(edited.status).toBe(200);
    const [after] = await db.query<{ credentials_enc: string; bucket: string }>(
      `select credentials_enc, bucket from backup_destination where id = true`,
    );
    expect(after.bucket).toBe('renamed');
    expect(after.credentials_enc).toBe(before.credentials_enc);

    // A different vendor with blank secrets is refused rather than silently
    // sending an AWS key to Cloudflare.
    const swapped = await call('/api/ops/admin/backups/destination', {
      method: 'PUT', body: { kind: 'r2', bucket: 'b', accountId: 'acct123' },
    });
    expect(swapped.status).toBe(400);
    expect(swapped.body.error).toMatch(/access key id|secret access key/i);
  });

  it('is administrator-only', async () => {
    expect((await call('/api/ops/admin/backups/destination', { jar: memberJar })).status).toBe(403);
    expect((await call('/api/ops/admin/backups/destination', {
      method: 'PUT', jar: memberJar, body: S3,
    })).status).toBe(403);
    expect((await call('/api/ops/admin/backups/destination/test', {
      method: 'POST', jar: memberJar, body: {},
    })).status).toBe(403);
  });

  it('takes the credential with the destination when it is removed', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    const gone = await call('/api/ops/admin/backups/destination', { method: 'DELETE' });
    expect(gone.status).toBe(204);
    // Keeping a live cloud credential for a feature that was switched off is
    // not caution, it is a liability.
    expect(await db.query(`select * from backup_destination`)).toHaveLength(0);
  });
});

describe('the connection test asks the bucket a real question', () => {
  it('signs a listing against the derived endpoint', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    const res = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(requests).toHaveLength(1);
    // Listing one object, not merely probing the host: it proves the endpoint
    // resolves, the signature verifies, and this credential may use this
    // bucket.
    expect(requests[0].url).toBe(
      'https://s3.us-east-1.amazonaws.com/josi-backups?list-type=2&max-keys=1',
    );
    expect(requests[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(requests[0].headers.authorization).toContain('/us-east-1/s3/aws4_request');
    // The secret itself is never a header value.
    expect(JSON.stringify(requests[0].headers)).not.toContain(SECRET_KEY);
  });

  it('derives R2 and B2 endpoints rather than asking anyone to type one', async () => {
    await call('/api/ops/admin/backups/destination', {
      method: 'PUT',
      body: {
        kind: 'r2', bucket: 'josi', accountId: 'abc123',
        accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY,
      },
    });
    await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(requests[0].url).toContain('https://abc123.r2.cloudflarestorage.com/josi');
    // R2 has no regions and rejects anything but `auto` in the signature.
    expect(requests[0].headers.authorization).toContain('/auto/s3/aws4_request');

    requests.length = 0;
    await call('/api/ops/admin/backups/destination', {
      method: 'PUT',
      body: {
        kind: 'b2', bucket: 'josi', region: 'us-west-004',
        accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY,
      },
    });
    await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(requests[0].url).toContain('https://s3.us-west-004.backblazeb2.com/josi');
  });

  it('separates a wrong secret from a key that is not allowed here', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });

    bucketReply = { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' };
    const denied = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(denied.body.ok).toBe(false);
    expect(denied.body.category).toBe('authorization');
    expect(denied.body.detail).toMatch(/not allowed to use this bucket/i);

    bucketReply = { status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' };
    const wrong = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(wrong.body.category).toBe('authentication');
    expect(wrong.body.detail).toMatch(/pasted whole/i);
  });

  it('names a missing bucket as a missing bucket', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    bucketReply = { status: 404, body: '<Error><Code>NoSuchBucket</Code></Error>' };
    const res = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(res.body.category).toBe('no_such_bucket');
    expect(res.body.detail).toMatch(/does not exist/i);
  });

  it('records the outcome either way, and forgets it when the config changes', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    // Never tested is its own state, distinct from working and from broken.
    let view = await call('/api/ops/admin/backups/destination');
    expect(view.body.destination.lastCheckOk).toBeNull();

    await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    view = await call('/api/ops/admin/backups/destination');
    expect(view.body.destination.lastCheckOk).toBe(true);

    bucketReply = { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' };
    await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    view = await call('/api/ops/admin/backups/destination');
    // A destination whose last test failed keeps saying so.
    expect(view.body.destination.lastCheckOk).toBe(false);
    expect(view.body.destination.lastCheckError).toMatch(/not allowed/i);

    // Saving a change clears it: a credential that has not been tried against
    // the bucket it now points at has established nothing.
    await call('/api/ops/admin/backups/destination', {
      method: 'PUT', body: { ...S3, bucket: 'somewhere-else' },
    });
    view = await call('/api/ops/admin/backups/destination');
    expect(view.body.destination.lastCheckOk).toBeNull();
    expect(view.body.destination.lastCheckError).toBeNull();
  });

  it('says so plainly when nothing answers', async () => {
    await call('/api/ops/admin/backups/destination', { method: 'PUT', body: S3 });
    bucketReply = 'throw';
    const res = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(res.body.category).toBe('network');
    expect(res.body.detail).toMatch(/nothing answered/i);
  });

  it('refuses to test a destination that does not exist', async () => {
    const res = await call('/api/ops/admin/backups/destination/test', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no backup destination/i);
  });
});

describe('the destination cannot be pointed somewhere unsafe', () => {
  it('refuses a plaintext endpoint', async () => {
    const res = await call('/api/ops/admin/backups/destination', {
      method: 'PUT', body: { ...S3, endpoint: 'http://someone-elses-box.example' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https/i);
  });

  it('only lets the S3-compatible kind carry a typed endpoint', async () => {
    // A mistyped endpoint for a backup destination is somebody else receiving
    // everything this installation holds, so it is derived wherever it can be.
    const res = await call('/api/ops/admin/backups/destination', {
      method: 'PUT',
      body: {
        kind: 'r2', bucket: 'josi', accountId: 'abc123',
        accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY,
        endpoint: 'https://elsewhere.example',
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/custom endpoint/i);
  });

  it('refuses R2 without the account its endpoint is built from', async () => {
    const res = await call('/api/ops/admin/backups/destination', {
      method: 'PUT',
      body: { kind: 'r2', bucket: 'josi', accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/account ID/i);
  });

  it('refuses a service it does not know', async () => {
    const res = await call('/api/ops/admin/backups/destination', {
      method: 'PUT', body: { ...S3, kind: 'ftp' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/choose where backups should be stored/i);
  });
});
