// The OAuth handshake and the stored connection.
//
// No provider is contacted anywhere in this file: `fetchImpl` is injected and
// returns whatever the test says. That is a standing constraint for this
// project, and it is also the only way to exercise what happens when a provider
// misbehaves.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, looksSealed, openSealed } from '@josi-ce/core';
import {
  ConnectorError, accessTokenFor, buildAuthUrl, can, capabilityViews, createPkcePair,
  createStateStore, deleteConnection, exchangeCode, fetchIdentity, loadClient, markUnhealthy,
  refreshTokens, revokeAtProvider, safeReturnPath, saveClient, setCapability, upsertConnection,
  clientStatuses, connectionFor, NoClientError, CapabilityError,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let bob: string;
const key = new MasterKey(Buffer.alloc(32, 9));

// Real session ids are uuids (sessions.id), and the column is typed to match —
// so the tests use uuids rather than loosening the column to accept anything.
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

const CLIENT = {
  provider: 'google' as const,
  clientId: 'client-id-not-secret',
  clientSecret: 'THE-CLIENT-SECRET-value',
  redirectUri: 'https://josi.example.test/api/connections/google/callback',
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
});

// ---------------------------------------------------------- operator client

describe("the operator's own OAuth application", () => {
  it('seals the client secret and never hands it back', async () => {
    await saveClient(db, key, { ...CLIENT, actorUserId: alice });

    const [row] = await db.query<{ client_secret_enc: string }>(
      `select client_secret_enc from oauth_clients where provider = 'google'`,
    );
    expect(looksSealed(row.client_secret_enc)).toBe(true);
    expect(row.client_secret_enc).not.toContain(CLIENT.clientSecret);

    const statuses = JSON.stringify(await clientStatuses(db));
    expect(statuses).not.toContain(CLIENT.clientSecret);
    // The client id travels in the authorize URL, so it is not a secret.
    expect(statuses).toContain(CLIENT.clientId);

    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain(CLIENT.clientSecret);
    expect(events).not.toContain(CLIENT.clientId);
  });

  it('refuses to start a handshake with no application configured', async () => {
    await expect(loadClient(db, key, 'google')).rejects.toThrow(NoClientError);
  });

  it('opens the secret only through the master key', async () => {
    await saveClient(db, key, { ...CLIENT, actorUserId: alice });
    const opened = await loadClient(db, key, 'google');
    expect(opened.clientSecret).toBe(CLIENT.clientSecret);

    const wrongKey = new MasterKey(Buffer.alloc(32, 1));
    await expect(loadClient(db, wrongKey, 'google')).rejects.toThrow();
  });
});

// ------------------------------------------------------------ the handshake

describe('the handshake', () => {
  const start = (over: Record<string, unknown> = {}) =>
    createStateStore(db, key).start({
      userId: alice, sessionId: SESSION, provider: 'google',
      capabilities: ['google.calendar.read'], scopes: 'a b', ...over,
    });

  it('is single use — a replay is refused', async () => {
    const store = createStateStore(db, key);
    const { state } = await start();

    const first = await store.consume({ state, provider: 'google', sessionId: SESSION });
    expect(first.ok).toBe(true);

    const replay = await store.consume({ state, provider: 'google', sessionId: SESSION });
    expect(replay).toEqual({ ok: false, reason: 'consumed' });
  });

  it('cannot be redeemed at the other provider callback', async () => {
    const store = createStateStore(db, key);
    const { state } = await start();
    expect(await store.consume({ state, provider: 'microsoft', sessionId: SESSION }))
      .toEqual({ ok: false, reason: 'wrong_provider' });
  });

  it('cannot be redeemed from a different session', async () => {
    // CE has one origin, so the cookie is present at the callback and this is
    // enforced rather than best-effort. A leaked state is not enough.
    const store = createStateStore(db, key);
    const { state } = await start();
    expect(await store.consume({ state, provider: 'google', sessionId: OTHER_SESSION }))
      .toEqual({ ok: false, reason: 'session_mismatch' });
  });

  it('expires', async () => {
    const store = createStateStore(db, key);
    const { state } = await start({ ttlSeconds: 1 });
    await db.query(`update oauth_states set expires_at = now() - interval '1 minute'`);
    expect(await store.consume({ state, provider: 'google', sessionId: SESSION }))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a forged state', async () => {
    const store = createStateStore(db, key);
    expect(await store.consume({ state: 'made-up', provider: 'google' }))
      .toEqual({ ok: false, reason: 'unknown' });
    expect(await store.consume({ state: '', provider: 'google' }))
      .toEqual({ ok: false, reason: 'unknown' });
  });

  it('returns the stored user, not anything a caller supplied', async () => {
    const store = createStateStore(db, key);
    const { state } = await start({ userId: bob, sessionId: null });
    const result = await store.consume({ state, provider: 'google', sessionId: OTHER_SESSION });
    expect(result.ok && result.handshake.userId).toBe(bob);
  });

  it('seals the PKCE verifier at rest', async () => {
    await start();
    const [row] = await db.query<{ verifier_enc: string }>(`select verifier_enc from oauth_states`);
    expect(looksSealed(row.verifier_enc)).toBe(true);
    expect(openSealed<{ verifier: string }>(key, row.verifier_enc).verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('produces a valid S256 pair', async () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('purges what is spent', async () => {
    const store = createStateStore(db, key);
    const { state } = await start();
    await store.consume({ state, provider: 'google', sessionId: SESSION });
    await db.query(`update oauth_states set consumed_at = now() - interval '2 hours'`);
    expect(await store.purge(3600)).toBe(1);
  });

  it('refuses to redirect anywhere but inside the app', async () => {
    // A callback that will redirect anywhere is an open redirect with extra
    // steps.
    for (const bad of ['https://evil.test', '//evil.test', '/\\evil', '/a\nb', 'javascript:alert(1)']) {
      expect(safeReturnPath(bad), bad).toBe('/app/connections');
    }
    expect(safeReturnPath('/app/settings')).toBe('/app/settings');
  });
});

describe('the authorize URL', () => {
  it('asks for offline access and forces consent on google', () => {
    const url = new URL(buildAuthUrl(CLIENT, { state: 'S', scopes: 'x y', codeChallenge: 'C' }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    // Incremental authorization: a second consent must not narrow the first.
    expect(url.searchParams.get('include_granted_scopes')).toBe('true');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('S');
  });

  it('never puts the client secret in the URL', () => {
    const url = buildAuthUrl(CLIENT, { state: 'S', scopes: 'x' });
    expect(url).not.toContain(CLIENT.clientSecret);
    expect(url).toContain(CLIENT.clientId);
  });
});

// ------------------------------------------------------------------ tokens

describe('token exchange', () => {
  it('records what was GRANTED, not what was requested', async () => {
    const fetchImpl = (async () => jsonResponse({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3600,
      // The provider granted less than we asked for.
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    })) as unknown as typeof fetch;

    const tokens = await exchangeCode(
      CLIENT,
      { code: 'C', verifier: 'V', scopes: 'https://www.googleapis.com/auth/calendar' },
      { fetchImpl },
    );
    expect(tokens.grantedScopes).toBe('https://www.googleapis.com/auth/calendar.readonly');
  });

  it('classifies a dead grant as revoked rather than retryable', async () => {
    const fetchImpl = (async () => jsonResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(exchangeCode(CLIENT, { code: 'C', scopes: 'x' }, { fetchImpl }))
      .rejects.toMatchObject({ category: 'revoked', revoked: true });
  });

  it('never repeats the provider body, which quotes the request', async () => {
    const fetchImpl = (async () => jsonResponse({
      error: 'invalid_request',
      error_description: 'the request contained SECRET-MAILBOX-CONTENT',
    }, 400)) as unknown as typeof fetch;

    await exchangeCode(CLIENT, { code: 'C', scopes: 'x' }, { fetchImpl }).catch((err: ConnectorError) => {
      expect(err.message).not.toContain('SECRET-MAILBOX-CONTENT');
      expect(err.category).toBe('provider_error');
    });
  });

  it('treats an unreachable provider as a network failure, not a dead grant', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(exchangeCode(CLIENT, { code: 'C', scopes: 'x' }, { fetchImpl }))
      .rejects.toMatchObject({ category: 'network', revoked: false });
  });

  it('refuses a 200 that carries no access token', async () => {
    const fetchImpl = (async () => jsonResponse({ token_type: 'Bearer' })) as unknown as typeof fetch;
    await expect(exchangeCode(CLIENT, { code: 'C', scopes: 'x' }, { fetchImpl }))
      .rejects.toThrow(/no access token/);
  });
});

describe('identity', () => {
  it('reads the account from either provider shape', async () => {
    const google = (async () => jsonResponse({ sub: 'g-1', email: 'me@gmail.test' })) as unknown as typeof fetch;
    expect(await fetchIdentity('google', 'AT', { fetchImpl: google }))
      .toEqual({ accountId: 'g-1', email: 'me@gmail.test' });

    const ms = (async () => jsonResponse({ id: 'm-1', userPrincipalName: 'me@corp.test' })) as unknown as typeof fetch;
    expect(await fetchIdentity('microsoft', 'AT', { fetchImpl: ms }))
      .toEqual({ accountId: 'm-1', email: 'me@corp.test' });
  });
});

// ------------------------------------------------------------- connections

describe('storing a connection', () => {
  const tokens = {
    accessToken: 'ACCESS-TOKEN-VALUE', refreshToken: 'REFRESH-TOKEN-VALUE',
    expiresIn: 3600, grantedScopes: 'https://www.googleapis.com/auth/calendar.readonly',
  };

  it('seals the tokens and keeps them out of the audit log', async () => {
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: 'me@gmail.test', providerAccountId: 'g-1',
      requestedCapabilities: ['google.calendar.read'],
    });

    const [row] = await db.query<{ secrets_enc: string }>(`select secrets_enc from connections`);
    expect(looksSealed(row.secrets_enc)).toBe(true);
    expect(row.secrets_enc).not.toContain('ACCESS-TOKEN-VALUE');
    expect(row.secrets_enc).not.toContain('REFRESH-TOKEN-VALUE');

    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('ACCESS-TOKEN-VALUE');
    expect(events).not.toContain('REFRESH-TOKEN-VALUE');
    // Nor which mailbox it is — that is content about the person.
    expect(events).not.toContain('me@gmail.test');
    expect(events).toContain('connection.authorized');
  });

  it('records the capability as available but NOT enabled', async () => {
    // Consent to CONNECT is not consent to ACT.
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: null, providerAccountId: null,
      requestedCapabilities: ['google.calendar.read'],
    });
    const [grant] = await db.query<{ enabled: boolean; scopes_granted_at: string | null }>(
      `select enabled, scopes_granted_at from connection_capabilities`,
    );
    expect(grant.scopes_granted_at).toBeTruthy();
    expect(grant.enabled).toBe(false);
    expect((await can(db, { ownerUserId: alice, capability: 'google.calendar.read' })).allowed).toBe(false);
  });

  it('uses the latest token scopes and removes withdrawn grants', async () => {
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: null, providerAccountId: null, requestedCapabilities: ['google.calendar.read'],
    });
    // A provider response describes the new token; never retain withdrawn scopes.
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { ...tokens, grantedScopes: 'https://www.googleapis.com/auth/gmail.readonly' },
      accountEmail: null, providerAccountId: null, requestedCapabilities: ['google.mail.read'],
    });

    const connection = await connectionFor(db, { ownerUserId: alice, provider: 'google' });
    expect(connection!.granted_scopes).not.toContain('calendar.readonly');
    expect(connection!.granted_scopes).toContain('gmail.readonly');
  });

  it('keeps two accounts from the same provider and updates by provider identity', async () => {
    const first = await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: 'one@example.test', providerAccountId: 'google-1', requestedCapabilities: ['google.calendar.read'],
    });
    const second = await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: 'two@example.test', providerAccountId: 'google-2', requestedCapabilities: ['google.calendar.read'],
    });
    expect(second.id).not.toBe(first.id);
    expect(await db.query(`select id from connections where owner_user_id=$1 and provider='google'`, [alice])).toHaveLength(2);

    const again = await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: 'renamed@example.test', providerAccountId: 'google-1', requestedCapabilities: ['google.calendar.read'],
    });
    expect(again.id).toBe(first.id);
    expect(await db.query(`select id from connections where owner_user_id=$1 and provider='google'`, [alice])).toHaveLength(2);
  });

  it('finishes enabling an explicitly requested write capability after re-consent', async () => {
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: null, providerAccountId: null, requestedCapabilities: ['google.calendar.read'],
    });
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { ...tokens, grantedScopes: 'https://www.googleapis.com/auth/calendar' },
      accountEmail: null, providerAccountId: null,
      requestedCapabilities: ['google.calendar.write'],
      enableRequestedCapabilities: true,
    });

    expect(await can(db, { ownerUserId: alice, capability: 'google.calendar.write' }))
      .toEqual({ allowed: true, state: 'on' });
  });

  it('keeps the refresh token when the provider does not reissue one', async () => {
    // Google does not return a refresh token on re-auth unless it feels like
    // it. Losing ours would silently kill the connection at the next expiry.
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { ...tokens, refreshToken: null },
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });

    const connection = await connectionFor(db, { ownerUserId: alice, provider: 'google' });
    const opened = openSealed<{ refreshToken: string | null }>(key, connection!.secrets_enc!);
    expect(opened.refreshToken).toBe('REFRESH-TOKEN-VALUE');
  });

  it('belongs to one person', async () => {
    await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google', tokens,
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });
    expect(await connectionFor(db, { ownerUserId: bob, provider: 'google' })).toBeNull();
  });
});

describe('enabling a capability', () => {
  async function connect(grantedScopes: string) {
    return upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, grantedScopes },
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });
  }

  it('is refused for a scope the provider never granted — M32', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.readonly');
    // Read was granted; send was not. Enabling send has to send them back
    // through consent rather than storing a wish.
    await expect(setCapability(db, {
      connection, capability: 'google.mail.send', enabled: true, actorUserId: alice,
    })).rejects.toThrow(CapabilityError);

    expect((await can(db, { ownerUserId: alice, capability: 'google.mail.send' })))
      .toEqual({ allowed: false, state: 'needs_consent' });
  });

  it('works once the provider has granted it', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.send');
    await setCapability(db, {
      connection, capability: 'google.mail.send', enabled: true, actorUserId: alice,
    });
    expect((await can(db, { ownerUserId: alice, capability: 'google.mail.send' })))
      .toEqual({ allowed: true, state: 'on' });
  });

  it('is refused when an administrator has forbidden it', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.send');
    await db.query(
      `insert into admin_capability_policy (capability, allowed, note)
       values ('google.mail.send', false, 'not on this installation')`,
    );
    await expect(setCapability(db, {
      connection, capability: 'google.mail.send', enabled: true, actorUserId: alice,
    })).rejects.toThrow(/administrator/);
  });

  it('is switched off by an administrator even after the user enabled it', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.send');
    await setCapability(db, {
      connection, capability: 'google.mail.send', enabled: true, actorUserId: alice,
    });
    expect((await can(db, { ownerUserId: alice, capability: 'google.mail.send' })).allowed).toBe(true);

    await db.query(
      `insert into admin_capability_policy (capability, allowed) values ('google.mail.send', false)`,
    );
    expect((await can(db, { ownerUserId: alice, capability: 'google.mail.send' })))
      .toEqual({ allowed: false, state: 'blocked_by_admin' });
  });

  it('is NOT switched on by an administrator permitting it', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.send');
    await db.query(
      `insert into admin_capability_policy (capability, allowed) values ('google.mail.send', true)`,
    );
    // The user never enabled it. An allow is not a grant.
    expect((await can(db, { ownerUserId: alice, capability: 'google.mail.send' })))
      .toEqual({ allowed: false, state: 'off' });
    void connection;
  });

  it('shows a write capability with its consequence before it is switched on', async () => {
    const connection = await connect('https://www.googleapis.com/auth/gmail.send');
    const views = await capabilityViews(db, { connection, provider: 'google' });
    const send = views.find((v) => v.key === 'google.mail.send')!;
    expect(send.state).toBe('off');
    expect(send.consequence).toMatch(/send email/i);
  });

  it('keeps the capability out of another person reach', async () => {
    await connect('https://www.googleapis.com/auth/gmail.send');
    expect((await can(db, { ownerUserId: bob, capability: 'google.mail.send' })).allowed).toBe(false);
  });
});

describe('token refresh and health', () => {
  async function connected(expiresInSeconds: number) {
    const connection = await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresIn: expiresInSeconds, grantedScopes: 'x' },
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });
    return connection;
  }

  it('uses the stored token while it is still valid', async () => {
    const connection = await connected(3600);
    const fetchImpl = (async () => { throw new Error('should not refresh'); }) as unknown as typeof fetch;
    expect(await accessTokenFor(db, key, { connection, client: CLIENT }, { fetchImpl })).toBe('OLD');
  });

  it('refreshes one that is about to expire', async () => {
    const connection = await connected(10); // inside the 60s margin
    const fetchImpl = (async () => jsonResponse({ access_token: 'NEW', expires_in: 3600 })) as unknown as typeof fetch;
    expect(await accessTokenFor(db, key, { connection, client: CLIENT }, { fetchImpl })).toBe('NEW');

    // And the refresh token we already held survives, because Google will not
    // reissue it.
    const after = await connectionFor(db, { ownerUserId: alice, provider: 'google' });
    expect(openSealed<{ refreshToken: string }>(key, after!.secrets_enc!).refreshToken).toBe('RT');
  });

  it('marks the connection for reconnection when the grant is gone', async () => {
    const connection = await connected(10);
    const fetchImpl = (async () => jsonResponse({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(accessTokenFor(db, key, { connection, client: CLIENT }, { fetchImpl })).rejects.toThrow();

    const after = await connectionFor(db, { ownerUserId: alice, provider: 'google' });
    expect(after!.status).toBe('needs_reconnect');
    expect(after!.last_error_category).toBe('revoked');
  });

  it('does not demand a reconnect for a rate limit', async () => {
    const connection = await connected(3600);
    await markUnhealthy(db, connection.id, 'rate_limited');
    const after = await connectionFor(db, { ownerUserId: alice, provider: 'google' });
    // Being throttled is not the same as being revoked, and telling someone to
    // reconnect would be wrong advice.
    expect(after!.status).toBe('active');
    expect(after!.last_error_category).toBe('rate_limited');
  });

  it('records only a category in the log, never the provider text', async () => {
    const connection = await connected(3600);
    await markUnhealthy(db, connection.id, 'provider_error');
    const events = await db.query<{ payload: { category: string } }>(
      `select payload from events where kind = 'connection.unhealthy'`,
    );
    expect(events[0].payload).toEqual({ category: 'provider_error' });
  });
});

describe('disconnecting', () => {
  it('removes the connection and its capability grants', async () => {
    const connection = await upsertConnection(db, key, {
      ownerUserId: alice, provider: 'google',
      tokens: { accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, grantedScopes: 'https://www.googleapis.com/auth/gmail.send' },
      accountEmail: null, providerAccountId: null, requestedCapabilities: [],
    });
    await setCapability(db, { connection, capability: 'google.mail.send', enabled: true, actorUserId: alice });

    await deleteConnection(db, { connectionId: connection.id, actorUserId: alice, actor: 'user' });
    expect(await db.query(`select 1 from connections`)).toHaveLength(0);
    // A reconnect starts from "nothing enabled", which is where consent should
    // start.
    expect(await db.query(`select 1 from connection_capabilities`)).toHaveLength(0);
  });

  it('says plainly that microsoft cannot be revoked remotely', async () => {
    const result = await revokeAtProvider(
      { ...CLIENT, provider: 'microsoft' }, 'RT',
      { fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch },
    );
    expect(result.revokedRemotely).toBe(false);
    expect(result.note).toMatch(/remove Josi from your Microsoft account permissions/i);
  });

  it('still reports honestly when the provider cannot be reached', async () => {
    const result = await revokeAtProvider(
      CLIENT, 'RT',
      { fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch },
    );
    expect(result.revokedRemotely).toBe(false);
    expect(result.note).toMatch(/could not reach the provider/i);
  });
});
