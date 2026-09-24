import { hash, verify, type Options } from '@node-rs/argon2';

// argon2id, OWASP-ish minimums. Deliberately not tunable per call: one cost
// profile means every hash in the table is comparable and upgradeable together.
const OPTS: Options = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 12) throw new Error('password must be at least 12 characters');
  return hash(plain, OPTS);
}

/** Never throws on a malformed/absent hash: a user mid-invite (password_hash
 * null) must fail exactly like a wrong password, with the same timing shape. */
export async function verifyPassword(storedHash: string | null, plain: string): Promise<boolean> {
  if (!storedHash) {
    // Burn comparable time so "no password set" is not distinguishable.
    await hash(plain, OPTS).catch(() => undefined);
    return false;
  }
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

/** Temp passwords for seeded/invited accounts. Crypto random, no ambiguous
 * glyphs (no 0/O/1/l/I) because these get typed off a screen. */
export function generatePassword(length = 20): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
