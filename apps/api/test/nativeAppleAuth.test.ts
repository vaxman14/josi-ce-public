import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, generateSecret } from 'otplib';
import { MasterKey, seal } from '@josi-ce/core';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const clientId = 'com.socalreceptionist.josice';
const kid = 'TESTAPPLE1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const appleFetch = (async (url: RequestInfo | URL) => {
  expect(String(url)).toBe('https://appleid.apple.com/auth/keys');
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

let db: TestDb;
let server: Server;
let base: string;
let userId: string;
let mfaUserId: string;
const masterBytes = Buffer.alloc(32, 71);
const masterPath = join(mkdtempSync(join(tmpdir(), 'josi-apple-auth-')), 'master.key');
writeFileSync(masterPath, masterBytes.toString('base64'));
const mfaSecret = generateSecret();

function token(nonce: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://appleid.apple.com', aud: clientId, sub: 'apple-stable-subject-1',
    exp: now + 300, iat: now, nonce: createHash('sha256').update(nonce).digest('hex'),
    email: 'member@ce.test', email_verified: true, is_private_email: false,
    ...overrides,
  })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function exchange(body: Record<string, unknown>, native = true) {
  return fetch(`${base}/api/auth/apple/native/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(native ? { 'x-josi-client': 'native' } : {}) },
    body: JSON.stringify(body),
  });
}

async function complete(body: Record<string, unknown>) {
  return fetch(`${base}/api/auth/apple/native/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-josi-client': 'native' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  userId = (await createUser(db, {
    email: 'member@ce.test', username: 'member', role: 'member', password: 'member-password-123',
  })).id;
  await createUser(db, {
    email: 'other@ce.test', username: 'other', role: 'member', password: 'other-password-123',
  });
  mfaUserId = (await createUser(db, {
    email: 'mfa@ce.test', username: 'mfa', role: 'member', password: 'mfa-password-123',
  })).id;
  await db.query(`update users set totp_secret_enc=$2,mfa_enabled_at=now() where id=$1`, [
    mfaUserId, seal(new MasterKey(masterBytes), { secret: mfaSecret }),
  ]);
  const app = createApp(db, {
    cookieSecure: false, appUrl: 'https://native.ce.test', masterKeyCheck: { path: masterPath },
    appleNativeClientId: clientId, appleFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('native Sign in with Apple', () => {
  it('advertises only a boolean capability and no Apple credential material', async () => {
    const response = await fetch(`${base}/api/auth/native/config`);
    const body = await response.json() as any;
    expect(body.appleSignIn).toBe(true);
    expect(JSON.stringify(body)).not.toContain(kid);
  });

  it('verifies the Apple token but requires existing credentials before linking', async () => {
    const nonce = randomBytes(32).toString('base64url');
    const response = await exchange({ identityToken: token(nonce), nonce, appleUser: 'apple-stable-subject-1' });
    expect(response.status).toBe(202);
    const pending = await response.json() as any;
    expect(pending.linkRequired).toBe(true);
    const refused = await complete({ challenge: pending.challenge, identifier: 'member', password: 'wrong-password' });
    expect(refused.status).toBe(401);
    const linked = await complete({ challenge: pending.challenge, identifier: 'member', password: 'member-password-123' });
    expect(linked.status).toBe(200);
    const body = await linked.json() as any;
    expect(body.user.id).toBe(userId);
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [identity] = await db.query<any>(`select * from auth_identities where provider='apple'`);
    expect(identity.user_id).toBe(userId);
    expect(identity.provider_subject).toBe('apple-stable-subject-1');
    expect(identity.verified_email).toBe('member@ce.test');
    expect(JSON.stringify(identity)).not.toContain(response.url);
  });

  it('restores the linked account when Apple omits email on later authorizations', async () => {
    const nonce = randomBytes(32).toString('base64url');
    const response = await exchange({
      identityToken: token(nonce, { email: undefined, email_verified: undefined }), nonce,
      appleUser: 'apple-stable-subject-1',
    });
    expect(response.status).toBe(200);
    expect((await response.json() as any).user.id).toBe(userId);
  });

  it('rejects nonce, audience, client-subject and signature mismatches', async () => {
    for (const body of [
      (() => { const nonce = randomBytes(32).toString('base64url'); return { identityToken: token(nonce), nonce: randomBytes(32).toString('base64url') }; })(),
      (() => { const nonce = randomBytes(32).toString('base64url'); return { identityToken: token(nonce, { aud: 'com.socalreceptionist.josi' }), nonce }; })(),
      (() => { const nonce = randomBytes(32).toString('base64url'); return { identityToken: token(nonce), nonce, appleUser: 'another-subject' }; })(),
      (() => { const nonce = randomBytes(32).toString('base64url'); const value = token(nonce); return { identityToken: `${value.slice(0, -2)}aa`, nonce }; })(),
    ]) {
      const response = await exchange(body);
      expect(response.status).toBe(401);
    }
  });

  it('supports Hide My Email through credential-gated linking and refuses browser-shaped callers', async () => {
    const nonce = randomBytes(32).toString('base64url');
    const relay = await exchange({
      identityToken: token(nonce, { sub: 'relay-subject', email: 'private@privaterelay.appleid.com', email_verified: true, is_private_email: true }), nonce,
    });
    expect(relay.status).toBe(202);
    const pending = await relay.json() as any;
    const linked = await complete({ challenge: pending.challenge, identifier: 'other', password: 'other-password-123' });
    expect(linked.status).toBe(200);
    const [identity] = await db.query<any>(`select * from auth_identities where provider_subject='relay-subject'`);
    expect(identity.private_relay).toBe(true);
    const browser = await exchange({ identityToken: token(nonce), nonce }, false);
    expect(browser.status).toBe(403);
  });

  it('requires configured MFA both while linking and on later Apple logins', async () => {
    const nonce = randomBytes(32).toString('base64url');
    const first = await exchange({ identityToken: token(nonce, { sub: 'mfa-subject', email: 'mfa@ce.test' }), nonce });
    const link = await first.json() as any;
    const needsMfa = await complete({ challenge: link.challenge, identifier: 'mfa', password: 'mfa-password-123' });
    expect(needsMfa.status).toBe(202);
    expect((await needsMfa.json() as any).mfaRequired).toBe(true);
    const linked = await complete({
      challenge: link.challenge, identifier: 'mfa', password: 'mfa-password-123', mfaCode: await generate({ secret: mfaSecret }),
    });
    expect(linked.status).toBe(200);
    expect((await linked.json() as any).user.id).toBe(mfaUserId);

    const nextNonce = randomBytes(32).toString('base64url');
    const next = await exchange({ identityToken: token(nextNonce, { sub: 'mfa-subject', email: undefined }), nonce: nextNonce });
    expect(next.status).toBe(202);
    const login = await next.json() as any;
    expect(login.mfaRequired).toBe(true);
    const completed = await complete({ challenge: login.challenge, mfaCode: await generate({ secret: mfaSecret }) });
    expect(completed.status).toBe(200);

    const lockedNonce = randomBytes(32).toString('base64url');
    const lockedStart = await exchange({ identityToken: token(lockedNonce, { sub: 'mfa-subject', email: undefined }), nonce: lockedNonce });
    const locked = await lockedStart.json() as any;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await complete({ challenge: locked.challenge, mfaCode: '000000' })).status).toBe(401);
    }
    const afterLockout = await complete({ challenge: locked.challenge, mfaCode: await generate({ secret: mfaSecret }) });
    expect(afterLockout.status).toBe(401);
  });
});
