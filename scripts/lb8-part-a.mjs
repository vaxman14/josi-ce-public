// LB8 Part A — the whole contact-sync path against REAL PostgreSQL.
//
// Runs INSIDE the web container, so it uses the same postgres.js driver, the
// same migrations and the same master key the product uses. That is the entire
// point: the unit suite runs on pglite, and pglite accepts a hand-serialised
// jsonb parameter that postgres.js stores as a string scalar. That difference
// is invisible in tests and permanent in production, and only a run like this
// one can see it.
//
// The provider is stubbed by injecting `fetchImpl`, which is how the unit
// tests already reach it. NOTHING in the product is redirected to do this:
// adding an environment variable that changes where OAuth tokens and contact
// data are sent would be an exfiltration hook shipped to every installation in
// order to make a test convenient. The seam that already exists is used
// instead.
//
// Emits `PASS|message` / `FAIL|message` on stdout; the shell counts them.
import { connectFromEnv } from '/app/packages/core/dist/connect.js';
import { loadMasterKey } from '/app/packages/core/dist/masterKey.js';
import { upsertConnection, setCapability } from '/app/packages/connectors/dist/connections.js';
import { saveClient } from '/app/packages/connectors/dist/oauthClients.js';
import { setSyncMode, syncOrigin } from '/app/packages/connectors/dist/contactSync.js';

const out = [];
const check = (cond, msg) => out.push(`${cond ? 'PASS' : 'FAIL'}|${msg}`);

// ------------------------------------------------------------ the stub provider
//
// Answers as Google People does, keyed by bearer token, so one user's request
// can never be served another user's address book. `deleted` flips to make the
// provider report a removal on the next read.
const BOOKS = {
  'alice-token': [{
    resourceName: 'people/a1', etag: 'e1',
    names: [{ displayName: 'Alice Client' }],
    emailAddresses: [{ value: 'alice-client@example.test' }],
    phoneNumbers: [{ value: '+15550001' }],
  }],
  'bob-token': [{
    resourceName: 'people/b1', etag: 'e1',
    names: [{ displayName: 'Bob Client' }],
    emailAddresses: [{ value: 'bob-client@example.test' }],
  }],
};
let deletedFor = new Set();

const stubFetch = async (url, init) => {
  const token = String(init?.headers?.authorization ?? init?.headers?.Authorization ?? '')
    .replace(/^Bearer /, '');
  const body = deletedFor.has(token)
    ? { connections: [{ resourceName: BOOKS[token]?.[0]?.resourceName, metadata: { deleted: true } }],
        nextSyncToken: `tok-${token}-2` }
    : { connections: BOOKS[token] ?? [], nextSyncToken: `tok-${token}-1` };
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

const { db, close } = await connectFromEnv();
const key = loadMasterKey();

try {
  // ---------------------------------------------------------------- two members
  const users = {};
  for (const name of ['alice', 'bob']) {
    const [row] = await db.query(
      `insert into users (email, username, role, status)
       values ($1, $2, 'member', 'active')
       on conflict (lower(username)) do update set status = 'active'
       returning id`,
      [`lb8-${name}@ce.test`, `lb8-${name}`],
    );
    users[name] = row.id;
  }
  check(users.alice && users.bob && users.alice !== users.bob, 'two members exist');

  // The installation's OAuth application. `syncOrigin` loads it to mint access
  // tokens, so without it every sync fails before it reaches the provider —
  // which is what the first run of this script found.
  await saveClient(db, key, {
    provider: 'google',
    clientId: 'lb8-runtime-client',
    clientSecret: 'lb8-runtime-not-a-real-secret',
    redirectUri: 'https://josi.invalid/api/connections/google/callback',
    actorUserId: users.alice,
  });
  check(true, 'the installation has a registered OAuth application');

  // ------------------------------------------------- a connection and an origin
  const origins = {};
  for (const name of ['alice', 'bob']) {
    const connection = await upsertConnection(db, key, {
      ownerUserId: users[name],
      provider: 'google',
      tokens: {
        accessToken: `${name}-token`,
        refreshToken: `${name}-refresh`,
        expiresIn: 3600,
        grantedScopes: 'https://www.googleapis.com/auth/contacts.readonly',
      },
      accountEmail: `lb8-${name}@example.test`,
      providerAccountId: `acct-${name}`,
      requestedCapabilities: ['google.contacts.read'],
    });
    await setCapability(db, {
      connection, capability: 'google.contacts.read', enabled: true, actorUserId: users[name],
    });
    origins[name] = await setSyncMode(db, {
      connectionId: connection.id, ownerUserId: users[name], mode: 'import_only',
    });
  }
  check(origins.alice.id !== origins.bob.id, 'each member has their own sync origin');

  // ------------------------------------------------------------- the first sync
  const describeOrigin = async (id) => {
    const [row] = await db.query(
      `select status, last_error_category from contact_sync_origins where id = $1`, [id],
    );
    return row ? `${row.status}/${row.last_error_category ?? 'no category'}` : 'missing';
  };

  const first = await syncOrigin(db, origins.alice.id, { masterKey: key, fetchImpl: stubFetch });
  check(first.status !== 'error',
    `alice's first sync did not error (status ${first.status}, origin ${await describeOrigin(origins.alice.id)})`);
  check(first.counts.created === 1, `it created exactly one contact (created=${first.counts.created})`);

  const aliceContacts = await db.query(
    `select id, name, emails, phones from contacts where owner_user_id = $1`, [users.alice],
  );
  check(aliceContacts.length === 1 && aliceContacts[0].name === 'Alice Client',
    'the contact arrived with the name the provider gave');

  // THE DEFECT CLASS THIS WHOLE HARNESS EXISTS FOR. Asked of PostgreSQL
  // itself, not of the value JavaScript happens to hold.
  const [types = {}] = await db.query(
    `select jsonb_typeof(emails) as emails_kind, jsonb_typeof(phones) as phones_kind
     from contacts where owner_user_id = $1`, [users.alice],
  );
  check(types.emails_kind === 'array', `contacts.emails is a jsonb array, not a string (got ${types.emails_kind})`);
  check(types.phones_kind === 'array', `contacts.phones is a jsonb array, not a string (got ${types.phones_kind})`);

  const [emailCheck] = await db.query(
    `select count(*)::int as n from contacts
     where owner_user_id = $1 and emails @> '["alice-client@example.test"]'::jsonb`, [users.alice],
  );
  check(emailCheck.n === 1, 'the address is queryable AS jsonb — a stored string would not match');

  // --------------------------------------------------------------- the cursor
  const [afterFirst] = await db.query(
    `select delta_cursor, status from contact_sync_origins where id = $1`, [origins.alice.id],
  );
  check(Boolean(afterFirst.delta_cursor), `the delta cursor was stored (${afterFirst.delta_cursor})`);

  // ------------------------------------------------------------- idempotence
  const second = await syncOrigin(db, origins.alice.id, { masterKey: key, fetchImpl: stubFetch });
  const aliceAgain = await db.query(
    `select count(*)::int as n from contacts where owner_user_id = $1`, [users.alice],
  );
  check(aliceAgain[0].n === 1,
    `re-syncing the same contact did not duplicate it (${aliceAgain[0].n} row(s), created=${second.counts.created})`);

  // ---------------------------------------------------------------- isolation
  await syncOrigin(db, origins.bob.id, { masterKey: key, fetchImpl: stubFetch });
  const bobContacts = await db.query(
    `select name from contacts where owner_user_id = $1`, [users.bob],
  );
  check(bobContacts.length === 1 && bobContacts[0].name === 'Bob Client',
    'bob received his own contact');
  check(!bobContacts.some((c) => c.name === 'Alice Client'),
    'bob did not receive alice’s contact');
  const crossed = await db.query(
    `select count(*)::int as n from contacts where owner_user_id = $1 and name = 'Bob Client'`,
    [users.alice],
  );
  check(crossed[0].n === 0, 'alice did not receive bob’s contact');

  // ------------------------------------------------ a deletion at the provider
  deletedFor.add('alice-token');
  const third = await syncOrigin(db, origins.alice.id, { masterKey: key, fetchImpl: stubFetch });
  check(third.status !== 'error', `the delete sync did not error (status ${third.status})`);

  const aliceAfterDelete = await db.query(
    `select count(*)::int as n from contacts where owner_user_id = $1`, [users.alice],
  );
  check(aliceAfterDelete[0].n === 0,
    `the contact deleted at the provider is gone locally (${aliceAfterDelete[0].n} left)`);

  const tombstones = await db.query(
    `select count(*)::int as n from contact_tombstones where owner_user_id = $1`, [users.alice],
  );
  check(tombstones[0].n >= 1,
    `a tombstone records the deletion, so a resync cannot resurrect it (${tombstones[0].n})`);

  const bobUntouched = await db.query(
    `select count(*)::int as n from contacts where owner_user_id = $1`, [users.bob],
  );
  check(bobUntouched[0].n === 1, 'alice’s deletion did not touch bob’s contacts');
} catch (err) {
  out.push(`FAIL|Part A threw: ${err?.message ?? err}`);
} finally {
  process.stdout.write(out.join('\n') + '\n');
  await close();
}
