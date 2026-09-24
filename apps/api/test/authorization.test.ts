// Hostile authorization tests.
//
// These are the acceptance gate for Phase 1. They are written from the attacker's
// side: a signed-in colleague who knows a resource id, and a super admin who is
// curious about somebody's mailbox. Both are legitimate users of the
// installation, which is exactly why hidden navigation would not stop them.
//
// Everything is asserted over the wire against the real router stack and a real
// migrated database — not against the helper functions, which is where these
// claims would be easy to fake.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { testDb } from '../../../packages/core/test/helpers.js';
import type { Db } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;
let db: Db;

const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

interface Res { status: number; body: any; setCookie: string[] }

/** A browser-shaped client: carries cookies, and echoes the CSRF cookie into
 * the header the way the real SPA does. */
async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string; csrf?: string | null; origin?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.jar) headers.cookie = opts.jar;
  // csrf === null means "deliberately omit", for the CSRF tests.
  if (opts.csrf !== null) {
    const token = opts.csrf ?? tokenFromJar(opts.jar);
    if (token) headers['x-josi-csrf'] = token;
  }
  if (opts.origin) headers.origin = opts.origin;

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const body = await res.json().catch(() => null);
  return { status: res.status, body, setCookie };
}

function tokenFromJar(jar?: string): string | undefined {
  if (!jar) return undefined;
  const m = /josi_csrf=([^;]+)/.exec(jar);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const idx = first.indexOf('=');
    if (idx > 0) jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  // Fetch a CSRF token first, exactly as the SPA must.
  const pre = await call('/api/auth/csrf');
  let jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login for ${identifier}: ${JSON.stringify(res.body)}`).toBe(200);
  jar = mergeJar(jar, res.setCookie);
  return jar;
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);

  ids.admin = (await createUser(db, {
    email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: 'admin-password-123',
  })).id;
  ids.alice = (await createUser(db, {
    email: 'alice@ce.test', username: 'alice', role: 'member', password: 'alice-password-123',
  })).id;
  ids.bob = (await createUser(db, {
    email: 'bob@ce.test', username: 'bob', role: 'member', password: 'bob-password-123',
  })).id;

  // A private resource each. In CE these are per-user, which is the whole point.
  ids.aliceConn = (await db.query<{ id: string }>(
    `insert into connections (owner_user_id, provider, account_email, granted_scopes, secrets_enc)
     values ($1, 'google', 'alice.private@gmail.test', 'gmail.readonly', 'sealed-alice-token')
     returning id`,
    [ids.alice],
  ))[0].id;
  ids.bobConn = (await db.query<{ id: string }>(
    `insert into connections (owner_user_id, provider, account_email, granted_scopes, secrets_enc)
     values ($1, 'microsoft', 'bob.private@outlook.test', 'Mail.ReadWrite', 'sealed-bob-token')
     returning id`,
    [ids.bob],
  ))[0].id;

  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost:3000' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', 'admin-password-123');
  cookies.alice = await signIn('alice', 'alice-password-123');
  cookies.bob = await signIn('bob', 'bob-password-123');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('anonymous callers', () => {
  it('are refused every protected surface', async () => {
    for (const path of [
      '/api/auth/me',
      '/api/auth/mfa',
      '/api/connections',
      `/api/connections/${ids.aliceConn}`,
      '/api/admin/users',
      '/api/admin/workspace',
      '/api/admin/connections',
      '/api/admin/events',
      '/api/admin/launch-checklist',
    ]) {
      expect((await call(path)).status, path).toBe(401);
    }
  });

  it('cannot enumerate accounts through the login error', async () => {
    const pre = await call('/api/auth/csrf');
    const jar = mergeJar(undefined, pre.setCookie);
    const unknown = await call('/api/auth/login', { method: 'POST', jar, body: { identifier: 'ghost', password: 'whatever-12345' } });
    const wrong = await call('/api/auth/login', { method: 'POST', jar, body: { identifier: 'alice', password: 'whatever-12345' } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('login hardening routes', () => {
  it('registers MFA as a normal authenticated route, independent of Google sign-in', async () => {
    const res = await call('/api/auth/mfa', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, recoveryCodesRemaining: 0 });
  });

  it('keeps password-reset requests enumeration-safe', async () => {
    const pre = await call('/api/auth/csrf');
    const jar = mergeJar(undefined, pre.setCookie);
    const known = await call('/api/auth/forgot-password', {
      method: 'POST', jar, body: { identifier: 'alice' },
    });
    const unknown = await call('/api/auth/forgot-password', {
      method: 'POST', jar, body: { identifier: 'nobody-here' },
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });
});

describe('role separation', () => {
  it('a member cannot reach any super-admin endpoint', async () => {
    for (const path of [
      '/api/admin/users',
      '/api/admin/workspace',
      '/api/admin/sessions',
      '/api/admin/events',
      '/api/admin/connections',
      // The launch checklist reports the state of the whole installation —
      // how many accounts exist, whether backups have run, what setup skipped.
      // Metadata, but an administrator's metadata.
      '/api/admin/launch-checklist',
    ]) {
      expect((await call(path, { jar: cookies.alice })).status, path).toBe(403);
    }
  });

  it('a member cannot dismiss the administrator’s checklist, or claim its confirmations', async () => {
    for (const path of [
      '/api/admin/launch-checklist/seen',
      '/api/admin/launch-checklist/master-key-backed-up',
      '/api/admin/launch-checklist/dismiss/connectors',
      '/api/admin/launch-checklist/restore/connectors',
    ]) {
      const res = await call(path, { method: 'POST', jar: cookies.alice, body: {} });
      expect(res.status, path).toBe(403);
    }
  });

  it('reuses the setup Vault-recovery acknowledgement in the launch checklist', async () => {
    await db.query(`update vault_state set recovery_confirmed_at = now() where id = true`);
    const res = await call('/api/admin/launch-checklist', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.items.find((item: { key: string }) => item.key === 'master_key_backup')).toMatchObject({
      state: 'done',
      label: 'Recovery keys are stored safely',
    });
  });

  it('a member cannot create a user or change the workspace', async () => {
    const created = await call('/api/admin/users', {
      method: 'POST', jar: cookies.alice,
      body: { email: 'sneaky@ce.test', username: 'sneaky' },
    });
    expect(created.status).toBe(403);
    const patched = await call('/api/admin/workspace', {
      method: 'PATCH', jar: cookies.alice, body: { name: 'Hijacked' },
    });
    expect(patched.status).toBe(403);
    expect((await db.query(`select 1 from users where username = 'sneaky'`)).length).toBe(0);
  });

  it('the super admin can reach the policy surface', async () => {
    expect((await call('/api/admin/users', { jar: cookies.admin })).status).toBe(200);
    expect((await call('/api/admin/workspace', { jar: cookies.admin })).status).toBe(200);
  });
});

describe('the new axis: one member cannot reach another member', () => {
  it("returns 404 — not 403 — for a colleague's connection", async () => {
    const res = await call(`/api/connections/${ids.aliceConn}`, { jar: cookies.bob });
    // 403 would confirm that a resource with this id exists and belongs to
    // someone. 404 says nothing at all, which is the point of private.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('alice');
  });

  it("cannot delete a colleague's connection", async () => {
    const res = await call(`/api/connections/${ids.aliceConn}`, { method: 'DELETE', jar: cookies.bob });
    expect(res.status).toBe(404);
    const still = await db.query(`select 1 from connections where id = $1`, [ids.aliceConn]);
    expect(still).toHaveLength(1);
  });

  it('lists only its own connections', async () => {
    const alice = await call('/api/connections', { jar: cookies.alice });
    expect(alice.body.connections).toHaveLength(1);
    expect(alice.body.connections[0].id).toBe(ids.aliceConn);
    expect(JSON.stringify(alice.body)).not.toContain('bob.private');

    const bob = await call('/api/connections', { jar: cookies.bob });
    expect(bob.body.connections).toHaveLength(1);
    expect(bob.body.connections[0].id).toBe(ids.bobConn);
    expect(JSON.stringify(bob.body)).not.toContain('alice.private');
  });

  it('never returns the sealed credential, even to the owner', async () => {
    const res = await call(`/api/connections/${ids.aliceConn}`, { jar: cookies.alice });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('sealed-alice-token');
    expect(text).not.toContain('secrets_enc');
  });

  it('treats a malformed id as not-found rather than querying with it', async () => {
    for (const bad of ['not-a-uuid', '1 OR 1=1', '../../etc/passwd']) {
      const res = await call(`/api/connections/${encodeURIComponent(bad)}`, { jar: cookies.bob });
      expect(res.status, bad).toBe(404);
    }
  });
});

describe('the super admin administers plumbing, not content', () => {
  it("gets 404 on a member's connection through the member route", async () => {
    // requireOwnership does not branch on role, so an admin is simply a
    // non-owner here. Admin power lives on the admin routes, not by widening
    // this one.
    const res = await call(`/api/connections/${ids.aliceConn}`, { jar: cookies.admin });
    expect(res.status).toBe(404);
  });

  it('sees connection health metadata and nothing about the account', async () => {
    const res = await call('/api/admin/connections', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.connections).toHaveLength(2);

    const text = JSON.stringify(res.body);
    // Whose it is and whether it works: administration.
    expect(text).toContain(ids.alice);
    expect(text).toContain('google');
    // Which mailbox, what it may do, and the token: content and credentials.
    for (const forbidden of [
      'alice.private@gmail.test', 'bob.private@outlook.test',
      'gmail.readonly', 'Mail.ReadWrite',
      'sealed-alice-token', 'sealed-bob-token',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('may revoke a connection without ever reading it', async () => {
    const res = await call(`/api/admin/connections/${ids.bobConn}/revoke`, { method: 'POST', jar: cookies.admin, body: {} });
    expect(res.status).toBe(200);
    const rows = await db.query<{ status: string; secrets_enc: string | null }>(
      `select status, secrets_enc from connections where id = $1`, [ids.bobConn],
    );
    expect(rows[0].status).toBe('revoked');
    // Revocation destroys the grant rather than handing it over.
    expect(rows[0].secrets_enc).toBeNull();
    // and the response body never carried the account either
    expect(JSON.stringify(res.body)).not.toContain('bob.private');
  });

  it('cannot disable its own account and lock the installation', async () => {
    const res = await call(`/api/admin/users/${ids.admin}`, {
      method: 'PATCH', jar: cookies.admin, body: { status: 'disabled' },
    });
    expect(res.status).toBe(409);
  });
});

describe('CSRF', () => {
  it('refuses a state-changing request with no token', async () => {
    const res = await call('/api/admin/workspace', {
      method: 'PATCH', jar: cookies.admin, csrf: null, body: { name: 'No token' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });

  it('refuses a mismatched token', async () => {
    const res = await call('/api/admin/workspace', {
      method: 'PATCH', jar: cookies.admin, csrf: 'not-the-right-token', body: { name: 'Wrong token' },
    });
    expect(res.status).toBe(403);
    const ws = await db.query<{ name: string }>(`select name from workspace where id = true`);
    expect(ws[0].name).not.toBe('Wrong token');
  });

  it('protects login itself, so a session cannot be forced onto a browser', async () => {
    const res = await call('/api/auth/login', {
      method: 'POST', csrf: null, body: { identifier: 'alice', password: 'alice-password-123' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a GET without a token', async () => {
    expect((await call('/api/auth/me', { jar: cookies.alice, csrf: null })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('gives native clients a bearer session without weakening browser CSRF', async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native' },
      body: JSON.stringify({ identifier: 'alice', password: 'alice-password-123' }),
    });
    expect(login.status).toBe(200);
    const payload = await login.json() as { sessionToken: string; user: { username: string } };
    expect(payload.user.username).toBe('alice');
    expect(payload.sessionToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const [session] = await db.query<{ lifetime_seconds: number }>(
      `select extract(epoch from (expires_at - created_at))::int as lifetime_seconds
         from sessions where token_hash = $1`,
      [createHash('sha256').update(payload.sessionToken).digest('hex')],
    );
    expect(session.lifetime_seconds).toBe(60 * 60 * 24 * 14);

    const me = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${payload.sessionToken}`, 'x-josi-client': 'native' },
    });
    expect(me.status).toBe(200);
    expect((await me.json()).user.username).toBe('alice');

    const browserShaped = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-josi-client': 'native', origin: 'https://hostile.test' },
      body: JSON.stringify({ identifier: 'alice', password: 'alice-password-123' }),
    });
    expect(browserShaped.status).toBe(403);
  });

  it('logout revokes server-side, not just in the browser', async () => {
    const jar = await signIn('bob', 'bob-password-123');
    expect((await call('/api/auth/me', { jar })).status).toBe(200);
    await call('/api/auth/logout', { method: 'POST', jar, body: {} });
    expect((await call('/api/auth/me', { jar })).status).toBe(401);
  });

  it('a disabled user is refused immediately, with the same cookie', async () => {
    const jar = await signIn('bob', 'bob-password-123');
    expect((await call('/api/auth/me', { jar })).status).toBe(200);
    await call(`/api/admin/users/${ids.bob}`, {
      method: 'PATCH', jar: cookies.admin, body: { status: 'disabled' },
    });
    expect((await call('/api/auth/me', { jar })).status).toBe(401);
    // put bob back for any later test
    await call(`/api/admin/users/${ids.bob}`, {
      method: 'PATCH', jar: cookies.admin, body: { status: 'active' },
    });
  });
});

describe('the audit log', () => {
  it('records who did what without recording what it said', async () => {
    const res = await call('/api/admin/events?limit=200', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    const kinds = res.body.events.map((e: any) => e.kind);
    expect(kinds).toContain('auth.login');
    expect(kinds).toContain('connection.revoked_by_admin');

    const text = JSON.stringify(res.body);
    for (const forbidden of ['alice.private@gmail.test', 'sealed-alice-token', 'alice-password-123']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('is append-only at the database level', async () => {
    await expect(db.query(`update events set kind = 'tampered' where id = 1`)).rejects.toThrow();
    await expect(db.query(`delete from events where id = 1`)).rejects.toThrow();
  });
});
