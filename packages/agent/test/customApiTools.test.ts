// The boundary between the model and an administrator's API.
//
// Everything here is about what the assistant CANNOT do. The route suite proves
// the configuration surface and the connectors suite proves the transport; this
// one asks the only question left: given a model that will happily try
// anything, what actually reaches the network?
//
// It goes through `executeAssistantTool` rather than through the tool module
// directly, because that is the function BOTH callers use — the in-process agent
// loop and the MCP server that hands these same tools to a subscription CLI's
// own agent loop. A guarantee proved anywhere else would be a guarantee one of
// those two does not have.
import { beforeEach, describe, expect, it } from 'vitest';
import { MasterKey, looksSealed, openSealed } from '../../core/src/index.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  createCustomApi, createCustomApiEndpoint, customApiById, enableCustomApi,
  recordCustomApiCheck, setCustomApiEndpointEnabled,
  type CustomApiConnectionRow, type CustomApiEndpointDraft,
} from '../../connectors/src/index.js';
import { customApiToolAvailability } from '../src/customApiTools.js';
import { executeAssistantTool } from '../src/execute.js';
import { ALL_TOOLS, TOOL_SPECS_BY_NAME } from '../src/tools.js';

const key = new MasterKey(Buffer.alloc(32, 11));
const CREDENTIAL = 'fixture-custom-api-credential';

let db: TestDb;
let adminId: string;
let aliceId: string;
let connection: CustomApiConnectionRow;

let seen: Array<{ url: string; method: string; headers: Headers }> = [];
let respond: () => Response;

const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
  seen.push({
    url: String(url),
    method: String(init?.method ?? 'GET'),
    headers: new Headers(init?.headers),
  });
  return respond();
}) as unknown as typeof fetch;

const access = () => ({
  masterKey: () => key,
  customApiFetch: fetchImpl,
  resolve: async () => ['93.184.216.34'],
});

async function allow(draft: Partial<CustomApiEndpointDraft> = {}) {
  const endpoint = await createCustomApiEndpoint(db, {
    actorUserId: adminId,
    connection,
    draft: {
      operationId: 'list_customers',
      summary: 'List the customers on the account',
      method: 'GET',
      pathTemplate: '/customers',
      parameters: [{ name: 'search', in: 'query', required: false, description: 'Name fragment' }],
      acceptsBody: false,
      source: 'manual',
      ...draft,
    },
  });
  await setCustomApiEndpointEnabled(db, {
    actorUserId: adminId, connection, endpoint, enabled: true,
  });
  return endpoint;
}

const run = (name: string, input: Record<string, unknown>) =>
  executeAssistantTool(db, { userId: aliceId, threadId: null, connectors: access() }, name, input);

beforeEach(async () => {
  db = await testDb();
  seen = [];
  respond = () => new Response(JSON.stringify({ customers: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  adminId = (await createUser(db, { email: 'cat-admin@ce.test', username: 'catadmin', role: 'super_admin' })).id;
  aliceId = (await createUser(db, { email: 'cat-alice@ce.test', username: 'catalice', role: 'member' })).id;

  connection = await createCustomApi(db, key, {
    actorUserId: adminId,
    name: 'Booking system',
    slug: 'booking',
    baseUrl: 'https://api.example.com/v1',
    host: 'api.example.com',
    authKind: 'bearer',
    authHeader: null,
    credentials: { secret: CREDENTIAL },
    testPath: '/health',
  });
  await recordCustomApiCheck(db, { connectionId: connection.id, ok: true });
  connection = (await customApiById(db, connection.id))!;
  await enableCustomApi(db, { actorUserId: adminId, connection });
  connection = (await customApiById(db, connection.id))!;
});

// ---------------------------------------------------------------- offering

describe('the tools exist only when something is behind them', () => {
  it('offers nothing when no action is switched on', async () => {
    const availability = await customApiToolAvailability(db);
    expect(availability.specs).toEqual([]);
    expect(availability.connectionNames).toEqual([]);
  });

  it('offers nothing when the connection is switched off, however many actions exist', async () => {
    await allow();
    await db.query(`update custom_api_connections set enabled = false where id = $1`, [connection.id]);
    expect((await customApiToolAvailability(db)).specs).toEqual([]);
  });

  it('names the actions and marks the ones that need approval', async () => {
    await allow();
    await allow({
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const availability = await customApiToolAvailability(db);
    const call = availability.specs.find((s) => s.def.name === 'call_custom_api')!;
    expect(call.def.description).toContain('booking.list_customers');
    expect(call.def.description).toContain('booking.cancel_booking — Cancel a booking [needs the user to approve first]');
    // Read actions are NOT marked, so the distinction means something.
    expect(call.def.description)
      .toContain('booking.list_customers — List the customers on the account');
    expect(call.def.description)
      .not.toContain('booking.list_customers — List the customers on the account [needs');
    expect(availability.connectionNames).toEqual(['Booking system']);
  });

  it('offers no argument the model could fill with an address', async () => {
    await allow();
    const call = (await customApiToolAvailability(db)).specs
      .find((s) => s.def.name === 'call_custom_api')!;
    expect(Object.keys(call.def.parameters.properties as object).sort())
      .toEqual(['arguments', 'body', 'connection', 'operation']);
  });

  it('is in the catalogue, so the agent loop and the MCP server can both find it', () => {
    // A tool that can be offered and cannot be looked up is a tool the model is
    // handed and then told does not exist.
    expect(TOOL_SPECS_BY_NAME.get('call_custom_api')).toBeTruthy();
    expect(TOOL_SPECS_BY_NAME.get('list_custom_api_actions')).toBeTruthy();
    expect(ALL_TOOLS.map((t) => t.def.name)).toContain('call_custom_api');
  });

  it('never gives a tool an action class, so no preference can loosen it', () => {
    // The approval decision comes from the endpoint's capability column, which
    // the database ties to the HTTP method. A user-settable approval level that
    // could make a delete automatic is exactly what must not exist here.
    for (const name of ['call_custom_api', 'list_custom_api_actions']) {
      expect(TOOL_SPECS_BY_NAME.get(name)!.actionClass).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- reads

describe('a read runs', () => {
  it('sends exactly the allowlisted request, with the credential in a header', async () => {
    await allow();
    respond = () => new Response(JSON.stringify({ customers: [{ id: 1 }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'list_customers', arguments: { search: 'ada' },
    }) as Record<string, unknown>;

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ customers: [{ id: 1 }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.example.com/v1/customers?search=ada');
    expect(seen[0].method).toBe('GET');
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
  });

  it('never returns anything the credential can be recovered from', async () => {
    await allow();
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'list_customers',
    });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it('drops arguments the action does not declare, and says which', async () => {
    await allow();
    const result = await run('call_custom_api', {
      connection: 'booking',
      operation: 'list_customers',
      arguments: { search: 'ada', url: 'https://elsewhere.example', authorization: 'Bearer x' },
    }) as Record<string, unknown>;
    expect(seen[0].url).toBe('https://api.example.com/v1/customers?search=ada');
    expect(result.ignored_arguments).toEqual(['url', 'authorization']);
  });

  it('gives CE’s sentence when the API refuses, never the API’s own words', async () => {
    await allow();
    respond = () => new Response(
      JSON.stringify({ error: `bad token Bearer ${CREDENTIAL} on GET /v1/customers` }),
      { status: 401 },
    );
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'list_customers',
    }) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(String(result.message)).toMatch(/did not accept the stored credential/);
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
  });

  it('refuses at request time when DNS answers with a hostile address', async () => {
    await allow();
    const result = await executeAssistantTool(
      db,
      {
        userId: aliceId,
        threadId: null,
        connectors: { ...access(), resolve: async () => ['169.254.169.254'] },
      },
      'call_custom_api',
      { connection: 'booking', operation: 'list_customers' },
    ) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

// --------------------------------------------------------- writes and deletes

describe('a write or a delete waits for the person', () => {
  it('sends nothing and records a pending request instead', async () => {
    const endpoint = await allow({
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    // A long, distinctive value on purpose. Asserting that ciphertext does not
    // contain a two-character string is not an assertion — random base64
    // contains "42" often enough to fail a suite for no reason, which is
    // exactly what this test did once before it was written this way.
    const BOOKING = 'fixture-booking-reference';
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'cancel_booking', arguments: { id: BOOKING },
    }) as Record<string, unknown>;

    expect(seen).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('needs_approval');
    expect(String(result.what_would_happen)).toContain('DELETE /bookings/{id}');
    // The message the model relays must not let it claim the work is done.
    expect(String(result.message)).toMatch(/has NOT been done/);

    const [row] = await db.query<{
      owner_user_id: string; endpoint_id: string; status: string; request_enc: string;
    }>(`select * from custom_api_pending_calls`);
    expect(row.owner_user_id).toBe(aliceId);
    expect(row.endpoint_id).toBe(endpoint.id);
    expect(row.status).toBe('pending');
    // The arguments are sealed: somebody's data has no business being readable
    // in a dump while it waits for an answer. Proved both ways — the row is
    // ciphertext, and the value is only recoverable with the key.
    expect(looksSealed(row.request_enc)).toBe(true);
    expect(row.request_enc).not.toContain(BOOKING);
    expect(openSealed<{ url: string }>(key, row.request_enc).url)
      .toBe(`https://api.example.com/v1/bookings/${BOOKING}`);
  });

  it('treats a POST as a write even when the API calls it a search', async () => {
    await allow({
      operationId: 'search_customers', summary: 'Search customers', method: 'POST',
      pathTemplate: '/customers/search', parameters: [], acceptsBody: true,
    });
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'search_customers', body: { q: 'ada' },
    }) as Record<string, unknown>;
    expect(result.error).toBe('needs_approval');
    expect(seen).toHaveLength(0);
  });

  it('raises one pending request for the same ask, not two', async () => {
    await allow({
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const first = await run('call_custom_api', {
      connection: 'booking', operation: 'cancel_booking', arguments: { id: '42' },
    }) as Record<string, unknown>;
    const second = await run('call_custom_api', {
      connection: 'booking', operation: 'cancel_booking', arguments: { id: '42' },
    }) as Record<string, unknown>;
    expect(second.approval_id).toBe(first.approval_id);
    expect(await db.query(`select id from custom_api_pending_calls`)).toHaveLength(1);
  });

  it('raises a separate request for a different record', async () => {
    await allow({
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    await run('call_custom_api', { connection: 'booking', operation: 'cancel_booking', arguments: { id: '42' } });
    await run('call_custom_api', { connection: 'booking', operation: 'cancel_booking', arguments: { id: '43' } });
    expect(await db.query(`select id from custom_api_pending_calls`)).toHaveLength(2);
  });
});

// ------------------------------------------------------------- what it cannot do

describe('there is no way to reach anything not on the list', () => {
  it('refuses an operation that is not allowed, and says so honestly', async () => {
    await allow();
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'delete_everything',
    }) as Record<string, unknown>;
    expect(result.error).toBe('not_found');
    expect(String(result.message)).toMatch(/no way to call anything else/);
    expect(seen).toHaveLength(0);
  });

  it('refuses an action switched off between offering and calling', async () => {
    const endpoint = await allow();
    // The tool was offered a moment ago; the administrator has since changed
    // their mind. The offering is never the authority.
    await setCustomApiEndpointEnabled(db, {
      actorUserId: adminId, connection, endpoint, enabled: false,
    });
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'list_customers',
    }) as Record<string, unknown>;
    expect(result.error).toBe('not_found');
    expect(seen).toHaveLength(0);
  });

  it('refuses a connection switched off between offering and calling', async () => {
    await allow();
    await db.query(`update custom_api_connections set enabled = false where id = $1`, [connection.id]);
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'list_customers',
    }) as Record<string, unknown>;
    expect(result.error).toBe('not_found');
    expect(seen).toHaveLength(0);
  });

  it('cannot be steered off the host by a path value', async () => {
    await allow({
      operationId: 'get_customer', summary: 'Get one customer', method: 'GET',
      pathTemplate: '/customers/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    await run('call_custom_api', {
      connection: 'booking', operation: 'get_customer',
      arguments: { id: 'https://elsewhere.example/steal' },
    });
    expect(new URL(seen[0].url).hostname).toBe('api.example.com');
  });

  it('refuses a value that could split the request', async () => {
    await allow({
      operationId: 'get_customer', summary: 'Get one customer', method: 'GET',
      pathTemplate: '/customers/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const result = await run('call_custom_api', {
      connection: 'booking', operation: 'get_customer',
      arguments: { id: 'a\r\nX-Admin: true' },
    }) as Record<string, unknown>;
    expect(result.error).toBe('bad_arguments');
    expect(seen).toHaveLength(0);
  });

  it('refuses honestly when it cannot open a credential at all', async () => {
    await allow();
    const result = await executeAssistantTool(
      db, { userId: aliceId, threadId: null, connectors: null },
      'call_custom_api', { connection: 'booking', operation: 'list_customers' },
    ) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ listing

describe('listing the allowlist', () => {
  it('describes what is allowed and makes no request', async () => {
    await allow();
    await allow({
      operationId: 'cancel_booking', summary: 'Cancel a booking', method: 'DELETE',
      pathTemplate: '/bookings/{id}',
      parameters: [{ name: 'id', in: 'path', required: true, description: '' }],
    });
    const result = await run('list_custom_api_actions', {}) as {
      actions: Array<Record<string, unknown>>;
    };
    expect(seen).toHaveLength(0);
    expect(result.actions).toHaveLength(2);
    const cancel = result.actions.find((a) => a.operation === 'cancel_booking')!;
    expect(cancel.needs_user_approval).toBe(true);
    expect(cancel.kind).toBe('delete');
    const list = result.actions.find((a) => a.operation === 'list_customers')!;
    expect(list.needs_user_approval).toBe(false);
    // No host, no credential, no path — the model gets what it may ask for and
    // nothing about how the request is built.
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(result)).not.toContain('api.example.com');
  });

  it('says plainly that nothing is configured rather than describing what might be', async () => {
    const result = await run('list_custom_api_actions', {}) as Record<string, unknown>;
    expect(result.actions).toEqual([]);
    expect(String(result.message)).toMatch(/No connected API actions are switched on/);
  });
});
