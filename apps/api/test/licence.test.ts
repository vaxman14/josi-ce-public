// Activating a licence, and what an unsupported build says instead.
//
// The screen this replaces stated that the installation was unlicensed and that
// the build had no publisher verification key, and then stopped. An operator
// who had bought a licence had nowhere to put it. So the assertions here are
// about the two halves of that: a build that CAN verify offers a way in, and a
// build that CANNOT gives steps rather than an explanation.
//
// The suite mints its own signing key and stamps it through the route context,
// which is what a supported build does at image-build time. Nothing here is a
// publisher secret: the private key exists for the length of this file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { entitlementStatus, getInstallId, verifyLicence } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;
let db: TestDb;
const jars: Record<string, string> = {};

// One keypair for the whole file: the publisher's, as far as these tests are
// concerned. A second one stands in for somebody else's.
const publisher = generateKeyPairSync('ed25519');
const impostor = generateKeyPairSync('ed25519');

/** The raw 32-byte public key, base64 — exactly what gets stamped into a build. */
function rawPublic(key: typeof publisher.publicKey): string {
  const der = key.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32).toString('base64');
}

const PUBLISHER_KEY = rawPublic(publisher.publicKey);

/** Issue a licence the way the publisher would. */
function issue(
  payload: Record<string, unknown>,
  key: typeof publisher.privateKey = publisher.privateKey,
): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, body, key);
  return `${body.toString('base64url')}.${signature.toString('base64url')}`;
}

function licenceFor(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: 'Roman at SOCAL RECEPTIONIST LLC',
    installationId: null,
    features: ['parental_controls'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...over,
  };
}

interface Res { status: number; body: any }

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

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const jar = opts.jar ?? jars.admin;
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

const PW = 'a-long-enough-password-123';

/** A supported build by default; `start(null)` is an unsupported one. */
async function start(publicKey: string | null = PUBLISHER_KEY) {
  db = await testDb();
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost', licencePublicKey: publicKey,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await ensureWorkspace(db);
  await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW });
  await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW });
  jars.admin = await signIn('admin', PW);
  jars.alice = await signIn('alice', PW);
}

beforeEach(async () => { await start(); });
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a supported build offers a way in', () => {
  it('starts unlicensed, and says so with somewhere to go next', async () => {
    const res = await call('/api/admin/licence');
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('none');
    // The whole point: not a dead end. Entering a key here can work.
    expect(res.body.canActivate).toBe(true);
    expect(res.body.supportedBuild).toBeNull();
    // And the id a bound licence has to be issued against.
    expect(res.body.installationId).toBeTruthy();
  });

  it('activates a genuine licence and shows what it covers', async () => {
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor()) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe('active');
    expect(res.body.licence.subject).toContain('SOCAL RECEPTIONIST');
    expect(res.body.licence.features).toEqual(['parental_controls']);
    expect(res.body.licence.expiresAt).toBeNull();
    expect(await entitlementStatus(db, 'parental_controls')).toMatchObject({
      state: 'active', entitled: true, issuedTo: 'Roman at SOCAL RECEPTIONIST LLC',
    });
  });

  it('never echoes the licence key back', async () => {
    const token = issue(licenceFor());
    await call('/api/admin/licence', { method: 'PUT', body: { token } });
    const res = await call('/api/admin/licence');
    // It is what proves entitlement; echoing it puts it in a screenshot.
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('refuses one signed by anybody else, and stores nothing', async () => {
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor(), impostor.privateKey) },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not issued by SOCAL RECEPTIONIST/i);
    // Keeping a rejected licence "so they can retry" would leave the
    // installation showing one it never accepted.
    expect(await db.query(`select * from licence`)).toHaveLength(0);
  });

  it('refuses one that has been altered after signing', async () => {
    const original = issue(licenceFor({ features: [] }));
    const [payload, signature] = original.split('.');
    const tampered = Buffer.from(payload, 'base64url').toString('utf8')
      .replace('"features":[]', '"features":["parental_controls"]');
    const forged = `${Buffer.from(tampered, 'utf8').toString('base64url')}.${signature}`;

    const res = await call('/api/admin/licence', { method: 'PUT', body: { token: forged } });
    expect(res.status).toBe(400);
    expect(await db.query(`select * from licence`)).toHaveLength(0);
  });

  it('refuses gibberish without pretending it was a signature problem', async () => {
    const res = await call('/api/admin/licence', { method: 'PUT', body: { token: 'nonsense' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a licence key Josi recognises/i);
  });

  it('refuses an empty key with something actionable', async () => {
    const res = await call('/api/admin/licence', { method: 'PUT', body: { token: '   ' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/enter the licence key/i);
  });
});

describe('expiry and binding', () => {
  it('refuses a licence that has already expired', async () => {
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ expiresAt: '2020-01-01T00:00:00.000Z' })) },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired on 2020-01-01/);
  });

  it('reports a stored licence as expired once it passes, without anything running', async () => {
    // Activated while valid, read back after it lapses. The token is
    // re-verified on every read, so this needs nothing scheduled.
    const token = issue(licenceFor({ expiresAt: '2999-01-01T00:00:00.000Z' }));
    await call('/api/admin/licence', { method: 'PUT', body: { token } });

    const past = issue(licenceFor({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    await db.query(`update licence set token = $1 where id = true`, [past]);

    const res = await call('/api/admin/licence');
    expect(res.body.state).toBe('expired');
    // Still shown with its details: an expired licence is renewable and the
    // operator has to see which one to renew.
    expect(res.body.licence.subject).toContain('SOCAL RECEPTIONIST');
  });

  it('refuses a licence issued to a different installation', async () => {
    const res = await call('/api/admin/licence', {
      method: 'PUT',
      body: { token: issue(licenceFor({ installationId: 'a-different-installation' })) },
    });
    expect(res.status).toBe(400);
    // Not "expired" and not "invalid": it is a real licence, just not this
    // installation's, and the operator's next step is different for each.
    expect(res.body.error).toMatch(/different installation/i);
  });

  it('accepts one bound to this installation', async () => {
    const installationId = await getInstallId(db);
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ installationId })) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe('active');
  });
});

describe('replacing and deactivating', () => {
  it('replaces in place rather than accumulating licences', async () => {
    await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ subject: 'First' })) },
    });
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ subject: 'Second' })) },
    });
    expect(res.body.licence.subject).toBe('Second');
    expect(await db.query(`select * from licence`)).toHaveLength(1);
  });

  it('makes Parental Controls inert when a replacement licence no longer covers it', async () => {
    await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor()) },
    });
    const replacement = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ features: [] })) },
    });
    expect(replacement.status).toBe(200);
    expect(await entitlementStatus(db, 'parental_controls')).toMatchObject({
      state: 'revoked', entitled: false,
    });
  });

  it('leaves a valid licence alone when a replacement is refused', async () => {
    await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor({ subject: 'Good one' })) },
    });
    const bad = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor(), impostor.privateKey) },
    });
    expect(bad.status).toBe(400);
    // A failed replacement must not unlicense a working installation.
    const after = await call('/api/admin/licence');
    expect(after.body.state).toBe('active');
    expect(after.body.licence.subject).toBe('Good one');
  });

  it('deactivating returns it to the never-licensed state', async () => {
    await call('/api/admin/licence', { method: 'PUT', body: { token: issue(licenceFor()) } });
    expect((await call('/api/admin/licence', { method: 'DELETE' })).status).toBe(204);
    const res = await call('/api/admin/licence');
    expect(res.body.state).toBe('none');
    expect(res.body.licence).toBeNull();
    expect(await db.query(`select * from licence`)).toHaveLength(0);
    expect(await entitlementStatus(db, 'parental_controls')).toMatchObject({
      state: 'revoked', entitled: false,
    });
  });

  it('is administrator-only throughout', async () => {
    expect((await call('/api/admin/licence', { jar: jars.alice })).status).toBe(403);
    expect((await call('/api/admin/licence', {
      method: 'PUT', jar: jars.alice, body: { token: issue(licenceFor()) },
    })).status).toBe(403);
    expect((await call('/api/admin/licence', { method: 'DELETE', jar: jars.alice })).status).toBe(403);
  });
});

describe('a build that cannot verify says how to get one that can', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(null);
  });

  it('gives steps rather than a dead-end explanation', async () => {
    const res = await call('/api/admin/licence');
    expect(res.body.state).toBe('unverifiable_build');
    expect(res.body.canActivate).toBe(false);

    // The precise route, not "this build is unsupported" and nothing else.
    const route = res.body.supportedBuild;
    expect(route.publisher).toBe('SOCAL RECEPTIONIST LLC');
    expect(route.image).toBe('ghcr.io/vaxman14/josi-ce:latest');
    expect(route.docs).toBe('https://github.com/vaxman14/josi-ce-public/blob/main/docs/INSTALLATION.md');
    expect(route.steps.length).toBeGreaterThanOrEqual(3);
    expect(route.steps.join(' ')).toMatch(/docker compose/i);
    expect(route.docs).toMatch(/^https:\/\//);
  });

  it('refuses to accept a licence it could not have checked', async () => {
    const res = await call('/api/admin/licence', {
      method: 'PUT', body: { token: issue(licenceFor()) },
    });
    // 409 rather than 400: the key is not the problem, the artefact is.
    expect(res.status).toBe(409);
    expect(await db.query(`select * from licence`)).toHaveLength(0);
  });
});

describe('the verifier itself', () => {
  it('never accepts a licence when the build has no key', () => {
    // Belt and braces around the route: even a perfectly signed licence is
    // unverifiable without a key to check it against.
    const status = verifyLicence(issue(licenceFor()), { publicKey: null });
    expect(status.state).toBe('unverifiable_build');
  });

  it('cannot be told which algorithm to use', () => {
    // Deliberately not a JWT. There is no header naming an algorithm, so the
    // whole "alg: none" class of mistake has nowhere to live.
    const body = Buffer.from(JSON.stringify(licenceFor()), 'utf8');
    const unsigned = `${body.toString('base64url')}.${Buffer.alloc(64).toString('base64url')}`;
    const status = verifyLicence(unsigned, { publicKey: PUBLISHER_KEY });
    expect(status.state).toBe('invalid');
  });
});
