// The operator-supplied endpoint guard.
//
// The interesting cases are the two directions of failure: blocking cloud
// metadata (which must never be reachable) without blocking loopback and
// private addresses (which is where every self-hosted runtime lives).
import { describe, expect, it, vi } from 'vitest';
import { UnsafeEndpointError, blockedReason, safeFetch, validateEndpoint } from '../src/ssrf.js';

const resolveTo = (...addresses: string[]) => async () => addresses;

describe('address classification', () => {
  it('blocks every cloud metadata address', () => {
    // The one that turns a typo into stolen cloud credentials.
    expect(blockedReason('169.254.169.254')).toMatch(/metadata/);
    expect(blockedReason('169.254.0.1')).toMatch(/metadata/);
    // Reached through a v4-mapped v6 literal.
    expect(blockedReason('::ffff:169.254.169.254')).toMatch(/metadata/);

    // The SAME address in the spelling `new URL()` actually produces. This test
    // existed in the dotted form only, and a runtime check on a real server
    // found the hex form reaching metadata: the URL parser canonicalises
    // [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe], which the dotted-form
    // regex did not match. A checker that understands one spelling of an
    // address understands neither.
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(blockedReason('::ffff:a9fe:a9fe')).toMatch(/metadata/);
    // The v4-compatible form too.
    expect(blockedReason('::a9fe:a9fe')).toMatch(/metadata/);

    // And the addresses that merely LOOK like embedded v4 must be unaffected:
    // ::1 is loopback, not 0.0.0.1.
    expect(blockedReason('::1')).toBeNull();
    expect(blockedReason('::ffff:8.8.8.8')).toBeNull();
    expect(blockedReason('::ffff:0808:0808')).toBeNull();
    expect(blockedReason('fd00:ec2::254')).toMatch(/metadata/);
  });

  it('blocks the unspecified address, multicast and reserved space', () => {
    expect(blockedReason('0.0.0.0')).toBeTruthy();
    expect(blockedReason('224.0.0.1')).toMatch(/multicast/);
    expect(blockedReason('255.255.255.255')).toBeTruthy();
    expect(blockedReason('fe80::1')).toMatch(/link-local/);
    expect(blockedReason('ff02::1')).toMatch(/multicast/);
  });

  it('ALLOWS loopback and private ranges, because that is where self-hosted models live', () => {
    // Blocking these would leave openai_compatible supporting nothing.
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.50', '::1', 'fd12::1']) {
      expect(blockedReason(address), address).toBeNull();
    }
  });

  it('allows ordinary public addresses', () => {
    expect(blockedReason('1.1.1.1')).toBeNull();
    expect(blockedReason('2606:4700::1111')).toBeNull();
  });
});

describe('validateEndpoint', () => {
  it('accepts a self-hosted endpoint on loopback', async () => {
    const result = await validateEndpoint('http://127.0.0.1:11434/v1', { resolve: resolveTo('127.0.0.1') });
    expect(result.isLocal).toBe(true);
    expect(result.url.port).toBe('11434');
  });

  it('accepts a Docker service name that resolves privately', async () => {
    const result = await validateEndpoint('http://ollama:11434/v1', { resolve: resolveTo('172.18.0.4') });
    expect(result.isLocal).toBe(true);
  });

  it('refuses a hostname that resolves to metadata', async () => {
    await expect(
      validateEndpoint('http://sneaky.test/v1', { resolve: resolveTo('169.254.169.254') }),
    ).rejects.toThrow(UnsafeEndpointError);
  });

  it('refuses when ANY resolved address is blocked, not just the first', async () => {
    // A hostname answering with one good and one metadata address is a
    // rebinding attempt, not luck.
    await expect(
      validateEndpoint('http://mixed.test/v1', { resolve: resolveTo('1.1.1.1', '169.254.169.254') }),
    ).rejects.toThrow(/not allowed/);
  });

  it('refuses non-http schemes', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x.test', 'ftp://x.test']) {
      await expect(validateEndpoint(url, { resolve: resolveTo('1.1.1.1') }), url).rejects.toThrow(UnsafeEndpointError);
    }
  });

  it('refuses credentials embedded in the URL', async () => {
    await expect(
      validateEndpoint('http://user:pass@ollama.test/v1', { resolve: resolveTo('10.0.0.5') }),
    ).rejects.toThrow(/API key field/);
  });

  it('refuses an unresolvable hostname rather than assuming it is fine', async () => {
    await expect(
      validateEndpoint('http://nope.invalid/v1', { resolve: async () => { throw new Error('ENOTFOUND'); } }),
    ).rejects.toThrow(/could not be resolved/);
  });

  it('refuses a hostname that resolves to nothing', async () => {
    await expect(validateEndpoint('http://empty.test/v1', { resolve: resolveTo() })).rejects.toThrow(/no addresses/);
  });
});

describe('safeFetch', () => {
  it('never follows a redirect', async () => {
    // The bypass this exists for: a public URL that 302s to metadata.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    await expect(
      safeFetch('http://public.test/v1/chat', { method: 'POST' }, {
        resolve: resolveTo('1.1.1.1'),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/redirected/);
    // And it asked for manual handling rather than trusting the client default.
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });

  it('re-validates at request time, not only when the URL was saved', async () => {
    // DNS that was fine at save time and hostile now.
    let call = 0;
    const resolve = async () => (++call === 1 ? ['1.1.1.1'] : ['169.254.169.254']);
    await validateEndpoint('http://drifty.test/v1', { resolve }); // save-time: fine
    await expect(
      safeFetch('http://drifty.test/v1', { method: 'POST' }, {
        resolve,
        fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it('passes a normal response through', async () => {
    const res = await safeFetch('http://127.0.0.1:11434/v1/chat', { method: 'POST' }, {
      resolve: resolveTo('127.0.0.1'),
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
  });

  it('applies a timeout via an abort signal', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    await expect(
      safeFetch('http://127.0.0.1:11434/v1', { method: 'POST' }, {
        resolve: resolveTo('127.0.0.1'),
        timeoutMs: 20,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
  });
});
