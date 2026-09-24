// Custom API connections, attacked at the layer where the rules actually live.
//
// The route suite (apps/api/test/customApi.test.ts) drives the product. This
// one goes at the pieces directly, because the interesting failures here are
// not "the route returned the wrong code" — they are a path template that
// escapes its host, an argument that becomes a second URL, an OpenAPI document
// that moves the target, and a credential that reaches somewhere it should not.
//
// Nothing in this file performs DNS or contacts an API: both seams are injected.
import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey, looksSealed, openSealed } from '../../core/src/index.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  CustomApiError, CustomApiInputError,
  assertPublicHost, authHeaders, availableCustomApiActions, buildCustomApiRequest,
  buildCustomApiTestRequest, coerceArgument, createCustomApi, createCustomApiEndpoint,
  customApiById, customApiCapabilityForMethod, customApiFetch, describeCustomApiCall,
  enableCustomApi, listCustomApiEndpoints, openCustomApiCredentials, parseOpenApiDocument,
  proposeFromOpenApi, recordCustomApiCheck, resolveCustomApiAction, setCustomApiEndpointEnabled,
  updateCustomApi, validateCustomApiBaseUrl, validateCustomApiCredentials,
  validateCustomApiParameters, validateCustomApiPathTemplate, validateCustomApiSlug,
  type CustomApiConnectionRow, type CustomApiEndpointRow,
} from '../src/index.js';

const key = new MasterKey(Buffer.alloc(32, 7));
let db: TestDb;
let adminId: string;

/** A public address, so nothing here is refused for the wrong reason. */
const publicResolve = async () => ['93.184.216.34'];

async function connection(over: Record<string, unknown> = {}): Promise<CustomApiConnectionRow> {
  return createCustomApi(db, key, {
    actorUserId: adminId,
    name: 'Booking system',
    slug: 'booking',
    baseUrl: 'https://api.example.com/v1',
    host: 'api.example.com',
    authKind: 'bearer',
    authHeader: null,
    credentials: { secret: 'fixture-credential-value' },
    testPath: '/health',
    ...over,
  } as Parameters<typeof createCustomApi>[2]);
}

async function endpoint(
  conn: CustomApiConnectionRow,
  over: Partial<Parameters<typeof createCustomApiEndpoint>[1]['draft']> = {},
): Promise<CustomApiEndpointRow> {
  return createCustomApiEndpoint(db, {
    actorUserId: adminId,
    connection: conn,
    draft: {
      operationId: 'list_customers',
      summary: 'List customers',
      method: 'GET',
      pathTemplate: '/customers',
      parameters: [],
      acceptsBody: false,
      source: 'manual',
      ...over,
    },
  });
}

beforeEach(async () => {
  db = await testDb();
  adminId = (await createUser(db, {
    email: 'ca-admin@ce.test', username: 'caadmin', role: 'super_admin',
  })).id;
});

// ------------------------------------------------------------- the base URL

describe('the base URL is the host allowlist', () => {
  it('refuses anything that is not https', () => {
    expect(() => validateCustomApiBaseUrl('http://api.example.com')).toThrow(CustomApiInputError);
    expect(() => validateCustomApiBaseUrl('ftp://api.example.com')).toThrow(CustomApiInputError);
    // The reason is stated, not just the refusal: a credential on the wire in
    // clear text is what this rule is about.
    expect(() => validateCustomApiBaseUrl('http://api.example.com'))
      .toThrow(/credential/i);
  });

  it('refuses credentials in the address', () => {
    expect(() => validateCustomApiBaseUrl('https://user:pass@api.example.com'))
      .toThrow(/authentication fields/);
  });

  it('refuses a query string or fragment, rather than silently dropping it', () => {
    expect(() => validateCustomApiBaseUrl('https://api.example.com/v1?key=abc')).toThrow(CustomApiInputError);
    expect(() => validateCustomApiBaseUrl('https://api.example.com/v1#x')).toThrow(CustomApiInputError);
  });

  it('lower-cases the host so the later comparison is not a locale question', () => {
    expect(validateCustomApiBaseUrl('https://API.Example.COM/v1')).toEqual({
      baseUrl: 'https://api.example.com/v1', host: 'api.example.com',
    });
  });

  it('makes a usable short name from a name that is not one', () => {
    expect(validateCustomApiSlug('', 'Our Booking System!')).toBe('our_booking_system');
    expect(validateCustomApiSlug('', '1st API')).toBe('api_1st_api');
    // A slug that could carry a path, a quote or a newline is refused outright.
    expect(() => validateCustomApiSlug('booking/system')).toThrow(CustomApiInputError);
    expect(() => validateCustomApiSlug('Booking System')).toThrow(CustomApiInputError);
  });
});

// -------------------------------------------------------- the path template

describe('a path template is a path, never an address', () => {
  it.each([
    'https://elsewhere.example/steal',
    '//elsewhere.example/steal',
    '/customers/../../admin',
    'customers',
    '/customers?deleted=true',
  ])('refuses %s', (value) => {
    expect(() => validateCustomApiPathTemplate(value)).toThrow(CustomApiInputError);
  });

  it('refuses a placeholder with no parameter behind it', () => {
    expect(() => validateCustomApiParameters([], '/customers/{id}'))
      .toThrow(/no path parameter called "id"/);
  });

  it('forces a path parameter to be required, whatever the form claimed', () => {
    const params = validateCustomApiParameters(
      [{ name: 'id', in: 'path', required: false }], '/customers/{id}',
    );
    expect(params[0].required).toBe(true);
  });

  it('refuses header and cookie parameters, because a header is not reviewable', () => {
    expect(() => validateCustomApiParameters([{ name: 'x', in: 'header' }], '/customers'))
      .toThrow(/Header and cookie parameters/);
  });
});

// ------------------------------------------------------- building a request

describe('building a request cannot leave the connection', () => {
  it('percent-encodes a path value so it cannot become a new segment', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      operationId: 'get_customer',
      pathTemplate: '/customers/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const built = buildCustomApiRequest({
      connection: conn, endpoint: ep, arguments: { id: '../../admin/keys' },
    });
    expect(built.url).toBe('https://api.example.com/v1/customers/..%2F..%2Fadmin%2Fkeys');
    expect(new URL(built.url).hostname).toBe('api.example.com');
  });

  it('cannot be pointed at another host through a path value', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      operationId: 'get_customer',
      pathTemplate: '/customers/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const built = buildCustomApiRequest({
      connection: conn, endpoint: ep, arguments: { id: 'https://elsewhere.example/steal' },
    });
    expect(new URL(built.url).hostname).toBe('api.example.com');
  });

  it('refuses when the stored row no longer agrees with the host column', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    // The shape of a base URL edited after the row was written, or a bug that
    // set one without the other. The finished URL is what is checked.
    const tampered = { ...conn, base_url: 'https://elsewhere.example/v1' };
    expect(() => buildCustomApiRequest({ connection: tampered, endpoint: ep }))
      .toThrow(/would leave Booking system/);
  });

  it('drops an argument the action does not declare, and says which', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      parameters: [{ name: 'search', in: 'query', required: false, description: '' }],
    });
    const built = buildCustomApiRequest({
      connection: conn, endpoint: ep, arguments: { search: 'ada', admin: 'true' },
    });
    expect(built.url).toBe('https://api.example.com/v1/customers?search=ada');
    expect(built.ignored).toEqual(['admin']);
  });

  it('refuses a value carrying a newline, rather than encoding it away', () => {
    expect(() => coerceArgument('id', 'abc\r\nX-Admin: true')).toThrow(CustomApiInputError);
  });

  it('refuses a list or an object where a value belongs', () => {
    expect(() => coerceArgument('ids', ['a', 'b'])).toThrow(/does not accept a list/);
  });

  it('refuses a missing required value rather than sending a hole', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      pathTemplate: '/customers/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    expect(() => buildCustomApiRequest({ connection: conn, endpoint: ep, arguments: {} }))
      .toThrow(/needs a value for "id"/);
  });

  it('sends no body on a read, whatever the caller passes', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    expect(ep.accepts_body).toBe(false);
    const built = buildCustomApiRequest({
      connection: conn, endpoint: ep, body: { anything: true },
    });
    expect(built.body).toBeNull();
  });

  it('keeps the test request to a GET on the same host', async () => {
    const conn = await connection();
    const built = buildCustomApiTestRequest(conn);
    expect(built).toMatchObject({ url: 'https://api.example.com/v1/health', method: 'GET', body: null });
  });
});

// ------------------------------------------------- read, write and delete

describe('read is separated from write and delete by the method', () => {
  it.each([
    ['GET', 'read'], ['HEAD', 'read'],
    ['POST', 'write'], ['PUT', 'write'], ['PATCH', 'write'],
    ['DELETE', 'delete'],
  ] as const)('%s is a %s', (method, capability) => {
    expect(customApiCapabilityForMethod(method)).toBe(capability);
  });

  it('stores the capability the method implies, not one the caller asked for', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      operationId: 'cancel_booking', method: 'DELETE', pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    expect(ep.capability).toBe('delete');
  });

  it('refuses a body on a read at the database as well as in code', async () => {
    const conn = await connection();
    await expect(db.query(
      `insert into custom_api_endpoints
         (connection_id, operation_id, summary, method, path_template, capability, accepts_body)
       values ($1, 'bad_read', 'x', 'GET', '/x', 'read', true)`,
      [conn.id],
    )).rejects.toThrow();
  });

  it('refuses a capability that contradicts the method, at the database', async () => {
    const conn = await connection();
    await expect(db.query(
      `insert into custom_api_endpoints
         (connection_id, operation_id, summary, method, path_template, capability)
       values ($1, 'liar', 'A delete labelled as a read', 'DELETE', '/x', 'read')`,
      [conn.id],
    )).rejects.toThrow();
  });
});

// ------------------------------------------------------------ least privilege

describe('nothing is available until somebody makes it so', () => {
  it('creates a connection disabled and unverified', async () => {
    const conn = await connection();
    expect(conn.enabled).toBe(false);
    expect(conn.status).toBe('unverified');
  });

  it('refuses to enable a connection that has never answered', async () => {
    const conn = await connection();
    await expect(enableCustomApi(db, { actorUserId: adminId, connection: conn }))
      .rejects.toThrow(/test the connection first/i);
  });

  it('creates every endpoint switched off', async () => {
    const conn = await connection();
    expect((await endpoint(conn)).enabled).toBe(false);
  });

  it('offers nothing to the assistant until both switches are on', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    expect(await availableCustomApiActions(db)).toHaveLength(0);

    await setCustomApiEndpointEnabled(db, {
      actorUserId: adminId, connection: conn, endpoint: ep, enabled: true,
    });
    // The endpoint is on; the connection is not. Still nothing.
    expect(await availableCustomApiActions(db)).toHaveLength(0);

    await recordCustomApiCheck(db, { connectionId: conn.id, ok: true });
    await enableCustomApi(db, {
      actorUserId: adminId, connection: (await customApiById(db, conn.id))!,
    });
    expect(await availableCustomApiActions(db)).toHaveLength(1);
  });

  it('stops resolving an action the moment its connection is switched off', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    await setCustomApiEndpointEnabled(db, {
      actorUserId: adminId, connection: conn, endpoint: ep, enabled: true,
    });
    await recordCustomApiCheck(db, { connectionId: conn.id, ok: true });
    await enableCustomApi(db, { actorUserId: adminId, connection: (await customApiById(db, conn.id))! });
    expect(await resolveCustomApiAction(db, { slug: 'booking', operationId: 'list_customers' })).not.toBeNull();

    await db.query(`update custom_api_connections set enabled = false where id = $1`, [conn.id]);
    expect(await resolveCustomApiAction(db, { slug: 'booking', operationId: 'list_customers' })).toBeNull();
  });

  it('takes a connection back to unverified when its address changes', async () => {
    const conn = await connection();
    await recordCustomApiCheck(db, { connectionId: conn.id, ok: true });
    const tested = (await customApiById(db, conn.id))!;
    await enableCustomApi(db, { actorUserId: adminId, connection: tested });

    const moved = await updateCustomApi(db, key, {
      actorUserId: adminId,
      connection: (await customApiById(db, conn.id))!,
      baseUrl: 'https://api.other.example/v1',
      host: 'api.other.example',
    });
    expect(moved.enabled).toBe(false);
    expect(moved.status).toBe('unverified');
    expect(moved.last_check_ok).toBeNull();
  });

  it('switches a connection off when its credential is refused, but not on a 403', async () => {
    const conn = await connection();
    await recordCustomApiCheck(db, { connectionId: conn.id, ok: true });
    await enableCustomApi(db, { actorUserId: adminId, connection: (await customApiById(db, conn.id))! });

    // A 403 is very often about one record rather than about the credential.
    await recordCustomApiCheck(db, { connectionId: conn.id, ok: false, category: 'insufficient_scope' });
    let row = (await customApiById(db, conn.id))!;
    expect(row.status).toBe('needs_attention');
    expect(row.enabled).toBe(true);

    await recordCustomApiCheck(db, { connectionId: conn.id, ok: false, category: 'revoked' });
    row = (await customApiById(db, conn.id))!;
    expect(row.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------- credentials

describe('the credential is sealed and never derived from', () => {
  it('stores ciphertext, and the row holds no plaintext', async () => {
    const conn = await connection();
    expect(looksSealed(conn.credentials_enc)).toBe(true);
    expect(JSON.stringify(conn)).not.toContain('fixture-credential-value');
    const [raw] = await db.query<Record<string, unknown>>(
      `select * from custom_api_connections where id = $1`, [conn.id],
    );
    expect(JSON.stringify(raw)).not.toContain('fixture-credential-value');
    expect(openSealed<{ secret: string }>(key, conn.credentials_enc).secret)
      .toBe('fixture-credential-value');
  });

  it('puts the credential in a header and never in the URL', async () => {
    const conn = await connection();
    expect(authHeaders(conn, openCustomApiCredentials(key, conn)))
      .toEqual({ authorization: 'Bearer fixture-credential-value' });

    const apiKey = await connection({
      slug: 'keyed', authKind: 'api_key', authHeader: 'X-API-Key',
      credentials: { secret: 'fixture-api-key-value' },
    });
    expect(authHeaders(apiKey, openCustomApiCredentials(key, apiKey)))
      .toEqual({ 'x-api-key': 'fixture-api-key-value' });

    const basic = await connection({
      slug: 'basic_one', authKind: 'basic',
      credentials: { username: 'someone', password: 'fixture-password-value' },
    });
    expect(authHeaders(basic, openCustomApiCredentials(key, basic)))
      .toEqual({ authorization: `Basic ${Buffer.from('someone:fixture-password-value').toString('base64')}` });
  });

  it('refuses a credential carrying a newline, which is header injection', () => {
    expect(() => validateCustomApiCredentials('bearer', { secret: 'abc\r\nX-Admin: 1' }))
      .toThrow(CustomApiInputError);
  });

  it('records who configured it without recording what they configured', async () => {
    const conn = await connection();
    const [event] = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from events where subject_id = $1 and kind = 'custom_api.connection_created'`,
      [conn.id],
    );
    expect(event.payload).toEqual({ slug: 'booking', host: 'api.example.com', authKind: 'bearer' });
    expect(JSON.stringify(event.payload)).not.toContain('fixture-credential-value');
  });
});

// ----------------------------------------------------------------- outbound

describe('SSRF defences', () => {
  it.each([
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'a private network'],
    ['192.168.1.5', 'a private network'],
    ['::1', 'loopback over v6'],
    ['::ffff:a9fe:a9fe', 'metadata through a v4-mapped v6 literal'],
  ])('refuses %s (%s)', async (address) => {
    await expect(assertPublicHost('api.example.com', { resolve: async () => [address] }))
      .rejects.toThrow(CustomApiError);
  });

  it('refuses when ANY answer is hostile, not only the first', async () => {
    await expect(assertPublicHost('api.example.com', {
      resolve: async () => ['93.184.216.34', '169.254.169.254'],
    })).rejects.toThrow(/refused the request/);
  });

  it('checks a literal address in the base URL, which never reaches a resolver', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow(CustomApiError);
    await expect(assertPublicHost('93.184.216.34')).resolves.toEqual(['93.184.216.34']);
  });

  it('resolves at REQUEST time, so a rebind between save and use is caught', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    const request = buildCustomApiRequest({ connection: conn, endpoint: ep });
    await expect(customApiFetch(
      { connection: conn, request, secret: { secret: 'x' } },
      { resolve: async () => ['169.254.169.254'], fetchImpl: (async () => new Response('{}')) as typeof fetch },
    )).rejects.toThrow(/refused the request/);
  });

  it('does not follow a redirect', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    const request = buildCustomApiRequest({ connection: conn, endpoint: ep });
    const fetchImpl = (async () => new Response(null, {
      status: 302, headers: { location: 'https://169.254.169.254/' },
    })) as unknown as typeof fetch;
    await expect(customApiFetch(
      { connection: conn, request, secret: { secret: 'x' } },
      { resolve: publicResolve, fetchImpl },
    )).rejects.toThrow(/does not follow/);
  });

  it('refuses a request whose URL no longer matches the connection, even here', async () => {
    const conn = await connection();
    await expect(customApiFetch(
      {
        connection: conn,
        request: { url: 'https://elsewhere.example/v1/customers', method: 'GET', body: null },
        secret: { secret: 'x' },
      },
      { resolve: publicResolve, fetchImpl: (async () => new Response('{}')) as typeof fetch },
    )).rejects.toThrow(/would leave Booking system/);
  });

  it('sends the credential in a header, to the allowlisted URL, and reads the answer', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    const request = buildCustomApiRequest({ connection: conn, endpoint: ep });
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init.headers) };
      return new Response(JSON.stringify({ customers: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await customApiFetch(
      { connection: conn, request, secret: openCustomApiCredentials(key, conn) },
      { resolve: publicResolve, fetchImpl },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customers: [] });
    expect(seen!.url).toBe('https://api.example.com/v1/customers');
    expect(seen!.headers.get('authorization')).toBe('Bearer fixture-credential-value');
    // Never in the URL: a URL reaches logs, proxies and error messages.
    expect(seen!.url).not.toContain('fixture-credential-value');
  });

  it('never passes an API error body through', async () => {
    const conn = await connection();
    const ep = await endpoint(conn);
    const request = buildCustomApiRequest({ connection: conn, endpoint: ep });
    // The shape that matters: an API quoting the request — including its
    // Authorization header — back at us.
    const hostile = JSON.stringify({
      error: 'bad credential Bearer fixture-credential-value on GET /v1/customers',
    });
    const res = await customApiFetch(
      { connection: conn, request, secret: openCustomApiCredentials(key, conn) },
      {
        resolve: publicResolve,
        fetchImpl: (async () => new Response(hostile, { status: 401 })) as unknown as typeof fetch,
      },
    );
    // `customApiFetch` returns the status; it is the CALLERS that must not
    // relay the body, and they use `customApiSentence`. What is asserted here
    // is that nothing in the transport turned the body into a thrown message.
    expect(res.status).toBe(401);
  });
});

// ------------------------------------------------------------------ OpenAPI

describe('an OpenAPI document proposes, it does not grant', () => {
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Booking API' },
    // The line this whole feature turns on: a document that tries to move the
    // target.
    servers: [{ url: 'https://attacker.example/v1' }],
    components: {
      parameters: {
        Limit: { name: 'limit', in: 'query', description: 'How many', required: false },
      },
    },
    paths: {
      '/customers': {
        get: {
          operationId: 'listCustomers',
          summary: 'List customers',
          parameters: [{ $ref: '#/components/parameters/Limit' }],
        },
        post: {
          operationId: 'createCustomer',
          summary: 'Create a customer',
          requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
      '/customers/{id}': {
        delete: { operationId: 'deleteCustomer', summary: 'Delete a customer' },
      },
      '/broken path': { get: { operationId: 'broken', summary: 'Unusable' } },
    },
  };

  it('ignores the servers in the document entirely, and reports them', () => {
    const result = proposeFromOpenApi(spec);
    expect(result.declaredServers).toEqual(['https://attacker.example/v1']);
    for (const proposal of result.proposals) {
      expect(proposal.pathTemplate.startsWith('/')).toBe(true);
      expect(proposal.pathTemplate).not.toContain('attacker.example');
      expect(JSON.stringify(proposal)).not.toContain('attacker.example');
    }
  });

  it('derives the capability from the method, not from the document', () => {
    const byId = new Map(proposeFromOpenApi(spec).proposals.map((p) => [p.operationId, p]));
    expect(byId.get('list_customers')!.method).toBe('GET');
    expect(byId.get('create_customer')!.acceptsBody).toBe(true);
    expect(byId.get('delete_customer')!.method).toBe('DELETE');
  });

  it('resolves a local $ref for a parameter, one hop', () => {
    const listed = proposeFromOpenApi(spec).proposals.find((p) => p.operationId === 'list_customers')!;
    expect(listed.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, description: 'How many' },
    ]);
  });

  it('adds the placeholder a document forgot to declare', () => {
    const deleted = proposeFromOpenApi(spec).proposals.find((p) => p.operationId === 'delete_customer')!;
    expect(deleted.parameters).toEqual([{ name: 'id', in: 'path', required: true, description: '' }]);
  });

  it('skips what it cannot use, with a reason, rather than failing the import', () => {
    const result = proposeFromOpenApi(spec);
    expect(result.skipped.map((s) => s.path)).toContain('/broken path');
    expect(result.skipped[0].reason.length).toBeGreaterThan(10);
  });

  it('refuses Swagger 2 and YAML by name rather than guessing', () => {
    expect(() => proposeFromOpenApi({ swagger: '2.0', paths: {} })).toThrow(/Swagger 2.0/);
    expect(() => parseOpenApiDocument('openapi: 3.0.0\npaths: {}')).toThrow(/YAML/);
    expect(() => parseOpenApiDocument('not json at all')).toThrow(/valid JSON/);
  });

  it('everything it proposes still arrives switched off', async () => {
    const conn = await connection();
    for (const draft of proposeFromOpenApi(spec).proposals) {
      await createCustomApiEndpoint(db, { actorUserId: adminId, connection: conn, draft });
    }
    const saved = await listCustomApiEndpoints(db, conn.id);
    expect(saved.length).toBeGreaterThan(2);
    expect(saved.every((e) => !e.enabled)).toBe(true);
    expect(saved.every((e) => e.source === 'openapi')).toBe(true);
  });

  it('drops a header parameter, because a header the assistant sets is unreviewed', () => {
    const withHeader = proposeFromOpenApi({
      openapi: '3.0.0',
      paths: {
        '/x': {
          get: {
            operationId: 'x',
            summary: 'x',
            parameters: [{ name: 'Authorization', in: 'header', required: true }],
          },
        },
      },
    });
    expect(withHeader.proposals[0].parameters).toEqual([]);
  });
});

// -------------------------------------------------------------- the summary

describe('what the owner is shown before they agree', () => {
  it('describes the action from the allowlist row, not from anything a model said', async () => {
    const conn = await connection();
    const ep = await endpoint(conn, {
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const summary = describeCustomApiCall({
      connection: conn, endpoint: ep, arguments: { id: '42' }, hasBody: false,
    });
    expect(summary).toContain('delete something in Booking system');
    expect(summary).toContain('cancel_booking');
    expect(summary).toContain('DELETE /bookings/{id}');
    expect(summary).toContain('id: 42');
  });
});
