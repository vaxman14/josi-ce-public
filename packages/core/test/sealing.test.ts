// Sealing, and the defect that made it useless for the values it was written
// for.
//
// This file exists because of one bug, found in Phase 13 and shipped since
// Phase 0: `seal()` passed a replacer to `JSON.stringify` intending to unwrap
// `Secret` objects, and the replacer never once ran on a `Secret`. Values with
// a `toJSON` method are converted BEFORE the replacer sees them, so every
// `Secret` had already become the string `[secret redacted]`.
//
// The existing suites all sealed plain strings, so all of them passed while
// every credential that reached `seal()` through `asSecret()` — LLM API keys,
// OAuth client secrets, SMTP passwords — was stored as the redaction marker and
// would have failed with a 401 on a real installation.
//
// So the first describe block below is the regression, written the way the bug
// would have been caught: seal what production seals, and open it.
import { describe, expect, it } from 'vitest';
import { MasterKey } from '../src/masterKey.js';
import {
  Secret, SealingError, asSecret, looksSealed, openSealed, seal, unwrapSecrets,
} from '../src/sealing.js';

const key = new MasterKey(Buffer.alloc(32, 7));
const other = new MasterKey(Buffer.alloc(32, 9));

describe('a Secret survives the round trip (the Phase 0 defect)', () => {
  it('seals the value, not the redaction marker', () => {
    // Deliberately NOT shaped like a real provider key: `scan-secrets.sh`
    // refuses an `sk-…` string anywhere in the tree, and it is right to.
    const sealed = seal(key, { apiKey: asSecret('provider-key-fixture-value') });
    const opened = openSealed<{ apiKey: string }>(key, sealed);
    expect(opened.apiKey).toBe('provider-key-fixture-value');
    // The exact symptom. Before the fix this assertion was the actual value.
    expect(opened.apiKey).not.toBe('[secret redacted]');
  });

  it('handles every shape production actually seals', () => {
    // One case per call site, so a future refactor of any of them is covered.
    const cases: Array<[string, unknown, unknown]> = [
      ['llm api key', { apiKey: asSecret('key-1') }, { apiKey: 'key-1' }],
      ['oauth client secret', { clientSecret: asSecret('cs-2') }, { clientSecret: 'cs-2' }],
      ['smtp password', { password: asSecret('pw-3') }, { password: 'pw-3' }],
      ['telegram bot token', { token: asSecret('123:abc') }, { token: '123:abc' }],
      ['pkce verifier', { verifier: 'plain-string' }, { verifier: 'plain-string' }],
      [
        'oauth tokens',
        { accessToken: asSecret('at'), refreshToken: null },
        { accessToken: 'at', refreshToken: null },
      ],
    ];
    for (const [name, payload, expected] of cases) {
      expect(openSealed(key, seal(key, payload)), name).toEqual(expected);
    }
  });

  it('unwraps a Secret nested in an object or an array', () => {
    const sealed = seal(key, {
      outer: { inner: asSecret('deep') },
      list: [asSecret('one'), 'two', { three: asSecret('3') }],
    });
    expect(openSealed(key, sealed)).toEqual({
      outer: { inner: 'deep' },
      list: ['one', 'two', { three: '3' }],
    });
  });

  it('unwraps a bare Secret passed as the whole payload', () => {
    expect(openSealed(key, seal(key, asSecret('bare')))).toBe('bare');
  });

  it('leaves everything that is not a Secret exactly as it was', () => {
    const payload = {
      n: 42, s: 'text', b: true, nil: null, arr: [1, 2], nested: { deep: { deeper: 'x' } },
    };
    expect(openSealed(key, seal(key, payload))).toEqual(payload);
  });
});

describe('unwrapSecrets on its own', () => {
  it('reveals a Secret', () => {
    expect(unwrapSecrets(asSecret('v'))).toBe('v');
  });

  it('does not touch a value that has its own toJSON', () => {
    // A Date's serialisation is a behaviour callers have relied on since Phase
    // 1; the fix must not change what a non-Secret object turns into.
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(unwrapSecrets({ at: date })).toEqual({ at: date });
    expect(JSON.parse(JSON.stringify(unwrapSecrets({ at: date })))).toEqual({
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('survives a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.k = asSecret('v');
    expect(unwrapSecrets(bare)).toEqual({ k: 'v' });
  });

  it('leaves primitives alone', () => {
    for (const v of [1, 'a', true, null, undefined]) expect(unwrapSecrets(v)).toBe(v);
  });
});

describe('the Secret wrapper itself', () => {
  it('redacts through every accidental path', () => {
    const s = asSecret('top-secret');
    expect(String(s)).toBe('[secret redacted]');
    expect(`${s}`).toBe('[secret redacted]');
    expect(JSON.stringify({ s })).toBe('{"s":"[secret redacted]"}');
    expect(JSON.stringify({ ...{ s } })).not.toContain('top-secret');
    // Only the greppable call reveals it.
    expect(s.reveal()).toBe('top-secret');
  });

  it('turns a non-string into an empty secret rather than "undefined"', () => {
    // Sealing the four-letter string "null" as somebody's API key would be a
    // credential that looks configured and is not.
    for (const junk of [undefined, null, 42, {}, []]) {
      expect(asSecret(junk).isEmpty).toBe(true);
      expect(asSecret(junk).reveal()).toBe('');
    }
  });

  it('reports length without revealing', () => {
    expect(new Secret('abcd').length).toBe(4);
  });
});

describe('opening', () => {
  it('refuses the wrong key without saying it was the key', () => {
    const sealed = seal(key, { a: 1 });
    // A wrong key and a tampered ciphertext must be indistinguishable:
    // distinguishing them is an oracle.
    let wrongKey = '';
    let tampered = '';
    try { openSealed(other, sealed); } catch (e) { wrongKey = (e as Error).message; }
    const parts = sealed.split('.');
    parts[3] = Buffer.from('nonsense').toString('base64');
    try { openSealed(key, parts.join('.')); } catch (e) { tampered = (e as Error).message; }
    expect(wrongKey).toBe(tampered);
    expect(wrongKey).toBe('could not open sealed value');
  });

  it('refuses a value that is not the right shape', () => {
    for (const junk of ['', 'v1.a.b', 'v2.a.b.c', 'not-sealed-at-all']) {
      expect(() => openSealed(key, junk), junk).toThrow(SealingError);
    }
  });

  it('detects a tampered auth tag, because GCM is authenticated', () => {
    const sealed = seal(key, { grant: 'read' });
    const parts = sealed.split('.');
    parts[2] = Buffer.alloc(16, 1).toString('base64');
    expect(() => openSealed(key, parts.join('.'))).toThrow(SealingError);
  });

  it('produces a different ciphertext every time for the same plaintext', () => {
    // A fresh IV per seal. Identical ciphertexts would tell an observer with a
    // database dump which two users configured the same provider key.
    const a = seal(key, { apiKey: asSecret('same') });
    const b = seal(key, { apiKey: asSecret('same') });
    expect(a).not.toBe(b);
    expect(openSealed(key, a)).toEqual(openSealed(key, b));
  });
});

describe('looksSealed', () => {
  it('recognises what this module produces and nothing else', () => {
    expect(looksSealed(seal(key, { a: 1 }))).toBe(true);
    for (const junk of ['plaintext', '', null, 42, 'v1.a.b', '[secret redacted]']) {
      expect(looksSealed(junk), String(junk)).toBe(false);
    }
  });
});
