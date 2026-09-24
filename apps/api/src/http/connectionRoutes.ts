// Connected provider accounts.
//
// The OAuth flow itself is Phase 7. What exists here in Phase 1 is the
// authorization shape those routes will inherit, built against the real table
// so the isolation tests have something real to attack rather than a mock:
//
//   * a member sees only their own connections
//   * another member's connection is 404, not 403
//   * the super admin gets health metadata and never a credential or a scope
import { Router } from 'express';
import { appendEvent, resolveAccess, visibleResourceIds, type Db } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { accessorOf, assertMetadataOnly, requireAuth, requireOwnership, requireSuperAdmin } from './authz.js';

export interface ConnectionRoutesCtx {
  db: Db;
}

interface ConnectionRow {
  id: string;
  owner_user_id: string;
  provider: string;
  account_email: string | null;
  granted_scopes: string;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  created_at: string;
}

/** What the OWNER sees about their own connection. They may know their own
 * account address; they still never receive the sealed secret. */
function ownerView(row: ConnectionRow) {
  return {
    id: row.id,
    provider: row.provider,
    account: row.account_email,
    status: row.status,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    createdAt: row.created_at,
  };
}

/** What the SUPER ADMIN sees about somebody else's connection: whose it is and
 * whether it is working. Not the address, not the scopes, not the token.
 * Knowing a connection is unhealthy is administration; knowing which mailbox it
 * points at is content. */
function adminView(row: ConnectionRow) {
  const dto = {
    id: row.id,
    owner_user_id: row.owner_user_id,
    provider: row.provider,
    status: row.status,
    last_check_at: row.last_check_at,
    last_check_ok: row.last_check_ok,
    created_at: row.created_at,
  };
  assertMetadataOnly(dto);
  return dto;
}

export function connectionRoutes(ctx: ConnectionRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** Mine, and only mine. Built from the same visibility function the
   * per-resource guard uses, so a list and a fetch cannot disagree. */
  r.get(
    '/',
    asyncRoute(async (req, res) => {
      const ids = await visibleResourceIds(db, {
        type: 'connection',
        accessor: accessorOf(req.user!),
      });
      if (!ids.length) return res.json({ connections: [] });
      const rows = await db.query<ConnectionRow>(
        `select * from connections where id = any($1::uuid[]) order by provider`,
        [ids],
      );
      return res.json({ connections: rows.map(ownerView) });
    }),
  );

  r.get(
    '/:id',
    requireOwnership(ctx, { type: 'connection', need: 'read' }),
    asyncRoute(async (req, res) => {
      const rows = await db.query<ConnectionRow>(`select * from connections where id = $1`, [param(req, 'id')]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      return res.json({ connection: ownerView(rows[0]) });
    }),
  );

  /** Disconnecting is a write, so it needs write access — which for a
   * connection means being its owner, because connections are never shareable. */
  r.delete(
    '/:id',
    requireOwnership(ctx, { type: 'connection', need: 'write' }),
    asyncRoute(async (req, res) => {
      await db.query(`delete from connections where id = $1`, [param(req, 'id')]);
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'connection.disconnected',
        subjectType: 'connection',
        subjectId: param(req, 'id'),
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}

/** Mounted under the super-admin router. Health and ownership only.
 *
 * A super admin may also revoke a connection — that is administration, and the
 * canonical map allows it explicitly. What they may not do is read what the
 * connection can see. */
export function adminConnectionRoutes(ctx: ConnectionRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  r.get(
    '/',
    asyncRoute(async (_req, res) => {
      const rows = await db.query<ConnectionRow>(`select * from connections order by owner_user_id, provider`);
      return res.json({ connections: rows.map(adminView) });
    }),
  );

  r.post(
    '/:id/revoke',
    asyncRoute(async (req, res) => {
      // Deliberately does NOT go through requireOwnership: revocation is an
      // admin action on somebody else's connection by design. It removes
      // access; it never reads it.
      const rows = await db.query<{ id: string; owner_user_id: string }>(
        `update connections set status = 'revoked', secrets_enc = null where id = $1
         returning id, owner_user_id`,
        [param(req, 'id')],
      );
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'connection.revoked_by_admin',
        subjectType: 'connection',
        subjectId: rows[0].id,
        payload: { ownerUserId: rows[0].owner_user_id },
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}
