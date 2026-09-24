// Managing contact synchronisation.
//
// Everything here is the signed-in user's own. There is no route that takes an
// owner id, and every function called below resolves ownership from the
// ORIGIN or the CONNECTION rather than from anything in the request — so a
// guessed id fails on ownership rather than on a check somebody might forget
// to write.
//
// Nothing here is reachable by an administrator on somebody else's behalf.
// Contact sync moves a person's address book; an admin who could start it
// could read it.
import { Router } from 'express';
import {
  SyncError, keepSeparate, listOrigins, mergeContacts, setSyncInterval, setSyncMode, stopSync,
  syncOrigin, type SyncMode,
} from '@josi-ce/connectors';
import { loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth } from './authz.js';

export interface ContactSyncCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  connectorFetch?: typeof fetch;
}

const MODES: SyncMode[] = ['import_only', 'two_way'];

export function contactSyncRoutes(ctx: ContactSyncCtx): Router {
  const r = Router();
  const { db } = ctx;

  // Every route below reads `req.user`. Without this the handler runs for an
  // anonymous caller and fails on the undefined, which answers 500 — a
  // response that says "something broke here" to somebody who should have been
  // told "no". Caught by the anonymous sweep in the wire tests.
  r.use(requireAuth);

  function masterKey() {
    if (ctx.masterKey === false) throw new SyncError('this installation cannot open stored credentials right now');
    return loadMasterKey(ctx.masterKey ?? {});
  }

  /** Turn a SyncError into an answer, and anything else into a 500. */
  const guard = (fn: (req: any, res: any) => Promise<unknown>) =>
    asyncRoute(async (req, res) => {
      try {
        return await fn(req, res);
      } catch (err) {
        if (err instanceof SyncError) {
          // 404 rather than 403 for an id that is not theirs: confirming that
          // somebody else's connection exists is itself a disclosure.
          const status = /belongs to somebody else|no such/.test(err.message) ? 404
            : err.category === 'insufficient_scope' ? 409
            : 400;
          return res.status(status).json({ error: err.message, category: err.category });
        }
        throw err;
      }
    });

  /** Where each connected account stands. Counts and status, never a contact. */
  r.get(
    '/sync',
    guard(async (req, res) => {
      const origins = await listOrigins(db, req.user!.id);
      return res.json({
        origins: origins.map((o) => ({
          id: o.id,
          connectionId: o.connection_id,
          provider: o.provider,
          sourceAccount: o.source_account,
          syncMode: o.sync_mode,
          status: o.status,
          lastSyncAt: o.last_sync_at,
          lastErrorCategory: o.last_error_category,
          counts: o.last_sync_counts,
          intervalSeconds: o.sync_interval_seconds,
          // A cursor is an opaque provider token; its presence is the only
          // useful part and the value is nobody's business.
          incremental: !!o.delta_cursor,
        })),
      });
    }),
  );

  /** Start syncing an account, or change how. */
  r.put(
    '/sync/:connectionId',
    guard(async (req, res) => {
      const mode = String(req.body?.mode ?? '');
      if (!MODES.includes(mode as SyncMode)) {
        return res.status(400).json({ error: 'choose import_only or two_way' });
      }
      const origin = await setSyncMode(db, {
        connectionId: param(req, 'connectionId'),
        ownerUserId: req.user!.id,
        mode: mode as SyncMode,
      });
      return res.json({ origin: { id: origin.id, syncMode: origin.sync_mode, status: origin.status } });
    }),
  );

  /** How often this account is synced without being asked.
   *
   * Per origin rather than global: a provider rate-limiting one account must
   * not slow another down, and an hourly Outlook alongside a five-minute
   * Google is a reasonable thing to want. */
  r.put(
    '/sync/:originId/interval',
    guard(async (req, res) => {
      await setSyncInterval(db, {
        originId: param(req, 'originId'),
        ownerUserId: req.user!.id,
        seconds: Number(req.body?.seconds),
      });
      return res.json({ ok: true });
    }),
  );

  /** Sync now. */
  r.post(
    '/sync/:originId/run',
    guard(async (req, res) => {
      const origins = await listOrigins(db, req.user!.id);
      const origin = origins.find((o) => o.id === param(req, 'originId'));
      if (!origin) return res.status(404).json({ error: 'no such contact sync origin' });

      const result = await syncOrigin(db, origin.id, {
        masterKey: masterKey(),
        fetchImpl: ctx.connectorFetch,
      });
      return res.json({
        status: result.status,
        counts: result.counts,
        wasFullResync: result.wasFullResync,
        // Suggestions only. Nothing here has been applied.
        needsReview: result.needsReview,
      });
    }),
  );

  /** Stop syncing. Deletes nothing, here or at the provider. */
  r.post(
    '/sync/:originId/stop',
    guard(async (req, res) => {
      const result = await stopSync(db, { originId: param(req, 'originId'), ownerUserId: req.user!.id });
      return res.json({
        stopped: true,
        contactsKept: result.contactsKept,
        note: 'Contacts already imported are kept, and nothing was changed at the provider.',
      });
    }),
  );

  /** Two contacts are the same person. */
  r.post(
    '/merge',
    guard(async (req, res) => {
      const keepId = String(req.body?.keepId ?? '');
      const mergeId = String(req.body?.mergeId ?? '');
      if (!keepId || !mergeId || keepId === mergeId) {
        return res.status(400).json({ error: 'two different contacts are needed' });
      }
      await mergeContacts(db, { ownerUserId: req.user!.id, keepId, mergeId });
      return res.json({ merged: true });
    }),
  );

  /** They are not, and stop asking. */
  r.post(
    '/keep-separate',
    guard(async (req, res) => {
      const a = String(req.body?.contactA ?? '');
      const b = String(req.body?.contactB ?? '');
      if (!a || !b || a === b) return res.status(400).json({ error: 'two different contacts are needed' });

      // Ownership is checked HERE rather than trusted, because unlike merge
      // this writes a row keyed only by ids.
      const rows = await db.query<{ id: string }>(
        `select id from contacts where id in ($1, $2) and owner_user_id = $3`,
        [a, b, req.user!.id],
      );
      if (rows.length !== 2) return res.status(404).json({ error: 'no such contact' });

      await keepSeparate(db, { ownerUserId: req.user!.id, contactA: a, contactB: b });
      return res.json({ ok: true });
    }),
  );

  return r;
}
