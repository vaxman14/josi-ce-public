// Reading contacts from Google and Microsoft.
//
// No provider is contacted anywhere in this file: `fetchImpl` is injected. The
// payloads below are the documented response shapes for the People API's
// `people/me/connections` and Graph's `/me/contacts/delta`, including the two
// that are easy to miss — a deletion arriving as an entry rather than as an
// absence, and a cursor that has aged out.
import { describe, expect, it } from 'vitest';
import {
  ConnectorError, ExpiredCursor, backoffMs, readContactPage, writeContact,
} from '../src/index.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Captures what was requested, so the URL and headers can be asserted. */
function spy(response: Response | ((url: string, init?: RequestInit) => Response)) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof response === 'function' ? response(String(url), init) : response;
  };
  return { fetchImpl, calls };
}

describe('Google People', () => {
  it('reads a page and normalises it', async () => {
    const { fetchImpl, calls } = spy(json(200, {
      connections: [
        {
          resourceName: 'people/c123',
          etag: '%EgUBAj0=',
          metadata: { sources: [{ updateTime: '2026-08-01T10:00:00Z' }] },
          names: [{ displayName: 'Alice Example' }],
          emailAddresses: [{ value: 'alice@example.test' }, { value: 'ALICE@example.test' }],
          phoneNumbers: [{ value: '+44 20 7946 0958' }],
        },
      ],
      nextSyncToken: 'sync-token-1',
    }));

    const page = await readContactPage('google', { accessToken: 'token' }, { fetchImpl });

    expect(calls[0].url).toContain('people.googleapis.com/v1/people/me/connections');
    // Exactly the fields Josi stores, and no more. Asking for birthdays and
    // photos because they are available means storing them.
    expect(calls[0].url).toContain('personFields=names%2CemailAddresses%2CphoneNumbers%2Cmetadata');
    // Requested on EVERY page: Google only returns a syncToken at the end, and
    // only if it was asked for throughout.
    expect(calls[0].url).toContain('requestSyncToken=true');

    expect(page.contacts).toHaveLength(1);
    expect(page.contacts[0]).toMatchObject({
      sourceId: 'people/c123',
      displayName: 'Alice Example',
      phones: ['+44 20 7946 0958'],
      deleted: false,
    });
    // Case-duplicate addresses collapse.
    expect(page.contacts[0].emails).toEqual(['alice@example.test']);
    expect(page.nextDeltaCursor).toBe('sync-token-1');
    expect(page.wasFullResync).toBe(true);
  });

  it('sees a deletion, which arrives as an entry and not as an absence', async () => {
    const { fetchImpl } = spy(json(200, {
      connections: [{ resourceName: 'people/c123', metadata: { deleted: true } }],
      nextSyncToken: 'sync-token-2',
    }));
    const page = await readContactPage('google', { accessToken: 't', deltaCursor: 'old' }, { fetchImpl });
    expect(page.contacts[0].deleted).toBe(true);
    expect(page.contacts[0].sourceId).toBe('people/c123');
  });

  it('sends the sync token on an incremental read and the page token mid-run', async () => {
    const first = spy(json(200, { connections: [], nextPageToken: 'page-2' }));
    await readContactPage('google', { accessToken: 't', deltaCursor: 'tok' }, { fetchImpl: first.fetchImpl });
    expect(first.calls[0].url).toContain('syncToken=tok');

    const second = spy(json(200, { connections: [], nextSyncToken: 'tok-2' }));
    await readContactPage('google', { accessToken: 't', deltaCursor: 'tok', pageCursor: 'page-2' }, { fetchImpl: second.fetchImpl });
    // Mid-run the page token replaces the sync token; sending both is an error.
    expect(second.calls[0].url).toContain('pageToken=page-2');
    expect(second.calls[0].url).not.toContain('syncToken=');
  });

  it('reports an aged-out sync token as an instruction, not a failure', async () => {
    // 410 EXPIRED is routine. Treating it as an error is how sync silently
    // stops working after a week away.
    const { fetchImpl } = spy(json(410, { error: { status: 'FAILED_PRECONDITION', message: 'Sync token expired' } }));
    await expect(readContactPage('google', { accessToken: 't', deltaCursor: 'stale' }, { fetchImpl }))
      .rejects.toBeInstanceOf(ExpiredCursor);
  });

  it('writes with the field mask that stops it wiping what Josi does not manage', async () => {
    const { fetchImpl, calls } = spy(json(200, {
      resourceName: 'people/c9', etag: 'e2', names: [{ displayName: 'Bob' }],
    }));
    await writeContact('google', {
      accessToken: 't', sourceId: 'people/c9', etag: 'e1',
      displayName: 'Bob', emails: ['bob@example.test'], phones: [],
    }, { fetchImpl });

    expect(calls[0].url).toContain('people/c9:updateContact');
    expect(calls[0].url).toContain('updatePersonFields=names%2CemailAddresses%2CphoneNumbers');
    // Google's conditional update travels in the body, so the provider itself
    // refuses a lost update.
    expect(JSON.parse(String(calls[0].init?.body)).etag).toBe('e1');
  });
});

describe('Microsoft Graph', () => {
  it('reads a delta page and normalises it', async () => {
    const { fetchImpl, calls } = spy(json(200, {
      value: [
        {
          id: 'AAMkAD',
          '@odata.etag': 'W/"EQAAABYAAAB"',
          displayName: 'Alice Example',
          lastModifiedDateTime: '2026-08-01T10:00:00Z',
          emailAddresses: [{ address: 'alice@example.test', name: 'Alice' }],
          businessPhones: ['+442079460958'],
          mobilePhone: '+447700900123',
        },
      ],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=abc',
    }));

    const page = await readContactPage('microsoft', { accessToken: 'token' }, { fetchImpl });

    expect(calls[0].url).toContain('graph.microsoft.com/v1.0/me/contacts/delta');
    expect(new Headers(calls[0].init?.headers).get('Prefer')).toContain('odata.maxpagesize');
    expect(page.contacts[0]).toMatchObject({ sourceId: 'AAMkAD', displayName: 'Alice Example', deleted: false });
    expect(page.contacts[0].phones).toEqual(['+442079460958', '+447700900123']);
    expect(page.nextDeltaCursor).toContain('$deltatoken=abc');
  });

  it('assembles a name when Graph omits displayName', async () => {
    const { fetchImpl } = spy(json(200, { value: [{ id: 'x', givenName: 'Ada', surname: 'Lovelace' }] }));
    const page = await readContactPage('microsoft', { accessToken: 't' }, { fetchImpl });
    expect(page.contacts[0].displayName).toBe('Ada Lovelace');
  });

  it('sees a removal, which carries only an id and @removed', async () => {
    const { fetchImpl } = spy(json(200, {
      value: [{ id: 'AAMkAD', '@removed': { reason: 'deleted' } }],
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/contacts/delta?$deltatoken=z',
    }));
    const page = await readContactPage('microsoft', { accessToken: 't', deltaCursor: 'https://graph.microsoft.com/v1.0/x' }, { fetchImpl });
    expect(page.contacts[0].deleted).toBe(true);
  });

  it('uses Graph’s own cursor URLs verbatim', async () => {
    const link = 'https://graph.microsoft.com/v1.0/me/contacts/delta?$skiptoken=XYZ';
    const { fetchImpl, calls } = spy(json(200, { value: [] }));
    await readContactPage('microsoft', { accessToken: 't', pageCursor: link }, { fetchImpl });
    // Rebuilt cursors silently lose their state parameters.
    expect(calls[0].url).toBe(link);
  });

  it('refuses a cursor that points somewhere other than Graph', async () => {
    // A cursor is a URL we will call WITH A BEARER TOKEN attached. One that
    // came back pointing elsewhere is a token-exfiltration primitive.
    const { fetchImpl, calls } = spy(json(200, { value: [] }));
    await expect(
      readContactPage('microsoft', { accessToken: 't', pageCursor: 'https://evil.example/steal' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls, 'nothing may be requested').toHaveLength(0);
  });

  it('reports an aged-out delta link as an instruction, not a failure', async () => {
    const { fetchImpl } = spy(json(410, { error: { code: 'syncStateNotFound' } }));
    await expect(
      readContactPage('microsoft', { accessToken: 't', deltaCursor: 'https://graph.microsoft.com/v1.0/old' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(ExpiredCursor);
  });

  it('treats a failed precondition on write as a conflict, not a crash', async () => {
    const { fetchImpl, calls } = spy(json(412, {}));
    await expect(writeContact('microsoft', {
      accessToken: 't', sourceId: 'AAMkAD', etag: 'W/"1"',
      displayName: 'Alice', emails: [], phones: [],
    }, { fetchImpl })).rejects.toMatchObject({ status: 412 });
    // The precondition is a header on Graph, and without it a PATCH silently
    // overwrites whatever changed since the read.
    expect(new Headers(calls[0].init?.headers).get('If-Match')).toBe('W/"1"');
  });
});

describe('failures are categorised, and quote nothing', () => {
  const cases: Array<[number, unknown, string]> = [
    [401, {}, 'expired'],
    [403, { error: { status: 'PERMISSION_DENIED' } }, 'insufficient_scope'],
    [429, {}, 'rate_limited'],
    [500, {}, 'provider_error'],
  ];

  for (const [status, body, category] of cases) {
    it(`calls ${status} ${category}`, async () => {
      const { fetchImpl } = spy(json(status, body));
      await expect(readContactPage('google', { accessToken: 't' }, { fetchImpl }))
        .rejects.toMatchObject({ category });
    });
  }

  it('never repeats a provider message, which quotes the address book', async () => {
    const { fetchImpl } = spy(json(400, {
      error: {
        status: 'INVALID_ARGUMENT',
        message: "Invalid person: alice@example.test with phone +442079460958",
      },
    }));
    const error = await readContactPage('google', { accessToken: 't' }, { fetchImpl }).catch((e) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    // The short code is safe and useful; the prose is not ours to relay.
    expect(String(error.message)).toContain('INVALID_ARGUMENT');
    expect(String(error.message)).not.toContain('alice@example.test');
    expect(String(error.message)).not.toContain('442079460958');
  });

  it('reports an unreachable provider as a network failure', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error('ECONNREFUSED'); };
    await expect(readContactPage('google', { accessToken: 't' }, { fetchImpl }))
      .rejects.toMatchObject({ category: 'network' });
  });
});

describe('backing off', () => {
  it('honours the provider’s own Retry-After', () => {
    // A provider that says "wait 30 seconds" and is retried in two starts
    // refusing for longer.
    expect(backoffMs(1, 30)).toBe(30_000);
    expect(backoffMs(3, 5)).toBe(5_000);
  });

  it('grows, and stops growing', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    // Capped, so a background job cannot sleep for an hour.
    expect(backoffMs(20)).toBe(60_000);
    expect(backoffMs(1, 100_000)).toBe(300_000);
  });
});
