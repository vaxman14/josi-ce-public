// Custom API connections over the wire.
//
// The claims this file attacks, one describe block each:
//
//   1. Nothing is preset. A fresh installation has no connection, and no
//      environment variable or seeded row can change that.
//   2. Authentication and authorization. Signed out is 401; a member reaching an
//      admin route is 403; the member routes never configure anything.
//   3. Least privilege, twice. A connection cannot be enabled until the API has
//      answered, and every action under it is separately off.
//   4. Encrypted storage and masked readback. What lands in PostgreSQL is
//      ciphertext; no response carries the credential, its ciphertext, a prefix
//      or a length.
//   5. The allowlist. An OpenAPI import saves nothing until actions are chosen,
//      ignores the document's own servers, and saves them switched off.
//   6. Approval. A write becomes a pending request only its owner can see or
//      decide, approving sends it exactly once, and an expired one is refused.
//   7. SSRF and redirects, over the real route.
//   8. Audit and diagnostics carry metadata, never a credential and never a
//      body.
//
// No suite here contacts a real API and none performs DNS: `customApiFetch` and
// `outboundResolve` are both injected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { MasterKey, looksSealed } from '@josi-ce/core';
import {
  buildCustomApiRequest, customApiById, customApiEndpointById, describeCustomApiCall,
  listCustomApiEndpoints, requestCustomApiCall,
} from '@josi-ce/connectors';
import { buildBundle, redact } from '@josi-ce/ops';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-custom-api-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 41);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));
const masterKey = new MasterKey(KEY_BYTES);

/** Deliberately not shaped like a real credential: scripts/scan-secrets.sh is
 * right to refuse anything that is. */
const CREDENTIAL = 'fixture-custom-api-credential';

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

/** How DNS answers. The SSRF block flips this; everything else leaves it
 * public. */
let resolveAnswer: string[] = ['93.184.216.34'];
const outboundResolve = async () => resolveAnswer;

/** What the stubbed API does next. Each test sets it. */
let respond: (url: string, init: RequestInit) => Response;
/** Every request the stub saw, so the assertions can look at headers and URLs. */
let seen: Array<{ url: string; method: string; headers: Headers; body: string | null }> = [];

const customApiFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const request = init ?? {};
  seen.push({
    url: String(url),
    method: String(request.method ?? 'GET'),
    headers: new Headers(request.headers),
    body: typeof request.body === 'string' ? request.body : null,
  });
  return respond(String(url), request);
}) as unknown as typeof fetch;

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

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
  const jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = {
  admin: 'admin-password-123',
  alice: 'alice-password-123',
  bob: 'bob-password-123',
};

const CONNECTION_FORM = {
  name: 'Booking system',
  slug: 'booking',
  baseUrl: 'https://api.example.com/v1',
  authKind: 'bearer',
  secret: CREDENTIAL,
  testPath: '/health',
};

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'ca-admin@ce.test', username: 'caadmin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'ca-alice@ce.test', username: 'caalice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'ca-bob@ce.test', username: 'cabob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false,
    appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath },
    customApiFetch,
    outboundResolve,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('caadmin', PW.admin);
  cookies.alice = await signIn('caalice', PW.alice);
  cookies.bob = await signIn('cabob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  resolveAnswer = ['93.184.216.34'];
  seen = [];
  respond = () => ok({ ok: true });
  await db.query(`delete from custom_api_connections`);
});

/** Creates a connection, tests it, enables it, and enables one action. The
 * long way round on purpose: every step is a gate, and a helper that skipped
 * one would let a later test pass for the wrong reason. */
async function liveConnection(action: Record<string, unknown> = {}) {
  const created = await call('/api/admin/custom-apis', {
    method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
  });
  expect(created.status).toBe(201);
  const id = created.body.connection.id;

  const endpoint = await call(`/api/admin/custom-apis/${id}/endpoints`, {
    method: 'POST',
    jar: cookies.admin,
    body: {
      operationId: 'list_customers',
      summary: 'List the customers on the account',
      method: 'GET',
      pathTemplate: '/customers',
      parameters: [{ name: 'search', in: 'query', required: false }],
      ...action,
    },
  });
  expect(endpoint.status).toBe(201);

  expect((await call(`/api/admin/custom-apis/${id}/test`, { method: 'POST', jar: cookies.admin })).status).toBe(200);
  expect((await call(`/api/admin/custom-apis/${id}/enable`, { method: 'POST', jar: cookies.admin })).status).toBe(200);
  expect((await call(
    `/api/admin/custom-apis/endpoints/${endpoint.body.endpoint.id}/enable`,
    { method: 'POST', jar: cookies.admin },
  )).status).toBe(200);

  return { id, endpointId: endpoint.body.endpoint.id as string };
}

// ---------------------------------------------------------------- not preset

describe('nothing is connected until somebody connects it', () => {
  it('has no connection on a fresh installation', async () => {
    const res = await call('/api/admin/custom-apis', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([]);
  });

  it('offers the assistant nothing, and says so to members', async () => {
    const res = await call('/api/custom-apis', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.connections).toEqual([]);
  });
});

// ------------------------------------------------- authentication and access

describe('authentication and authorization', () => {
  it('refuses every route without a session', async () => {
    expect((await call('/api/admin/custom-apis')).status).toBe(401);
    expect((await call('/api/custom-apis')).status).toBe(401);
    expect((await call('/api/custom-apis/pending')).status).toBe(401);
  });

  it('refuses a member on every administrator route', async () => {
    expect((await call('/api/admin/custom-apis', { jar: cookies.alice })).status).toBe(403);
    expect((await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.alice, body: CONNECTION_FORM,
    })).status).toBe(403);
  });

  it('gives members no route that configures anything', async () => {
    // The member surface can look, and can decide its owner's own requests.
    // There is no route under it that defines, edits or enables a connection.
    expect((await call('/api/custom-apis', {
      method: 'POST', jar: cookies.alice, body: CONNECTION_FORM,
    })).status).toBe(404);
  });
});

// ------------------------------------------------------------ least privilege

describe('least privilege, twice', () => {
  it('creates a connection switched off and untested', async () => {
    const res = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    expect(res.status).toBe(201);
    expect(res.body.connection.enabled).toBe(false);
    expect(res.body.connection.connectionStatus).toBe('unverified');
    expect(res.body.connection.endpoints).toEqual([]);
  });

  it('refuses to enable a connection the API has never answered for', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/enable`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/test the connection first/i);
  });

  it('tests with a GET to the configured path and nothing else', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://api.example.com/v1/health', method: 'GET' });
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
    expect(res.body.connection.connectionStatus).toBe('active');
  });

  it('refuses HTTP, and says why', async () => {
    const res = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin,
      body: { ...CONNECTION_FORM, slug: 'plain', baseUrl: 'http://api.example.com' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https/);
  });

  it('leaves every imported and hand-added action switched off', async () => {
    const { id } = await liveConnection();
    const listed = await call('/api/admin/custom-apis', { jar: cookies.admin });
    const connection = listed.body.connections.find((c: any) => c.id === id);
    // The one enabled here is the one `liveConnection` deliberately switched on.
    expect(connection.endpoints.filter((e: any) => !e.enabled)).toHaveLength(0);

    const added = await call(`/api/admin/custom-apis/${id}/endpoints`, {
      method: 'POST', jar: cookies.admin,
      body: {
        operationId: 'delete_customer', summary: 'Delete a customer',
        method: 'DELETE', pathTemplate: '/customers/{id}',
        parameters: [{ name: 'id', in: 'path', required: true }],
      },
    });
    expect(added.body.endpoint.enabled).toBe(false);
    expect(added.body.endpoint.capability).toBe('delete');
  });

  it('takes a connection back to untested when its address is edited', async () => {
    const { id } = await liveConnection();
    const patched = await call(`/api/admin/custom-apis/${id}`, {
      method: 'PATCH', jar: cookies.admin, body: { baseUrl: 'https://api.other.example/v1' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.connection.enabled).toBe(false);
    expect(patched.body.connection.connectionStatus).toBe('unverified');
  });
});

// ---------------------------------------------------------------- the secret

describe('the credential never comes back', () => {
  it('stores ciphertext and serves a constant mask', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    expect(JSON.stringify(created.body)).not.toContain(CREDENTIAL);
    expect(created.body.connection.credentialMask).toBe('••••••••••••');
    // Not a prefix, not a length: the mask carries no bytes of the secret.
    expect(created.body.connection.credentialMask).not.toContain(CREDENTIAL.slice(0, 4));

    const [row] = await db.query<{ credentials_enc: string }>(
      `select credentials_enc from custom_api_connections where id = $1`,
      [created.body.connection.id],
    );
    expect(looksSealed(row.credentials_enc)).toBe(true);
    expect(row.credentials_enc).not.toContain(CREDENTIAL);

    // The ciphertext is not served either — it is something an attacker can
    // work on offline, and no surface needs it.
    const listed = await call('/api/admin/custom-apis', { jar: cookies.admin });
    expect(JSON.stringify(listed.body)).not.toContain(row.credentials_enc);
    expect(JSON.stringify(listed.body)).not.toContain(CREDENTIAL);
  });

  it('keeps the stored credential when an edit omits it', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const id = created.body.connection.id;
    await call(`/api/admin/custom-apis/${id}`, {
      method: 'PATCH', jar: cookies.admin, body: { name: 'Renamed booking system' },
    });
    await call(`/api/admin/custom-apis/${id}/test`, { method: 'POST', jar: cookies.admin });
    // Still the original credential — a form that re-sent the mask would have
    // stored the mask.
    expect(seen.at(-1)!.headers.get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('never puts the credential in the URL', async () => {
    await liveConnection();
    for (const request of seen) expect(request.url).not.toContain(CREDENTIAL);
  });

  it('shows members what Josi may do without showing them a credential', async () => {
    await liveConnection();
    const res = await call('/api/custom-apis', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.connections[0]).toMatchObject({ name: 'Booking system', host: 'api.example.com' });
    expect(JSON.stringify(res.body)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(res.body)).not.toContain('credentialMask');
  });
});

// --------------------------------------------------------------- the allowlist

describe('an OpenAPI import proposes, it does not grant', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Booking API' },
    servers: [{ url: 'https://attacker.example/v1' }],
    paths: {
      '/customers': { get: { operationId: 'listCustomers', summary: 'List customers' } },
      '/customers/{id}': { delete: { operationId: 'deleteCustomer', summary: 'Delete a customer' } },
    },
  };

  it('saves nothing when no actions are chosen', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const id = created.body.connection.id;
    const preview = await call(`/api/admin/custom-apis/${id}/endpoints/import`, {
      method: 'POST', jar: cookies.admin, body: { document: JSON.stringify(spec) },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.saved).toBe(0);
    expect(preview.body.proposals).toHaveLength(2);
    expect(await listCustomApiEndpoints(db, id)).toHaveLength(0);
  });

  it('reports the document’s own servers and refuses to use them', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const id = created.body.connection.id;
    const preview = await call(`/api/admin/custom-apis/${id}/endpoints/import`, {
      method: 'POST', jar: cookies.admin, body: { document: JSON.stringify(spec) },
    });
    expect(preview.body.declaredServers).toEqual(['https://attacker.example/v1']);
    expect(preview.body.note).toContain('api.example.com');

    await call(`/api/admin/custom-apis/${id}/endpoints/import`, {
      method: 'POST', jar: cookies.admin,
      body: { document: JSON.stringify(spec), operations: ['list_customers'] },
    });
    const [saved] = await listCustomApiEndpoints(db, id);
    expect(saved.path_template).toBe('/customers');
    expect(JSON.stringify(saved)).not.toContain('attacker.example');
  });

  it('saves only the chosen actions, switched off', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    const id = created.body.connection.id;
    const res = await call(`/api/admin/custom-apis/${id}/endpoints/import`, {
      method: 'POST', jar: cookies.admin,
      body: { document: JSON.stringify(spec), operations: ['delete_customer'] },
    });
    expect(res.status).toBe(201);
    expect(res.body.saved).toBe(1);
    const saved = await listCustomApiEndpoints(db, id);
    expect(saved).toHaveLength(1);
    expect(saved[0].operation_id).toBe('delete_customer');
    expect(saved[0].enabled).toBe(false);
    expect(saved[0].capability).toBe('delete');
  });
});

// ------------------------------------------------------------------ approval

describe('a write waits for its owner', () => {
  /** A pending request, made the way the assistant makes one. */
  async function pending(owner: 'alice' | 'bob', ttlSeconds?: number) {
    const { id } = await liveConnection();
    const added = await call(`/api/admin/custom-apis/${id}/endpoints`, {
      method: 'POST', jar: cookies.admin,
      body: {
        operationId: 'cancel_booking', summary: 'Cancel a booking',
        method: 'DELETE', pathTemplate: '/bookings/{id}',
        parameters: [{ name: 'id', in: 'path', required: true }],
      },
    });
    await call(`/api/admin/custom-apis/endpoints/${added.body.endpoint.id}/enable`, {
      method: 'POST', jar: cookies.admin,
    });

    const connection = (await customApiById(db, id))!;
    const endpoint = (await customApiEndpointById(db, added.body.endpoint.id))!;
    const request = buildCustomApiRequest({ connection, endpoint, arguments: { id: '42' } });
    const call_ = await requestCustomApiCall(db, masterKey, {
      ownerUserId: ids[owner],
      connection,
      endpoint,
      request,
      summary: describeCustomApiCall({ connection, endpoint, arguments: { id: '42' }, hasBody: false }),
      ttlSeconds,
    });
    seen = [];
    return call_;
  }

  it('shows the owner exactly what would be sent, and sends nothing yet', async () => {
    await pending('alice');
    const res = await call('/api/custom-apis/pending', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].summary).toContain('DELETE /bookings/{id}');
    expect(res.body.pending[0].summary).toContain('id: 42');
    expect(res.body.pending[0].capability).toBe('delete');
    expect(seen).toHaveLength(0);
  });

  it('is invisible to everybody else, including an administrator', async () => {
    await pending('alice');
    expect((await call('/api/custom-apis/pending', { jar: cookies.bob })).body.pending).toEqual([]);
    expect((await call('/api/custom-apis/pending', { jar: cookies.admin })).body.pending).toEqual([]);
  });

  it('answers 404, not 403, when somebody else tries to decide it', async () => {
    const row = await pending('alice');
    const res = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.bob,
    });
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
    // And an administrator is a member on this route.
    expect((await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.admin,
    })).status).toBe(404);
  });

  it('sends exactly the request that was described, once', async () => {
    const row = await pending('alice');
    respond = () => ok({ cancelled: true });
    const res = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 200, result: { cancelled: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'https://api.example.com/v1/bookings/42', method: 'DELETE',
    });

    // A second approval finds nothing pending and makes no request.
    const again = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(again.status).toBe(409);
    expect(seen).toHaveLength(1);
  });

  it('sends nothing when it is declined', async () => {
    const row = await pending('alice');
    const res = await call(`/api/custom-apis/pending/${row.id}/deny`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect((await call('/api/custom-apis/pending', { jar: cookies.alice })).body.pending).toEqual([]);
  });

  it('refuses an expired request rather than treating it as consent', async () => {
    const row = await pending('alice', 1);
    await db.query(
      `update custom_api_pending_calls set expires_at = now() - interval '1 minute' where id = $1`,
      [row.id],
    );
    const res = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/);
    expect(seen).toHaveLength(0);
  });

  it('refuses when an administrator switched the action off while it waited', async () => {
    const row = await pending('alice');
    const endpoint = (await customApiEndpointById(db, row.endpoint_id))!;
    await call(`/api/admin/custom-apis/endpoints/${endpoint.id}/disable`, {
      method: 'POST', jar: cookies.admin,
    });
    const res = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/switched that action off/);
    expect(seen).toHaveLength(0);
  });

  it('refuses when the sealed request no longer matches what was approved', async () => {
    const row = await pending('alice');
    // The shape of somebody editing the row a decision was pinned to.
    await db.query(
      `update custom_api_pending_calls set payload_hash = 'tampered' where id = $1`, [row.id],
    );
    const res = await call(`/api/custom-apis/pending/${row.id}/approve`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer matches/);
    expect(seen).toHaveLength(0);
  });

});

// ------------------------------------------------------------------- outbound

describe('SSRF and redirects, over the route', () => {
  it('refuses when DNS answers with a cloud-metadata address', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    resolveAnswer = ['169.254.169.254'];
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(502);
    expect(res.body.category).toBe('network');
    expect(seen).toHaveLength(0);
    // And the connection stays unusable.
    expect((await customApiById(db, created.body.connection.id))!.enabled).toBe(false);
  });

  it('refuses when DNS answers with one good address and one hostile one', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    resolveAnswer = ['93.184.216.34', '10.0.0.5'];
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  it('does not follow a redirect', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    respond = () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } });
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/does not follow/);
  });

  it('never passes the API’s own error text through', async () => {
    const created = await call('/api/admin/custom-apis', {
      method: 'POST', jar: cookies.admin, body: CONNECTION_FORM,
    });
    // An API quoting the request — including the Authorization header — back.
    respond = () => ok({ error: `bad token Bearer ${CREDENTIAL} on GET /v1/health` }, 401);
    const res = await call(`/api/admin/custom-apis/${created.body.connection.id}/test`, {
      method: 'POST', jar: cookies.admin,
    });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain(CREDENTIAL);
    expect(res.body.error).toMatch(/did not accept the stored credential/);
  });

  it('switches a connection off when its credential is refused', async () => {
    const { id } = await liveConnection();
    respond = () => ok({ error: 'nope' }, 401);
    await call(`/api/admin/custom-apis/${id}/test`, { method: 'POST', jar: cookies.admin });
    const row = (await customApiById(db, id))!;
    expect(row.enabled).toBe(false);
    expect(row.status).toBe('needs_attention');
    expect(row.last_error_category).toBe('revoked');
  });
});

// -------------------------------------------------------- audit and diagnostics

describe('what is recorded, and what is not', () => {
  it('records the configuration without recording the credential', async () => {
    const { id } = await liveConnection();
    const events = await db.query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from events where subject_id = $1 order by id`, [id],
    );
    expect(events.map((e) => e.kind)).toContain('custom_api.connection_created');
    expect(events.map((e) => e.kind)).toContain('custom_api.connection_tested');
    expect(events.map((e) => e.kind)).toContain('custom_api.connection_enabled');
    for (const event of events) {
      expect(JSON.stringify(event.payload)).not.toContain(CREDENTIAL);
    }
  });

  it('records a decided request as a status number, never a body', async () => {
    const { id } = await liveConnection();
    const added = await call(`/api/admin/custom-apis/${id}/endpoints`, {
      method: 'POST', jar: cookies.admin,
      body: {
        operationId: 'create_customer', summary: 'Create a customer',
        method: 'POST', pathTemplate: '/customers', parameters: [], acceptsBody: true,
      },
    });
    await call(`/api/admin/custom-apis/endpoints/${added.body.endpoint.id}/enable`, {
      method: 'POST', jar: cookies.admin,
    });
    const connection = (await customApiById(db, id))!;
    const endpoint = (await customApiEndpointById(db, added.body.endpoint.id))!;
    const request = buildCustomApiRequest({
      connection, endpoint, body: { name: 'Ada Lovelace', secret_note: 'private' },
    });
    const row = await requestCustomApiCall(db, masterKey, {
      ownerUserId: ids.alice, connection, endpoint, request, summary: 'Create a customer',
    });

    // Sealed, not readable in a dump while it waits.
    const [stored] = await db.query<{ request_enc: string }>(
      `select request_enc from custom_api_pending_calls where id = $1`, [row.id],
    );
    expect(looksSealed(stored.request_enc)).toBe(true);
    expect(stored.request_enc).not.toContain('Ada Lovelace');

    respond = () => ok({ id: 'cust_1' }, 201);
    await call(`/api/custom-apis/pending/${row.id}/approve`, { method: 'POST', jar: cookies.alice });

    const events = await db.query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from events where subject_id = $1 order by id`, [row.id],
    );
    expect(events.map((e) => e.kind)).toEqual([
      'custom_api.call_requested', 'custom_api.call_approved', 'custom_api.call_executed',
    ]);
    for (const event of events) {
      const text = JSON.stringify(event.payload);
      expect(text).not.toContain('Ada Lovelace');
      expect(text).not.toContain('cust_1');
      expect(text).not.toContain(CREDENTIAL);
    }
    expect(events.at(-1)!.payload.resultStatus).toBe(201);
  });

  it('builds a diagnostics bundle with a live connection present', async () => {
    // The collector reads `custom_api_connections` and `custom_api_endpoints`.
    // A bundle that still builds with rows in both is what says those queries
    // are right; the assertions about WHAT it may contain are below.
    await liveConnection();
    const created = await call('/api/ops/diagnostics', {
      method: 'POST', jar: cookies.admin, body: { window: '1h' },
    });
    expect(created.status).toBe(201);
    expect(created.body.byteSize).toBeGreaterThan(0);
    expect(JSON.stringify(created.body)).not.toContain(CREDENTIAL);
  });

  it('carries counts and never a name, a host or a credential', () => {
    // Built directly, because the bundle text is written to the operator's own
    // volume rather than served — so this is the only place its contents can be
    // asserted. The shape is exactly what opsRoutes passes.
    const built = buildBundle({
      version: '0.1.0',
      containers: [],
      resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
      configStatus: { custom_apis: true },
      migrations: [],
      logs: [],
      counts: {
        users: 3, threads: 0, documents: 0,
        custom_apis: 1, custom_apis_enabled: 1, custom_api_actions_enabled: 1,
      },
    });
    expect(built.text).toContain('custom_apis');
    expect(built.text).toContain('custom_api_actions_enabled');
    // A count, not an identity. A bundle goes to a third party's ticket system,
    // and a host is somebody's internal service.
    expect(built.text).not.toContain('Booking system');
    expect(built.text).not.toContain('api.example.com');
    expect(built.text).not.toContain(CREDENTIAL);
  });

  it('redacts a credential that reaches a log line anyway', () => {
    // Belt and braces: nothing in this feature logs one, and the diagnostics
    // redactor is what catches it if something later does.
    const { text } = redact(`authorization: Bearer ${CREDENTIAL}`);
    expect(text).not.toContain(CREDENTIAL);
  });
});
