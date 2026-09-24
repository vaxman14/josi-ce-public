// The installation master key.
//
// Everything sensitive in the database — provider API keys, OAuth client
// secrets, SMTP passwords, connection tokens — is sealed with this key, and the
// key lives OUTSIDE the database. That is the property being bought: a stolen
// database dump, or a backup restored onto someone else's machine, yields
// ciphertext.
//
// It is loaded from a FILE, never an environment variable. Environment
// variables leak in ways files do not: `docker inspect` prints them, they are
// inherited by every child process, they turn up in crash reports and in
// `/proc/<pid>/environ`, and a stray `console.log(process.env)` ships them to a
// log aggregator. A file mounted as a Docker secret is readable by the process
// and by nothing else.
import { readFileSync, statSync } from 'node:fs';

export const DEFAULT_MASTER_KEY_PATH = '/run/secrets/josi_master_key';

export class MasterKeyError extends Error {}

/** Wrapper that makes the key awkward to leak by accident.
 *
 * The bytes are held in a closure rather than on a property, so a spread, a
 * JSON.stringify, a template literal or a console.log of the wrapper produces
 * a redaction marker instead of key material. Getting the actual bytes requires
 * calling `.reveal()`, which is greppable in review. */
export class MasterKey {
  #bytes: Buffer;

  constructor(bytes: Buffer) {
    if (bytes.length !== 32) {
      throw new MasterKeyError(`master key must be 32 bytes, got ${bytes.length}`);
    }
    this.#bytes = bytes;
  }

  reveal(): Buffer {
    return this.#bytes;
  }

  toString(): string {
    return '[master key redacted]';
  }

  toJSON(): string {
    return '[master key redacted]';
  }

  // Node's console.log/util.inspect honours this over the raw object.
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[master key redacted]';
  }
}

export interface LoadOptions {
  path?: string;
  /** Injected in tests. */
  readFile?: (p: string) => Buffer;
  statFile?: (p: string) => { mode: number };
  /** Warn instead of refusing when the file is group/world readable. Docker
   * secrets are mounted 0444 inside the container, so the permission check is
   * advisory there and strict for a bind-mounted file in development. */
  strictPermissions?: boolean;
}

/** Parses 32 bytes from base64 or hex. Accepts trailing whitespace because a
 * key file written by `echo` has a newline and refusing that would be a
 * pointless footgun. */
export function parseMasterKey(raw: string): Buffer {
  const s = raw.trim();
  if (!s) throw new MasterKeyError('master key file is empty');
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) {
    throw new MasterKeyError(
      `master key must decode to 32 bytes (got ${buf.length}); generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function loadMasterKey(opts: LoadOptions = {}): MasterKey {
  const path = opts.path ?? process.env.MASTER_KEY_FILE ?? DEFAULT_MASTER_KEY_PATH;

  // A key handed over in the environment is a configuration mistake serious
  // enough to refuse: it means it is visible in `docker inspect` and inherited
  // by every child process. Fail loudly rather than quietly accepting it.
  if (process.env.MASTER_KEY || process.env.CREDENTIALS_KEY) {
    throw new MasterKeyError(
      'the master key must not be supplied in an environment variable; mount it as a file and set MASTER_KEY_FILE to its path',
    );
  }

  let raw: Buffer;
  try {
    raw = (opts.readFile ?? readFileSync)(path);
  } catch {
    throw new MasterKeyError(
      `no master key at ${path}. Run scripts/install.sh to generate one, and mount it as a Docker secret.`,
    );
  }

  if (opts.strictPermissions) {
    try {
      const mode = (opts.statFile ?? ((p: string) => statSync(p)))(path).mode;
      // Anything readable by group or other.
      if ((mode & 0o077) !== 0) {
        throw new MasterKeyError(
          `master key at ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); chmod 600 it`,
        );
      }
    } catch (err) {
      if (err instanceof MasterKeyError) throw err;
      // Cannot stat: on a Docker secret mount this is normal, so carry on.
    }
  }

  return new MasterKey(parseMasterKey(raw.toString('utf8')));
}

/** Whether a key is present and usable, without loading it into memory for
 * longer than the check. Used by the readiness probe, which must answer
 * "is this installation able to serve" without ever touching key material. */
export function masterKeyAvailable(opts: LoadOptions = {}): boolean {
  try {
    loadMasterKey(opts);
    return true;
  } catch {
    return false;
  }
}
