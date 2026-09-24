import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = `${APPLE_ISSUER}/auth/keys`;

type AppleJwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
type AppleClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nonce?: unknown;
  email?: unknown;
  email_verified?: unknown;
  is_private_email?: unknown;
};

const jwksCache = new WeakMap<object, { expiresAt: number; keys: AppleJwk[] }>();

async function appleKeys(fetchImpl: typeof fetch, force = false): Promise<AppleJwk[]> {
  const cached = jwksCache.get(fetchImpl);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetchImpl(APPLE_KEYS_URL, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Apple identity verification unavailable');
  const body = await response.json() as { keys?: AppleJwk[] };
  if (!Array.isArray(body.keys)) throw new Error('Apple identity verification unavailable');
  jwksCache.set(fetchImpl, { expiresAt: Date.now() + 60 * 60 * 1000, keys: body.keys });
  return body.keys;
}

export type VerifiedAppleIdentity = {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  privateRelay: boolean;
};

function decodeJson(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid Apple token');
  const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('invalid Apple token');
  return value as Record<string, unknown>;
}

function safeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function truthyClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function verifyAppleIdentityToken(args: {
  token: string;
  nonce: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<VerifiedAppleIdentity> {
  const parts = args.token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('invalid Apple token');
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]) as AppleClaims;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid Apple token');

  const fetchImpl = args.fetchImpl ?? fetch;
  let keys = await appleKeys(fetchImpl);
  let jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  if (!jwk) {
    keys = await appleKeys(fetchImpl, true);
    jwk = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  }
  if (!jwk) throw new Error('invalid Apple token');
  const valid = verifySignature(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk as any, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) throw new Error('invalid Apple token');

  const now = args.now ?? Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const expectedNonce = createHash('sha256').update(args.nonce).digest('hex');
  if (claims.iss !== APPLE_ISSUER
      || !audience.includes(args.clientId)
      || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255
      || typeof claims.exp !== 'number' || claims.exp <= now
      || typeof claims.iat !== 'number' || claims.iat > now + 60
      || typeof claims.nonce !== 'string' || !safeTextEqual(claims.nonce, expectedNonce)) {
    throw new Error('invalid Apple token');
  }

  const emailVerified = truthyClaim(claims.email_verified);
  const email = emailVerified && typeof claims.email === 'string' && claims.email.length <= 320
    ? claims.email.trim().toLowerCase()
    : null;
  return {
    subject: claims.sub,
    email,
    emailVerified,
    privateRelay: truthyClaim(claims.is_private_email),
  };
}
