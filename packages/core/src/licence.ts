// Licences, and what a build is able to say about one.
//
// A licence is a short signed token the publisher issues. Verification is a
// signature check against a public key stamped into the artefact at build time
// — the same arrangement `BUILD_RELEASE_PUBLIC_KEY` uses for releases, and for
// the same reasons:
//
//   * It works on an installation with no route to the internet. A licence that
//     needs to phone home is a licence that stops working when the publisher's
//     service does, on an installation the operator runs precisely so that it
//     does not depend on somebody else's uptime.
//   * The key is public by definition, so nothing secret is shipped and nobody
//     is ever asked to paste a publisher secret. The operator's licence key is
//     theirs; the verification key is ours and is already in the image.
//
// A build with no stamped key cannot verify any licence. That is reported as
// what it is — this artefact cannot check — rather than by accepting an
// unverified licence or by pretending the feature does not exist.
import { createPublicKey, verify } from 'node:crypto';
import { BUILD_LICENCE_PUBLIC_KEY } from './buildStamp.js';

/** What a licence permits. One entry today; the shape is a list because a
 * second licensed feature must not mean a second licence format. */
export const LICENSED_FEATURES = ['parental_controls'] as const;
export type LicensedFeature = (typeof LICENSED_FEATURES)[number];

export interface LicencePayload {
  /** Who it was issued to, shown back to the operator so they can tell two
   * licences apart. Never used for a security decision. */
  subject: string;
  /** Which installation it is for, or null for a licence not bound to one. */
  installationId: string | null;
  features: LicensedFeature[];
  issuedAt: string;
  /** ISO date, or null for a perpetual licence. */
  expiresAt: string | null;
}

export type LicenceState =
  /** This artefact carries no publisher key, so it can check nothing. */
  | 'unverifiable_build'
  /** Nothing has been activated. */
  | 'none'
  | 'active'
  | 'expired'
  /** Correctly signed, but issued to a different installation. */
  | 'wrong_installation'
  /** Not signed by the publisher, or altered since it was. */
  | 'invalid';

export interface LicenceStatus {
  state: LicenceState;
  payload: LicencePayload | null;
  /** What the operator should read. Never a stack trace and never a hint about
   * how to forge one. */
  detail: string;
}

/** Whether this build can verify a licence at all. */
export function canVerifyLicences(key = BUILD_LICENCE_PUBLIC_KEY): boolean {
  return typeof key === 'string' && key.length > 0;
}

/** A licence token is `<base64url payload>.<base64url signature>`.
 *
 * Deliberately not a JWT: a JWT carries its own algorithm in a header that an
 * attacker controls, and the entire class of "alg: none" mistakes comes from
 * trusting it. There is exactly one algorithm here and the token cannot name a
 * different one.
 */
function decode(token: string): { payload: LicencePayload; signed: Buffer; signature: Buffer } | null {
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  try {
    const signed = Buffer.from(parts[0], 'base64url');
    const signature = Buffer.from(parts[1], 'base64url');
    if (!signed.length || signature.length !== 64) return null;
    const parsed = JSON.parse(signed.toString('utf8')) as LicencePayload;
    if (typeof parsed?.subject !== 'string' || !Array.isArray(parsed?.features)) return null;
    return { payload: parsed, signed, signature };
  } catch {
    return null;
  }
}

export interface VerifyOptions {
  /** This installation's own id, so a licence issued to another one is
   * refused rather than shared around. */
  installationId?: string | null;
  /** Injected by the tests. */
  now?: Date;
  publicKey?: string | null;
}

/** Check a licence token and say exactly what is true of it. */
export function verifyLicence(token: string, opts: VerifyOptions = {}): LicenceStatus {
  const key = opts.publicKey === undefined ? BUILD_LICENCE_PUBLIC_KEY : opts.publicKey;
  if (!canVerifyLicences(key)) {
    return {
      state: 'unverifiable_build',
      payload: null,
      detail:
        'This build carries no publisher verification key, so it cannot check a licence. '
        + 'Install the supported build published by SOCAL RECEPTIONIST LLC.',
    };
  }

  const decoded = decode(token);
  if (!decoded) {
    return { state: 'invalid', payload: null, detail: 'That is not a licence key Josi recognises.' };
  }

  let ok = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        // DER prefix for a raw Ed25519 public key, so the 32 bytes the
        // publisher stamps can be used directly without shipping a PEM.
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(key as string, 'base64'),
      ]),
      format: 'der',
      type: 'spki',
    });
    ok = verify(null, decoded.signed, publicKey, decoded.signature);
  } catch {
    ok = false;
  }

  if (!ok) {
    // One message for "not signed by us" and for "altered since". Telling the
    // two apart helps nobody but somebody probing the check.
    return {
      state: 'invalid',
      payload: null,
      detail: 'That licence key was not issued by SOCAL RECEPTIONIST LLC, or has been altered.',
    };
  }

  const payload = decoded.payload;

  // Bound licences are checked against this installation. Order matters: a
  // licence for somebody else is not "expired", and saying so would send the
  // operator to renew a licence that was never theirs.
  if (payload.installationId && opts.installationId && payload.installationId !== opts.installationId) {
    return {
      state: 'wrong_installation',
      payload,
      detail:
        'That licence was issued to a different installation. Each installation needs its own.',
    };
  }

  if (payload.expiresAt) {
    const expires = new Date(payload.expiresAt);
    const now = opts.now ?? new Date();
    if (Number.isFinite(expires.getTime()) && expires.getTime() <= now.getTime()) {
      return {
        state: 'expired',
        payload,
        // Still shown with its details: an expired licence is renewable, and
        // the operator needs to see which one to renew.
        detail: `That licence expired on ${expires.toISOString().slice(0, 10)}.`,
      };
    }
  }

  return { state: 'active', payload, detail: 'This installation is licensed.' };
}

/** Does an active licence cover this feature? */
export function licenceCovers(status: LicenceStatus, feature: LicensedFeature): boolean {
  return status.state === 'active' && !!status.payload?.features.includes(feature);
}

/** Where to get the supported build.
 *
 * Shown when the artefact cannot verify licences at all. A dead-end
 * explanation — "this build is unsupported" with nothing after it — is the
 * thing this replaces, so the route is precise enough to follow. */
export const SUPPORTED_BUILD_ROUTE = {
  publisher: 'SOCAL RECEPTIONIST LLC',
  image: 'ghcr.io/vaxman14/josi-ce:latest',
  docs: 'https://github.com/vaxman14/josi-ce-public/blob/main/docs/INSTALLATION.md',
  steps: [
    'Stop this installation with `docker compose down` (your data volumes are not touched).',
    'Set `JOSI_TAG=latest` in the installer directory, or point the Josi services at ghcr.io/vaxman14/josi-ce:latest.',
    'Run `docker compose pull` and then `docker compose up -d`.',
    'Open Admin → Parental controls again; the Activate licence form will be there.',
  ],
} as const;
