// The master key's contract: it comes from a file, it is 32 bytes, and it does
// not leak into anything that prints.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  MasterKey, MasterKeyError, loadMasterKey, masterKeyAvailable, parseMasterKey,
} from '../src/masterKey.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-key-'));
const validBase64 = Buffer.alloc(32, 7).toString('base64');

function keyFile(name: string, contents: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  delete process.env.MASTER_KEY;
  delete process.env.CREDENTIALS_KEY;
  delete process.env.MASTER_KEY_FILE;
});

describe('parsing', () => {
  it('accepts 32 bytes as base64 or hex, with or without a trailing newline', () => {
    expect(parseMasterKey(validBase64)).toHaveLength(32);
    expect(parseMasterKey(`${validBase64}\n`)).toHaveLength(32);
    expect(parseMasterKey('a'.repeat(64))).toHaveLength(32);
  });

  it('refuses a key that is the wrong size, and says how to make one', () => {
    expect(() => parseMasterKey('too-short')).toThrow(MasterKeyError);
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseMasterKey('')).toThrow(/empty/);
    try {
      parseMasterKey(Buffer.alloc(8).toString('base64'));
    } catch (err) {
      expect((err as Error).message).toMatch(/openssl rand/);
    }
  });
});

describe('loading', () => {
  it('reads a key from a file', () => {
    const path = keyFile('good.key', validBase64);
    expect(loadMasterKey({ path }).reveal()).toHaveLength(32);
  });

  it('refuses a key supplied through the environment', () => {
    // This is the whole reason the loader exists. An env var is visible in
    // `docker inspect` and inherited by every child process, so accepting one
    // silently would undo the point of the Docker secret.
    const path = keyFile('env.key', validBase64);
    process.env.MASTER_KEY = validBase64;
    expect(() => loadMasterKey({ path })).toThrow(/must not be supplied in an environment variable/);

    delete process.env.MASTER_KEY;
    process.env.CREDENTIALS_KEY = validBase64;
    expect(() => loadMasterKey({ path })).toThrow(/environment variable/);
  });

  it('points at the installer when the file is absent', () => {
    expect(() => loadMasterKey({ path: join(dir, 'nope.key') })).toThrow(/scripts\/install\.sh/);
  });

  it('refuses a world-readable key file under strict permissions', () => {
    const path = keyFile('loose.key', validBase64, 0o644);
    expect(() => loadMasterKey({ path, strictPermissions: true })).toThrow(/readable by other users/);
    // Advisory by default, because a Docker secret is mounted 0444 and that is
    // not the operator doing anything wrong.
    expect(() => loadMasterKey({ path })).not.toThrow();
  });

  it('reports availability without throwing', () => {
    expect(masterKeyAvailable({ path: keyFile('avail.key', validBase64) })).toBe(true);
    expect(masterKeyAvailable({ path: join(dir, 'absent.key') })).toBe(false);
  });
});

describe('the key does not leak into anything that prints', () => {
  const secret = Buffer.alloc(32, 42);
  const key = new MasterKey(secret);
  const material = secret.toString('base64');

  it('redacts through String, template literals and JSON', () => {
    expect(String(key)).toBe('[master key redacted]');
    expect(`${key}`).not.toContain(material);
    expect(JSON.stringify(key)).not.toContain(material);
    expect(JSON.stringify({ key })).not.toContain(material);
  });

  it('redacts through util.inspect, which is what console.log uses', () => {
    const printed = inspect(key, { depth: 5 });
    expect(printed).not.toContain(material);
    expect(printed).toContain('redacted');
    // Nested inside an object, the shape console.error(ctx) would produce.
    expect(inspect({ config: { key } }, { depth: 5 })).not.toContain(material);
  });

  it('still hands over the bytes when asked explicitly', () => {
    // `.reveal()` is greppable, which is the point: leaking now requires
    // writing something a reviewer can find.
    expect(key.reveal().equals(secret)).toBe(true);
  });

  it('refuses a key of the wrong length at construction', () => {
    expect(() => new MasterKey(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
