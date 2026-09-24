// Activating, replacing and removing the installation's licence.
//
// Two things the screen behind this must never do, both of which the previous
// state of the Parental Controls page did:
//
//   * Say "this installation is unlicensed" and stop. An explanation with no
//     action after it is a dead end, and the action here is entering a licence
//     key.
//   * Ask anybody to paste a publisher secret or edit a file inside the
//     container. The operator's licence key is theirs and goes in a form; the
//     verification key is the publisher's, is public, and is already in the
//     image.
//
// Every response re-verifies the stored token rather than trusting the cached
// state, so a licence that expired last night reads as expired this morning
// without anything having to run in between.
import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  SUPPORTED_BUILD_ROUTE, appendEvent, canVerifyLicences, getInstallId, verifyLicence,
  type Db, type LicenceStatus,
} from '@josi-ce/core';
import { asyncRoute } from './async.js';
import { requireSuperAdmin } from './authz.js';

export interface LicenceRoutesCtx {
  db: Db;
  /** Injected by the tests so a suite can stamp a key without rebuilding. */
  publicKey?: string | null;
}

class RouteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

/** The current licence, re-verified.
 *
 * Exported because the features a licence gates have to ask the same question
 * and must not answer it differently. */
export async function currentLicence(
  db: Db,
  publicKey?: string | null,
): Promise<LicenceStatus & { activatedAt: string | null }> {
  const [row] = await db.query<{ token: string; activated_at: string }>(
    `select token, activated_at from licence where id = true`,
  );
  if (!row) {
    // A build that cannot verify anything says so even with nothing activated:
    // the operator needs to know that entering a key here would not help.
    if (!canVerifyLicences(publicKey === undefined ? undefined : publicKey)) {
      return {
        state: 'unverifiable_build',
        payload: null,
        detail:
          'This build carries no publisher verification key, so it cannot check a licence. '
          + 'Install the supported build published by SOCAL RECEPTIONIST LLC.',
        activatedAt: null,
      };
    }
    return {
      state: 'none',
      payload: null,
      detail: 'No licence has been activated on this installation.',
      activatedAt: null,
    };
  }
  const status = verifyLicence(row.token, {
    installationId: await getInstallId(db),
    publicKey,
  });
  return { ...status, activatedAt: row.activated_at };
}

/** Refresh the cached verdict. The token is the authority; this only keeps the
 * stored copy honest so a listing does not have to re-verify. */
async function cache(db: Db, status: LicenceStatus): Promise<void> {
  await db.query(
    `update licence set last_state = $1, last_checked_at = now(), subject = $2, expires_at = $3
     where id = true`,
    [
      status.state === 'none' ? null : status.state,
      status.payload?.subject ?? null,
      status.payload?.expiresAt ?? null,
    ],
  );
}

function view(status: LicenceStatus & { activatedAt: string | null }) {
  return {
    state: status.state,
    detail: status.detail,
    activatedAt: status.activatedAt,
    // Shown so the operator can tell two licences apart and see what they have.
    // Never the token itself: it is what proves entitlement, and echoing it
    // back puts it in a screenshot.
    licence: status.payload
      ? {
          subject: status.payload.subject,
          installationId: status.payload.installationId,
          features: status.payload.features,
          issuedAt: status.payload.issuedAt,
          expiresAt: status.payload.expiresAt,
        }
      : null,
    /** Whether entering a key here could ever work. */
    canActivate: status.state !== 'unverifiable_build',
    /** Only when it could not. A dead-end explanation is what this replaces. */
    supportedBuild: status.state === 'unverifiable_build' ? SUPPORTED_BUILD_ROUTE : null,
  };
}

export function licenceRoutes(ctx: LicenceRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** What this installation is licensed for, right now. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const status = await currentLicence(db, ctx.publicKey);
      if (status.activatedAt) await cache(db, status);
      return res.json({
        ...view(status),
        installationId: await getInstallId(db),
      });
    }),
  );

  /** Activate or replace.
   *
   * One route for both: replacing is activating over the top, and a separate
   * "replace" would be the same code with a different name and one more state
   * for the screen to get wrong. */
  r.put(
    '/',
    handle(async (req, res) => {
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (!token) throw new RouteError(400, 'enter the licence key you were sent');
      if (token.length > 8192) throw new RouteError(400, 'that is too long to be a licence key');

      const installationId = await getInstallId(db);
      const status = verifyLicence(token, { installationId, publicKey: ctx.publicKey });

      // Only a licence that verifies is stored. Keeping a rejected one "so they
      // can retry" would leave the installation showing an invalid licence it
      // never accepted, and retrying is just entering it again.
      if (status.state !== 'active') {
        throw new RouteError(status.state === 'unverifiable_build' ? 409 : 400, status.detail);
      }

      const licenceId = createHash('sha256').update(token).digest('hex').slice(0, 32);
      await db.query(
        `with saved_licence as (
           insert into licence (id, token, last_state, last_checked_at, subject, expires_at,
                                activated_at, activated_by)
           values (true, $1, $2, now(), $3, $4, now(), $5)
           on conflict (id) do update set
             token = excluded.token, last_state = excluded.last_state,
             last_checked_at = now(), subject = excluded.subject,
             expires_at = excluded.expires_at, activated_at = now(),
             activated_by = excluded.activated_by
           returning id
         )
         , saved_entitlement as (
           insert into module_entitlements (
             module, license_token, license_id, issued_to, bound_install_id,
             issued_at, expires_at, activated_by, activated_at, revoked_at, revoked_by
           )
           select 'parental_controls', $1, $6, $3, $7, $8, $4, $5, now(), null, null
           from saved_licence
           where $9
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
             revoked_by = null
           returning module
         )
         update module_entitlements
         set revoked_at = now(), revoked_by = $5
         where module = 'parental_controls'
           and not $9
           and exists (select 1 from saved_licence)`,
        [
          token,
          status.state,
          status.payload?.subject ?? null,
          status.payload?.expiresAt ?? null,
          req.user!.id,
          licenceId,
          status.payload?.installationId ?? null,
          status.payload?.issuedAt ?? new Date().toISOString(),
          status.payload?.features.includes('parental_controls') ?? false,
        ],
      );

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'licence.activated',
        // What it covers and when it lapses. Never the token, and not the
        // licensee's name either: `assertMetadataOnly` refuses a `subject`
        // key, and it is right to — the audit log records that a licence was
        // activated, not who it names.
        payload: {
          features: status.payload?.features ?? [],
          expiresAt: status.payload?.expiresAt ?? null,
        },
      });
      if (status.payload?.features.includes('parental_controls')) {
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'super_admin',
          kind: 'entitlement.activated',
          subjectType: 'module',
          subjectId: 'parental_controls',
          payload: { bound: !!status.payload.installationId, expires: !!status.payload.expiresAt },
        });
      }

      const after = await currentLicence(db, ctx.publicKey);
      return res.json(view(after));
    }),
  );

  /** Deactivate.
   *
   * The row goes. An installation that has removed its licence is in the same
   * state as one that never had it, which is what "deactivated" has to mean if
   * the word is to be worth anything. */
  r.delete(
    '/',
    handle(async (req, res) => {
      await db.query(
        `with removed as (delete from licence where id = true returning id)
         update module_entitlements
         set revoked_at = now(), revoked_by = $1
         where module = 'parental_controls' and exists (select 1 from removed)`,
        [req.user!.id],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'licence.deactivated',
      });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'entitlement.revoked',
        subjectType: 'module',
        subjectId: 'parental_controls',
      });
      return res.status(204).end();
    }),
  );

  return r;
}
