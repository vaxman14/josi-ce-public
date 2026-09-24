// Contact synchronisation, end to end against a real schema.
//
// No provider is contacted anywhere in this file. What IS real: the migrations,
// the connection and capability spine, the master key, and every decision the
// sync engine makes about what an incoming record means.
//
// The cases here are the ones that lose data when they are wrong — a delete
// that comes back, two edits where one is silently discarded, a disconnect that
// takes the contacts with it, and one person's address book reaching another's.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import {
  SyncError, decideApply, dueOrigins, fingerprint, keepSeparate, listOrigins, markAttempted,
  mergeContacts, saveClient, setCapability, setSyncInterval, setSyncMode, stopSync, syncOrigin,
  upsertConnection,
  type ConnectionRow, type LocalContact, type SyncMode,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let bob: string;
const key = new MasterKey(Buffer.alloc(32, 9));
const noSleep = async () => undefined;

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
  for (const provider of ['google', 'microsoft'] as const) {
    await saveClient(db, key, {
      provider,
      clientId: `${provider}-client-id`,
      clientSecret: `${provider}-CLIENT-SECRET-value`,
      redirectUri: `https://josi.example.test/api/connections/${provider}/callback`,
      actorUserId: alice,
    });
  }
});

/** A connected account with the contact capabilities actually granted. */
async function connect(args: {
  user: string;
  provider?: 'google' | 'microsoft';
  email?: string;
  write?: boolean;
}): Promise<ConnectionRow> {
  const provider = args.provider ?? 'google';
  const caps = provider === 'google'
    ? ['google.contacts.read', ...(args.write ? ['google.contacts.write'] : [])]
    : ['microsoft.contacts.read', ...(args.write ? ['microsoft.contacts.write'] : [])];

  const connection = await upsertConnection(db, key, {
    ownerUserId: args.user,
    provider,
    tokens: {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      // What the provider says it actually granted — which is what
      // `setCapability` checks before it will enable anything.
      grantedScopes: caps
        .map((c) => (c.endsWith('.write')
          ? (provider === 'google' ? 'https://www.googleapis.com/auth/contacts' : 'Contacts.ReadWrite')
          : (provider === 'google' ? 'https://www.googleapis.com/auth/contacts.readonly' : 'Contacts.Read')))
        .join(' '),
    },
    accountEmail: args.email ?? `${args.user.slice(0, 6)}@${provider}.test`,
    providerAccountId: `acct-${args.user.slice(0, 6)}-${provider}`,
    requestedCapabilities: caps,
  });
  for (const capability of caps) {
    await setCapability(db, { connection, capability, enabled: true, actorUserId: args.user });
  }
  return connection;
}

async function startSync(connection: ConnectionRow, mode: SyncMode = 'import_only') {
  return setSyncMode(db, { connectionId: connection.id, ownerUserId: connection.owner_user_id, mode });
}

/** A Google People page, as the API returns one. */
const googlePage = (people: Array<Record<string, unknown>>, syncToken = 'tok-1') =>
  new Response(JSON.stringify({ connections: people, nextSyncToken: syncToken }), { status: 200 });

const person = (over: Record<string, unknown> = {}) => ({
  resourceName: 'people/c1',
  etag: 'etag-1',
  metadata: { sources: [{ updateTime: '2026-08-01T10:00:00Z' }] },
  names: [{ displayName: 'Alice Example' }],
  emailAddresses: [{ value: 'alice@example.test' }],
  phoneNumbers: [{ value: '+442079460958' }],
  ...over,
});

/** Answers token refreshes and contact reads; everything else is a failure. */
function provider(pages: Response[] | ((url: string) => Response)) {
  let index = 0;
  const fetchImpl: typeof fetch = async (url) => {
    const target = String(url);
    if (target.includes('oauth2') || target.includes('token')) {
      return new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 });
    }
    if (typeof pages === 'function') return pages(target);
    // Cloned, never handed out directly: a Response body can be read once, and
    // a suite that reuses one across two sync runs silently feeds the second
    // run an empty page — which reads exactly like "the provider had nothing".
    return pages[Math.min(index++, pages.length - 1)].clone();
  };
  return fetchImpl;
}

const contactsOf = (user: string) =>
  db.query<LocalContact>(
    `select id, owner_user_id, name, email, phone, emails, phones, source, source_account,
            conflict_state, updated_at, synced_at
     from contacts where owner_user_id = $1 order by name`,
    [user],
  );

// ------------------------------------------------------------ the decision

describe('what an incoming record means', () => {
  const remote = (over: Record<string, unknown> = {}) => ({
    sourceId: 'people/c1', displayName: 'Alice', emails: ['a@example.test'], phones: [],
    etag: 'e1', updatedAt: null, deleted: false, ...over,
  });
  const local = (over: Partial<LocalContact> = {}): LocalContact => ({
    id: 'local-1', owner_user_id: alice, name: 'Alice', email: 'a@example.test', phone: null,
    emails: ['a@example.test'], phones: [], source: 'google', source_account: 'a@google.test',
    conflict_state: null, updated_at: '2026-08-01T00:00:00Z', synced_at: null, ...over,
  });

  it('creates something new', () => {
    expect(decideApply({
      remote: remote(), linked: null, lastRemoteFingerprint: null, lastLocalFingerprint: null, tombstoned: false,
    }).action).toBe('created');
  });

  it('does NOT resurrect something that was deleted here', () => {
    // The commonest contact-sync bug there is: the cursor expires, the
    // provider re-sends everything, and every delete is undone.
    expect(decideApply({
      remote: remote(), linked: null, lastRemoteFingerprint: null, lastLocalFingerprint: null, tombstoned: true,
    }).action).toBe('skipped_tombstoned');
  });

  it('leaves alone what already agrees', () => {
    const l = local();
    expect(decideApply({
      remote: remote(),
      linked: l,
      lastRemoteFingerprint: fingerprint({ displayName: l.name, emails: l.emails, phones: l.phones }),
      lastLocalFingerprint: fingerprint({ displayName: l.name, emails: l.emails, phones: l.phones }),
      tombstoned: false,
    }).action).toBe('unchanged');
  });

  it('takes a remote-only change', () => {
    const agreed = fingerprint({ displayName: 'Alice', emails: ['a@example.test'], phones: [] });
    expect(decideApply({
      remote: remote({ displayName: 'Alice Renamed' }),
      linked: local(),
      lastRemoteFingerprint: agreed,
      lastLocalFingerprint: agreed,
      tombstoned: false,
    }).action).toBe('updated');
  });

  it('leaves a local-only change for the push pass', () => {
    const agreedRemote = fingerprint({ displayName: 'Alice', emails: ['a@example.test'], phones: [] });
    expect(decideApply({
      remote: remote(),
      linked: local({ name: 'Alice Edited Here' }),
      lastRemoteFingerprint: agreedRemote,
      lastLocalFingerprint: agreedRemote,
      tombstoned: false,
    }).action).toBe('unchanged');
  });

  it('calls both sides moving a conflict, and writes nothing', () => {
    // Last-write-wins is the easy answer and it silently discards whichever
    // edit was slower.
    const agreed = fingerprint({ displayName: 'Alice', emails: ['a@example.test'], phones: [] });
    const decision = decideApply({
      remote: remote({ displayName: 'Alice From Google' }),
      linked: local({ name: 'Alice From Josi' }),
      lastRemoteFingerprint: agreed,
      lastLocalFingerprint: agreed,
      tombstoned: false,
    });
    expect(decision.action).toBe('conflict');
    expect(decision.reason).toMatch(/nothing was overwritten/i);
  });

  it('applies a delete it can act on, and ignores one it cannot', () => {
    expect(decideApply({
      remote: remote({ deleted: true }), linked: local(),
      lastRemoteFingerprint: null, lastLocalFingerprint: null, tombstoned: false,
    }).action).toBe('deleted');

    expect(decideApply({
      remote: remote({ deleted: true }), linked: null,
      lastRemoteFingerprint: null, lastLocalFingerprint: null, tombstoned: false,
    }).action).toBe('delete_ignored_tombstoned');
  });
});

describe('the fingerprint', () => {
  it('ignores ordering and case, so a provider reshuffle is not a change', () => {
    expect(fingerprint({ displayName: 'Alice', emails: ['B@x.test', 'a@x.test'], phones: [] }))
      .toBe(fingerprint({ displayName: 'alice', emails: ['a@x.test', 'b@x.test'], phones: [] }));
  });

  it('notices a real change', () => {
    expect(fingerprint({ displayName: 'Alice', emails: [], phones: [] }))
      .not.toBe(fingerprint({ displayName: 'Alice', emails: ['a@x.test'], phones: [] }));
  });
});

// ------------------------------------------------------------- import a set

describe('importing', () => {
  it('brings contacts in, records where they came from, and stores the cursor', async () => {
    const connection = await connect({ user: alice, email: 'alice@gmail.test' });
    const origin = await startSync(connection);

    const result = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([person(), person({ resourceName: 'people/c2', names: [{ displayName: 'Bob Other' }], emailAddresses: [{ value: 'bob@example.test' }] })])]),
    });

    expect(result.counts.created).toBe(2);
    expect(result.status).toBe('idle');

    const contacts = await contactsOf(alice);
    expect(contacts).toHaveLength(2);
    // LB8.7: provenance is ON the contact.
    expect(contacts[0].source).toBe('google');
    expect(contacts[0].source_account).toBe('alice@gmail.test');
    expect(contacts[0].synced_at).toBeTruthy();

    const [after] = await listOrigins(db, alice);
    expect(after.delta_cursor).toBe('tok-1');
    expect(after.last_sync_at).toBeTruthy();
    expect(after.status).toBe('idle');
  });

  it('is idempotent — running twice creates nothing twice', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    const opts = { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) };

    await syncOrigin(db, origin.id, opts);
    const second = await syncOrigin(db, origin.id, opts);

    expect(second.counts.created).toBe(0);
    expect(second.counts.unchanged).toBe(1);
    expect(await contactsOf(alice)).toHaveLength(1);
  });

  it('follows pages, and only advances the cursor at the end', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);

    const pages = [
      new Response(JSON.stringify({ connections: [person()], nextPageToken: 'page-2' }), { status: 200 }),
      new Response(JSON.stringify({
        connections: [person({ resourceName: 'people/c2', names: [{ displayName: 'Second Page' }] })],
        nextSyncToken: 'final-token',
      }), { status: 200 }),
    ];
    const result = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider(pages) });

    expect(result.counts.created).toBe(2);
    const [after] = await listOrigins(db, alice);
    // The delta cursor arrives on the last page only. Advancing it earlier
    // skips whatever is still unread, permanently and silently.
    expect(after.delta_cursor).toBe('final-token');
    expect(after.page_cursor).toBeNull();
  });

  it('re-reads everything when the provider says its cursor aged out', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });

    let asked = 0;
    const fetchImpl = provider((url) => {
      if (url.includes('token') && !url.includes('people')) {
        return new Response(JSON.stringify({ access_token: 'f', expires_in: 3600 }), { status: 200 });
      }
      asked++;
      if (asked === 1) return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), { status: 410 });
      return googlePage([person()], 'tok-2');
    });

    const result = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl });
    expect(result.wasFullResync).toBe(true);
    expect(result.status).toBe('idle');
    // A full re-read is not a reason to duplicate everything.
    expect(await contactsOf(alice)).toHaveLength(1);
  });

  it('retries a rate limit and gives up on a revoked grant', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);

    let attempts = 0;
    const retrying = provider((url) => {
      if (!url.includes('people')) return new Response(JSON.stringify({ access_token: 'f', expires_in: 3600 }), { status: 200 });
      attempts++;
      return attempts === 1 ? new Response('{}', { status: 429 }) : googlePage([person()]);
    });
    const ok = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: retrying });
    expect(attempts).toBe(2);
    expect(ok.counts.created).toBe(1);

    let scopeAttempts = 0;
    const refusing = provider((url) => {
      if (!url.includes('people')) return new Response(JSON.stringify({ access_token: 'f', expires_in: 3600 }), { status: 200 });
      scopeAttempts++;
      return new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 });
    });
    const failed = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: refusing });
    expect(failed.status).toBe('error');
    // Retrying a missing scope just delays telling the user to reconnect.
    expect(scopeAttempts).toBe(1);
  });
});

// ------------------------------------------------------------- the dangerous

describe('deletion', () => {
  it('applies a remote delete, and remembers it', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    expect(await contactsOf(alice)).toHaveLength(1);

    const deleted = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([{ resourceName: 'people/c1', metadata: { deleted: true } }], 'tok-2')]),
    });
    expect(deleted.counts.deleted).toBe(1);
    expect(await contactsOf(alice)).toHaveLength(0);

    const tombstones = await db.query(`select source_id from contact_tombstones where owner_user_id = $1`, [alice]);
    expect(tombstones).toHaveLength(1);
  });

  it('does not bring a deleted contact back on the next full resync', async () => {
    // The whole reason tombstones exist. Providers expire cursors routinely,
    // so a full resync is a normal event — and without this, every delete is
    // undone within a week and the user deletes it again.
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([{ resourceName: 'people/c1', metadata: { deleted: true } }], 'tok-2')]),
    });

    // Cursor forgotten; the provider sends everything it has, including the
    // record that was deleted.
    await db.query(`update contact_sync_origins set delta_cursor = null where id = $1`, [origin.id]);
    const resync = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()], 'tok-3')]),
    });

    expect(resync.counts.skipped).toBe(1);
    expect(resync.counts.created).toBe(0);
    expect(await contactsOf(alice)).toHaveLength(0);
  });

  it('keeps a contact that another account still syncs', async () => {
    // Deleted at Google, still in Outlook. Removing it here would be deleting
    // data the user still has.
    const google = await connect({ user: alice, provider: 'google' });
    const microsoft = await connect({ user: alice, provider: 'microsoft' });
    const gOrigin = await startSync(google);
    const mOrigin = await startSync(microsoft);

    await syncOrigin(db, gOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    const [existing] = await contactsOf(alice);

    // Link the same contact to the Microsoft origin, as a merge would.
    await db.query(
      `insert into contact_links (origin_id, contact_id, owner_user_id, source_id, remote_fingerprint, local_fingerprint)
       values ($1, $2, $3, 'AAMkAD', 'x', 'x')`,
      [mOrigin.id, existing.id, alice],
    );

    await syncOrigin(db, gOrigin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([{ resourceName: 'people/c1', metadata: { deleted: true } }], 'tok-2')]),
    });

    expect(await contactsOf(alice), 'still held by the other account').toHaveLength(1);
  });
});

describe('conflicts', () => {
  it('flags a contact both sides changed, and overwrites nothing', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });

    // Edited here.
    const [local] = await contactsOf(alice);
    await db.query(`update contacts set name = 'Edited In Josi' where id = $1`, [local.id]);

    // And edited there.
    const result = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([person({ names: [{ displayName: 'Edited At Google' }] })], 'tok-2')]),
    });

    expect(result.counts.conflicts).toBe(1);
    const [after] = await contactsOf(alice);
    expect(after.conflict_state).toBe('both_changed');
    // The local edit survives untouched. Neither side wins by being slower.
    expect(after.name).toBe('Edited In Josi');
  });
});

// --------------------------------------------------------------- isolation

describe('two people on one installation', () => {
  it('sync separate address books that never meet', async () => {
    const aliceConn = await connect({ user: alice, email: 'alice@gmail.test' });
    const bobConn = await connect({ user: bob, email: 'bob@gmail.test' });
    const aliceOrigin = await startSync(aliceConn);
    const bobOrigin = await startSync(bobConn);

    await syncOrigin(db, aliceOrigin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([person({ names: [{ displayName: "Alice's Client" }], emailAddresses: [{ value: 'client-a@example.test' }] })])]),
    });
    await syncOrigin(db, bobOrigin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([googlePage([person({ resourceName: 'people/b1', names: [{ displayName: "Bob's Client" }], emailAddresses: [{ value: 'client-b@example.test' }] })])]),
    });

    const aliceContacts = await contactsOf(alice);
    const bobContacts = await contactsOf(bob);
    expect(aliceContacts).toHaveLength(1);
    expect(bobContacts).toHaveLength(1);
    expect(aliceContacts[0].name).toBe("Alice's Client");
    expect(bobContacts[0].name).toBe("Bob's Client");

    // Nothing of one appears in the other, in any column.
    expect(JSON.stringify(aliceContacts)).not.toContain('client-b@example.test');
    expect(JSON.stringify(bobContacts)).not.toContain('client-a@example.test');

    // And neither can see the other's origin.
    expect((await listOrigins(db, alice)).map((o) => o.id)).toEqual([aliceOrigin.id]);
    expect((await listOrigins(db, bob)).map((o) => o.id)).toEqual([bobOrigin.id]);
  });

  it('does not propose merging one person’s contact with another’s', async () => {
    // The same client, in both address books. They are two records belonging
    // to two people and must never be offered as a duplicate pair.
    const aliceConn = await connect({ user: alice });
    const bobConn = await connect({ user: bob });
    const aliceOrigin = await startSync(aliceConn);
    const bobOrigin = await startSync(bobConn);

    const shared = [person({ emailAddresses: [{ value: 'shared@example.test' }] })];
    await syncOrigin(db, aliceOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage(shared)]) });
    const bobResult = await syncOrigin(db, bobOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage(shared)]) });

    expect(bobResult.needsReview).toEqual([]);
  });

  it('refuses to change a sync mode on somebody else’s connection', async () => {
    const bobConn = await connect({ user: bob });
    await expect(
      setSyncMode(db, { connectionId: bobConn.id, ownerUserId: alice, mode: 'import_only' }),
    ).rejects.toBeInstanceOf(SyncError);
  });

  it('refuses to merge across owners', async () => {
    const aliceConn = await connect({ user: alice });
    const bobConn = await connect({ user: bob });
    await syncOrigin(db, (await startSync(aliceConn)).id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]),
    });
    await syncOrigin(db, (await startSync(bobConn)).id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]),
    });
    const [a] = await contactsOf(alice);
    const [b] = await contactsOf(bob);

    await expect(
      mergeContacts(db, { ownerUserId: alice, keepId: a.id, mergeId: b.id }),
    ).rejects.toBeInstanceOf(SyncError);
    expect(await contactsOf(bob), "bob's contact survives").toHaveLength(1);
  });
});

// -------------------------------------------------------------- consent

describe('least privilege', () => {
  it('refuses two-way without the write permission actually granted', async () => {
    const connection = await connect({ user: alice, write: false });
    await expect(
      setSyncMode(db, { connectionId: connection.id, ownerUserId: alice, mode: 'two_way' }),
    ).rejects.toMatchObject({ category: 'insufficient_scope' });
  });

  it('allows two-way once it has been', async () => {
    const connection = await connect({ user: alice, write: true });
    const origin = await setSyncMode(db, { connectionId: connection.id, ownerUserId: alice, mode: 'two_way' });
    expect(origin.sync_mode).toBe('two_way');
  });

  it('stops a running sync when the permission is taken away', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await db.query(
      `update connection_capabilities set enabled = false where connection_id = $1`,
      [connection.id],
    );
    const result = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    expect(result.status).toBe('error');
    expect(await contactsOf(alice)).toHaveLength(0);
  });
});

// ------------------------------------------------------ revoke and reconnect

describe('disconnecting', () => {
  it('stops sync and deletes nothing', async () => {
    // LB8.9. Disconnecting a source is not consent to lose what it brought,
    // and it is certainly not consent to delete anything at the provider.
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });

    const stopped = await stopSync(db, { originId: origin.id, ownerUserId: alice });
    expect(stopped.contactsKept).toBe(1);
    expect(await contactsOf(alice)).toHaveLength(1);

    const [after] = await listOrigins(db, alice);
    expect(after.status).toBe('disconnected');
    expect(after.delta_cursor).toBeNull();
  });

  it('does nothing further once disconnected, even if asked', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await stopSync(db, { originId: origin.id, ownerUserId: alice });

    let called = 0;
    const result = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: async () => { called++; return googlePage([person()]); },
    });
    expect(result.status).toBe('disconnected');
    expect(called, 'a disconnected origin contacts nobody').toBe(0);
  });

  it('marks the origin disconnected when the connection itself is revoked', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await db.query(`update connections set status = 'revoked' where id = $1`, [connection.id]);

    const result = await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    expect(result.status).toBe('disconnected');
    expect(await contactsOf(alice), 'nothing is deleted by a revocation').toHaveLength(0);
  });

  it('resumes on reconnect without re-importing', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });
    await stopSync(db, { originId: origin.id, ownerUserId: alice });

    // Reconnecting is choosing the mode again.
    await setSyncMode(db, { connectionId: connection.id, ownerUserId: alice, mode: 'import_only' });
    const again = await syncOrigin(db, origin.id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()], 'tok-9')]),
    });

    // The links survived, so the same person is recognised rather than
    // imported a second time.
    expect(again.counts.created).toBe(0);
    expect(await contactsOf(alice)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- schedule

describe('syncing on a schedule', () => {
  it('offers a new origin for sync straight away', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    const due = await dueOrigins(db);
    expect(due.map((o) => o.id)).toEqual([origin.id]);
  });

  it('does not offer it again until its own interval has elapsed', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await markAttempted(db, origin.id);
    expect(await dueOrigins(db)).toEqual([]);

    // Far enough back that the default fifteen minutes has passed.
    await db.query(
      `update contact_sync_origins set last_attempt_at = now() - interval '20 minutes' where id = $1`,
      [origin.id],
    );
    expect((await dueOrigins(db)).map((o) => o.id)).toEqual([origin.id]);
  });

  it('paces a FAILING origin on its interval too', async () => {
    // The pacing is by attempt, not by success. Using `last_sync_at` would mean
    // an account whose provider is down being retried on every tick, which is
    // how an installation gets rate-limited into a hole.
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await db.query(`update contact_sync_origins set status = 'error' where id = $1`, [origin.id]);

    expect((await dueOrigins(db)).map((o) => o.id), 'an errored origin is retried').toEqual([origin.id]);
    await markAttempted(db, origin.id);
    expect(await dueOrigins(db), 'but not until its interval elapses').toEqual([]);
  });

  it('leaves a paused or disconnected origin alone entirely', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    for (const status of ['paused', 'disconnected'] as const) {
      await db.query(`update contact_sync_origins set status = $2, last_attempt_at = null where id = $1`,
        [origin.id, status]);
      expect(await dueOrigins(db), status).toEqual([]);
    }
  });

  it('lets each account be paced separately', async () => {
    const google = await startSync(await connect({ user: alice, provider: 'google' }));
    const microsoft = await startSync(await connect({ user: alice, provider: 'microsoft' }));

    await setSyncInterval(db, { originId: google.id, ownerUserId: alice, seconds: 300 });
    await markAttempted(db, google.id);
    await markAttempted(db, microsoft.id);
    await db.query(`update contact_sync_origins set last_attempt_at = now() - interval '6 minutes'`);

    // Google's five minutes has elapsed; Microsoft's fifteen has not.
    expect((await dueOrigins(db)).map((o) => o.id)).toEqual([google.id]);
  });

  it('refuses an interval that would hammer a provider, or one nobody wants', async () => {
    const origin = await startSync(await connect({ user: alice }));
    for (const seconds of [0, 60, 299, 86_401, 1.5]) {
      await expect(
        setSyncInterval(db, { originId: origin.id, ownerUserId: alice, seconds }),
        String(seconds),
      ).rejects.toBeInstanceOf(SyncError);
    }
  });

  it('refuses to pace somebody else’s account', async () => {
    const origin = await startSync(await connect({ user: bob }));
    await expect(
      setSyncInterval(db, { originId: origin.id, ownerUserId: alice, seconds: 600 }),
    ).rejects.toBeInstanceOf(SyncError);
  });
});

// --------------------------------------------------------------- duplicates

describe('duplicates', () => {
  it('suggests a cross-provider match and merges nothing on its own', async () => {
    const google = await connect({ user: alice, provider: 'google' });
    const microsoft = await connect({ user: alice, provider: 'microsoft' });
    await syncOrigin(db, (await startSync(google)).id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]),
    });

    const mOrigin = await startSync(microsoft);
    const graphPage = new Response(JSON.stringify({
      value: [{
        id: 'AAMkAD', displayName: 'Alice Example',
        emailAddresses: [{ address: 'alice@example.test' }], businessPhones: [],
      }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=d1',
    }), { status: 200 });

    const result = await syncOrigin(db, mOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([graphPage]) });

    expect(result.counts.created).toBe(1);
    expect(await contactsOf(alice), 'both kept until somebody decides').toHaveLength(2);
    expect(result.needsReview).toHaveLength(1);
    expect(result.needsReview[0].confidence).toBe('strong');
  });

  it('stops suggesting a pair the user has said no to', async () => {
    const google = await connect({ user: alice, provider: 'google' });
    const microsoft = await connect({ user: alice, provider: 'microsoft' });
    await syncOrigin(db, (await startSync(google)).id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]),
    });
    const mOrigin = await startSync(microsoft);
    const graphPage = () => new Response(JSON.stringify({
      value: [{ id: 'AAMkAD', displayName: 'Alice Example', emailAddresses: [{ address: 'alice@example.test' }] }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=d1',
    }), { status: 200 });

    const first = await syncOrigin(db, mOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([graphPage()]) });
    const pair = first.needsReview[0];
    await keepSeparate(db, { ownerUserId: alice, contactA: pair.left, contactB: pair.right });

    await db.query(`update contact_sync_origins set delta_cursor = null where id = $1`, [mOrigin.id]);
    const second = await syncOrigin(db, mOrigin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([graphPage()]) });
    // A rejected merge re-proposed forever is how people learn to click
    // through the dialog.
    expect(second.needsReview).toEqual([]);
  });

  it('merges on request, keeping both links so both accounts keep syncing', async () => {
    const google = await connect({ user: alice, provider: 'google' });
    const microsoft = await connect({ user: alice, provider: 'microsoft' });
    await syncOrigin(db, (await startSync(google)).id, {
      masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]),
    });
    await syncOrigin(db, (await startSync(microsoft)).id, {
      masterKey: key, sleep: noSleep,
      fetchImpl: provider([new Response(JSON.stringify({
        value: [{ id: 'AAMkAD', displayName: 'Alice Example', emailAddresses: [{ address: 'alice@work.test' }] }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=d1',
      }), { status: 200 })]),
    });

    const [keep, merge] = await contactsOf(alice);
    await mergeContacts(db, { ownerUserId: alice, keepId: keep.id, mergeId: merge.id });

    const after = await contactsOf(alice);
    expect(after).toHaveLength(1);
    // Both addresses survive the merge.
    expect(after[0].emails.sort()).toEqual(['alice@example.test', 'alice@work.test']);
    // And both providers still point at the survivor.
    const links = await db.query<{ origin_id: string }>(
      `select origin_id from contact_links where contact_id = $1`, [after[0].id],
    );
    expect(links).toHaveLength(2);
  });
});

// -------------------------------------------------------------------- audit

describe('what gets recorded', () => {
  it('audits counts and never a name, an address or a number', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });

    const events = JSON.stringify(await db.query(`select kind, payload from events`));
    expect(events).toContain('contacts.synced');
    for (const content of ['Alice Example', 'alice@example.test', '442079460958', 'people/c1']) {
      expect(events, content).not.toContain(content);
    }
  });

  it('stores no provider token in any contact table', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await syncOrigin(db, origin.id, { masterKey: key, sleep: noSleep, fetchImpl: provider([googlePage([person()])]) });

    const dump = JSON.stringify([
      await db.query(`select * from contacts`),
      await db.query(`select * from contact_links`),
      await db.query(`select * from contact_sync_origins`),
    ]);
    for (const secret of ['access-token', 'refresh-token', 'fresh', 'google-CLIENT-SECRET-value']) {
      expect(dump, secret).not.toContain(secret);
    }
  });
});

describe('automatic synchronization regression coverage', () => {
  it('automatically enrolls enabled contact reads and preserves explicit stop', async () => {
    const connection = await connect({ user: alice });
    const due = await dueOrigins(db);
    expect(due).toHaveLength(1);
    const [origin] = await listOrigins(db, alice);
    expect(origin.connection_id).toBe(connection.id);
    expect(origin.sync_mode).toBe('import_only');
    await stopSync(db, { originId: origin.id, ownerUserId: alice });
    expect(await dueOrigins(db)).toHaveLength(0);
  });

  it('does not borrow enabled permission from another connected account', async () => {
    const connection = await connect({ user: alice });
    const origin = await startSync(connection);
    await setCapability(db, { connection, capability: 'google.contacts.read', enabled: false, actorUserId: alice });
    const second = await upsertConnection(db, key, { ownerUserId: alice, provider: 'google',
      tokens: { accessToken: 'other', refreshToken: 'other-refresh', expiresIn: 3600,
        grantedScopes: 'https://www.googleapis.com/auth/contacts.readonly' },
      accountEmail: 'second@example.test', providerAccountId: 'second-account', requestedCapabilities: ['google.contacts.read'] });
    await setCapability(db, { connection: second, capability: 'google.contacts.read', enabled: true, actorUserId: alice });
    const result = await syncOrigin(db, origin.id, { masterKey: key, fetchImpl: async () => { throw new Error('must not request'); } });
    expect(result.status).toBe('error');
    expect((await listOrigins(db, alice))[0].last_error_category).toBe('insufficient_scope');
  });

  it('retains the agreement baseline when local-only edits are encountered repeatedly', async () => {
    const origin = await startSync(await connect({ user: alice }));
    await syncOrigin(db, origin.id, { masterKey: key, fetchImpl: provider([googlePage([person()])]) });
    await db.query(`update contacts set name='Local edit' where owner_user_id=$1`, [alice]);
    await syncOrigin(db, origin.id, { masterKey: key, fetchImpl: provider([googlePage([person()])]) });
    await syncOrigin(db, origin.id, { masterKey: key, fetchImpl: provider([googlePage([person({ names: [{ displayName: 'Remote edit' }] })])]) });
    const [row] = await db.query<{name: string; conflict_state: string}>(`select name, conflict_state from contacts where owner_user_id=$1`, [alice]);
    expect(row.name).toBe('Local edit');
    expect(row.conflict_state).toBe('both_changed');
  });

  it('retains a bounded page checkpoint instead of publishing partial success', async () => {
    const origin = await startSync(await connect({ user: alice }));
    await syncOrigin(db, origin.id, { masterKey: key, maxPages: 1,
      fetchImpl: provider([new Response(JSON.stringify({connections:[person()], nextPageToken:'next-page'}))]) });
    const [row] = await listOrigins(db, alice);
    expect(row.page_cursor).toBe('next-page');
    expect(row.last_sync_at).toBeNull();
    await syncOrigin(db, origin.id, { masterKey: key, fetchImpl: provider([googlePage([])]) });
    expect((await listOrigins(db, alice))[0].page_cursor).toBeNull();
  });
});

it('recovers an abandoned sync claim while preserving its checkpoint', async () => {
  const origin = await startSync(await connect({ user: alice }));
  await db.exec(`alter table contact_sync_origins disable trigger contact_sync_origins_touch`);
  await db.query(`update contact_sync_origins set status='syncing', page_cursor='resume', updated_at=now()-interval '4 hours' where id=$1`, [origin.id]);
  await db.exec(`alter table contact_sync_origins enable trigger contact_sync_origins_touch`);
  expect(await dueOrigins(db)).toHaveLength(1);
  expect((await listOrigins(db, alice))[0].page_cursor).toBe('resume');
});

it('preserves locally edited contacts when the provider deletes them', async () => {
  const origin = await startSync(await connect({ user: alice }));
  await syncOrigin(db, origin.id, { masterKey:key, fetchImpl:provider([googlePage([person()])]) });
  await db.query(`update contacts set name='Keep my edit' where owner_user_id=$1`, [alice]);
  const result = await syncOrigin(db, origin.id, { masterKey:key, fetchImpl:provider([googlePage([person({metadata:{deleted:true}})])]) });
  expect(result.counts.conflicts).toBe(1);
  const [row] = await db.query<{name:string}>(`select name from contacts where owner_user_id=$1`, [alice]);
  expect(row.name).toBe('Keep my edit');
});

it('honors provider Retry-After during automatic sync without logging response bodies', async () => {
  const origin = await startSync(await connect({ user: alice }));
  const waits: number[] = [];
  const result = await syncOrigin(db, origin.id, {masterKey:key, sleep:async ms=>{waits.push(ms);},
    fetchImpl:provider([new Response('{}',{status:429,headers:{'Retry-After':'17'}}),googlePage([])])});
  expect(result.status).toBe('idle');
  expect(waits).toEqual([17000]);
});

it('preserves user-authored notes when the provider deletes an otherwise unchanged contact', async () => {
  const origin = await startSync(await connect({ user: alice }));
  await syncOrigin(db, origin.id, { masterKey:key, fetchImpl:provider([googlePage([person()])]) });
  await db.query(`update contacts set notes='{"text":"User-authored private note"}' where owner_user_id=$1`, [alice]);
  const result = await syncOrigin(db, origin.id, { masterKey:key, fetchImpl:provider([googlePage([person({metadata:{deleted:true}})])]) });
  expect(result.counts.conflicts).toBe(1);
  const [row] = await db.query<{notes:string}>(`select notes from contacts where owner_user_id=$1`, [alice]);
  expect(row.notes).toEqual({text:'User-authored private note'});
});
