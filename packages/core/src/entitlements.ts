// Paid modules.
//
// CE is AGPL and everything in it up to now is free, so this file is the first
// place the product says "no" for a commercial reason rather than a security
// one. That makes it worth being exact about what it is and what it is not.
//
// IT IS NOT A SECOND EDITION BOUNDARY. `edition.ts` decides what a BUILD may
// do, from a constant compiled into the artefact, and an operator can never
// widen it — because the things it governs (running a program on the host,
// using somebody's consumer subscription) would be wrong for a hosted build to
// do at all. Nothing here is like that. Parental Controls is not dangerous for
// the wrong operator to run; it is simply not free.
//
// SO THE HONEST SHAPE IS A LICENCE, AND THE HONEST STORAGE IS THE DATABASE.
// An operator buys, pastes a licence, and the module exists. The signature is
// what makes "bought" mean something: the publisher holds an Ed25519 private
// key, this build holds the public half, and a licence nobody signed does not
// verify. There is no environment variable, no setting and no route that turns
// the module on without one.
//
// AND THE FAILURE MODES ARE ALL "OFF"
//
//   * no row                    -> off, and the routes are 404
//   * unsigned or edited token  -> refused at activation, never stored
//   * expired                   -> off, by arithmetic, with no job to run
//   * revoked                   -> off
//   * database copied to another machine -> off, because the licence names an
//                                  installation and that name is re-checked
//   * a build with no stamped publisher key -> nothing can be activated at all,
//                                  and the screen says so rather than pretending
//
// The last one deserves its sentence. A source build stamps no key — exactly
// like `BUILD_RELEASE_PUBLIC_KEY` — so it cannot verify a licence and refuses
// every one. That is the truthful state for an artefact the publisher did not
// build: it can compile the module, and it cannot be sold one.
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { BUILD_LICENCE_PUBLIC_KEY } from './buildStamp.js';
import type { Db } from './db.js';
import { appendEvent } from './events.js';
import { getInstallId } from './workspace.js';

/** Modules that can be bought. One, and the database CHECK holds the same
 * list — a module added to one and not the other cannot be activated. */
export const PAID_MODULES = ['parental_controls'] as const;
export type PaidModule = (typeof PAID_MODULES)[number];

export function isPaidModule(value: unknown): value is PaidModule {
  return typeof value === 'string' && (PAID_MODULES as readonly string[]).includes(value);
}

/** The prefix every licence carries, and the bytes the signature covers start
 * with it. A payload signed for one purpose cannot be replayed as another. */
const TOKEN_PREFIX = 'josi-lic.1';

/** The fixed SPKI prefix for a raw Ed25519 public key. Written out rather than
 * pulled from a library, so "what exactly are we verifying against" has one
 * visible answer — the same reasoning as `verifySkillSignature`. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface LicenseClaim {
  v: 1;
  /** The publisher's own identifier for this licence. Shown in support. */
  licenseId: string;
  module: PaidModule;
  /** Who bought it, as the publisher wrote it. Shown on the admin screen. */
  issuedTo: string;
  /** Which installation, or null for a licence that names none. */
  installId: string | null;
  issuedAt: string;
  expiresAt: string | null;
}

export type LicenseVerdict =
  | { ok: true; claim: LicenseClaim }
  | { ok: false; reason: 'no_publisher_key' | 'malformed' | 'bad_signature' | 'unknown_module'; message: string };

const b64url = (raw: string): Buffer => Buffer.from(raw, 'base64url');

/**
 * Is this a licence this build will accept?
 *
 * Returns a verdict rather than throwing, because every caller has to say
 * something to somebody and none of them benefits from a stack trace. The
 * messages name the category and never the payload — an operator who pasted
 * half a token needs to know it was half a token, not to see it echoed.
 */
export function readLicense(token: string, publicKeyBase64: string | null): LicenseVerdict {
  if (!publicKeyBase64) {
    return {
      ok: false,
      reason: 'no_publisher_key',
      message: 'This build carries no publisher key, so it cannot check a licence. '
        + 'Paid modules are available on builds published by SOCAL RECEPTIONIST LLC.',
    };
  }
  const parts = String(token ?? '').trim().split('.');
  // josi-lic . 1 . payload . signature
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== TOKEN_PREFIX) {
    return { ok: false, reason: 'malformed', message: 'That does not look like a Josi licence key.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64url(parts[2]).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed', message: 'That licence key is damaged — copy it again, whole.' };
  }

  let verified = false;
  try {
    const raw = Buffer.from(publicKeyBase64, 'base64');
    if (raw.length !== 32) return { ok: false, reason: 'no_publisher_key', message: 'This build’s publisher key is not usable, so no licence can be checked.' };
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    verified = verifySignature(
      null,
      Buffer.from(`${TOKEN_PREFIX}.${parts[2]}`, 'utf8'),
      key,
      b64url(parts[3]),
    );
  } catch {
    verified = false;
  }
  // Checked BEFORE the payload is read for anything, so no field of an
  // unsigned document is ever trusted, displayed or stored.
  if (!verified) {
    return { ok: false, reason: 'bad_signature', message: 'That licence key is not signed by the publisher of this build.' };
  }

  const doc = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const module = str(doc.module);
  if (!isPaidModule(module)) {
    return { ok: false, reason: 'unknown_module', message: 'That licence is for a module this version does not have.' };
  }
  const licenseId = str(doc.licenseId).slice(0, 120);
  const issuedTo = str(doc.issuedTo).slice(0, 200);
  const issuedAt = str(doc.issuedAt);
  if (doc.v !== 1 || !licenseId || !issuedTo || Number.isNaN(Date.parse(issuedAt))) {
    return { ok: false, reason: 'malformed', message: 'That licence key is missing something it needs.' };
  }
  const expiresAtRaw = str(doc.expiresAt);
  if (expiresAtRaw && Number.isNaN(Date.parse(expiresAtRaw))) {
    return { ok: false, reason: 'malformed', message: 'That licence key has an expiry date nothing can read.' };
  }
  const installId = str(doc.installId);

  return {
    ok: true,
    claim: {
      v: 1,
      licenseId,
      module,
      issuedTo,
      installId: installId || null,
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null,
    },
  };
}

/** Why a module is or is not usable right now. `absent` is the state of every
 * fresh installation and every upgrade — nothing here is on by default. */
export type EntitlementState =
  | 'absent'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'wrong_installation';

export interface EntitlementStatus {
  module: PaidModule;
  state: EntitlementState;
  /** The one thing every caller actually branches on. */
  entitled: boolean;
  issuedTo: string | null;
  licenseId: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  /** True when the licence names an installation and it is this one. */
  boundToThisInstallation: boolean;
}

const ABSENT = (module: PaidModule): EntitlementStatus => ({
  module,
  state: 'absent',
  entitled: false,
  issuedTo: null,
  licenseId: null,
  expiresAt: null,
  activatedAt: null,
  boundToThisInstallation: false,
});

interface EntitlementRow {
  module: PaidModule;
  license_id: string;
  issued_to: string;
  bound_install_id: string | null;
  expires_at: string | null;
  activated_at: string;
  revoked_at: string | null;
}

/**
 * The question every parental surface asks first.
 *
 * Deliberately reads the database on every call rather than caching into a
 * module-level variable: an entitlement that lapses at midnight, or is revoked
 * by an administrator at 09:00, has to take effect on the next request and not
 * on the next restart. It is one indexed primary-key read.
 */
export async function entitlementStatus(
  db: Db,
  module: PaidModule,
  opts: { now?: Date } = {},
): Promise<EntitlementStatus> {
  const rows = await db.query<EntitlementRow>(
    `select module, license_id, issued_to, bound_install_id, expires_at, activated_at, revoked_at
     from module_entitlements where module = $1`,
    [module],
  );
  const row = rows[0];
  if (!row) return ABSENT(module);

  const base = {
    module,
    issuedTo: row.issued_to,
    licenseId: row.license_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    activatedAt: new Date(row.activated_at).toISOString(),
    boundToThisInstallation: false,
  };

  if (row.revoked_at) return { ...base, state: 'revoked', entitled: false };

  const now = opts.now ?? new Date();
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ...base, state: 'expired', entitled: false };
  }

  // A licence bound to an installation is checked against THIS installation on
  // every read. A restored backup on somebody else's machine carries the row
  // and does not carry the entitlement.
  if (row.bound_install_id) {
    const installId = await getInstallId(db);
    if (installId !== row.bound_install_id) {
      return { ...base, state: 'wrong_installation', entitled: false };
    }
    return { ...base, state: 'active', entitled: true, boundToThisInstallation: true };
  }

  return { ...base, state: 'active', entitled: true };
}

export type ActivationRefusal =
  | 'no_publisher_key'
  | 'malformed'
  | 'bad_signature'
  | 'unknown_module'
  | 'expired'
  | 'wrong_installation';

export type ActivationResult =
  | { ok: true; status: EntitlementStatus }
  | { ok: false; reason: ActivationRefusal; message: string };

/**
 * Turn a pasted licence into an entitlement, or refuse it with a sentence.
 *
 * Everything is checked before anything is written: signature, module, expiry,
 * and the installation the licence names. A refused licence leaves no row, so
 * "activated" and "usable" cannot come apart.
 */
export async function activateEntitlement(
  db: Db,
  args: {
    module: PaidModule;
    token: string;
    publicKey: string | null;
    actorUserId: string;
    now?: Date;
  },
): Promise<ActivationResult> {
  const verdict = readLicense(args.token, args.publicKey);
  if (!verdict.ok) {
    await appendEvent(db, {
      actorUserId: args.actorUserId,
      actor: 'super_admin',
      kind: 'entitlement.refused',
      subjectType: 'module',
      subjectId: args.module,
      payload: { reason: verdict.reason },
    });
    return { ok: false, reason: verdict.reason, message: verdict.message };
  }
  const claim = verdict.claim;
  if (claim.module !== args.module) {
    return { ok: false, reason: 'unknown_module', message: 'That licence is for a different module.' };
  }

  const now = args.now ?? new Date();
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired', message: 'That licence has already expired.' };
  }

  const installId = await getInstallId(db);
  if (claim.installId && claim.installId !== installId) {
    return {
      ok: false,
      reason: 'wrong_installation',
      message: 'That licence was issued to a different installation of Josi.',
    };
  }

  await db.query(
    `insert into module_entitlements
       (module, license_token, license_id, issued_to, bound_install_id, issued_at, expires_at, activated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (module) do update set
       license_token = excluded.license_token,
       license_id = excluded.license_id,
       issued_to = excluded.issued_to,
       bound_install_id = excluded.bound_install_id,
       issued_at = excluded.issued_at,
       expires_at = excluded.expires_at,
       activated_by = excluded.activated_by,
       activated_at = now(),
       revoked_at = null,
       revoked_by = null`,
    [
      claim.module, args.token.trim(), claim.licenseId, claim.issuedTo,
      claim.installId, claim.issuedAt, claim.expiresAt, args.actorUserId,
    ],
  );

  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'entitlement.activated',
    subjectType: 'module',
    subjectId: claim.module,
    // The licence id and the buyer's name are what a support conversation
    // needs. The token itself is never written to the trail.
    payload: { licenseId: claim.licenseId, bound: !!claim.installId, expires: !!claim.expiresAt },
  });

  return { ok: true, status: await entitlementStatus(db, args.module, { now }) };
}

/** Switch a module off without forgetting it was ever on. */
export async function revokeEntitlement(
  db: Db,
  args: { module: PaidModule; actorUserId: string },
): Promise<EntitlementStatus> {
  await db.query(
    `update module_entitlements set revoked_at = now(), revoked_by = $2
     where module = $1 and revoked_at is null`,
    [args.module, args.actorUserId],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'entitlement.revoked',
    subjectType: 'module',
    subjectId: args.module,
  });
  return entitlementStatus(db, args.module);
}

/** The publisher key this process will check licences against.
 *
 * A function rather than a re-export so that the ONE place a key can enter is
 * greppable, and so the API can pass an injected key in tests without any
 * production path reading an environment variable. */
export function publisherKey(override?: string | null): string | null {
  return override === undefined ? BUILD_LICENCE_PUBLIC_KEY : override;
}
