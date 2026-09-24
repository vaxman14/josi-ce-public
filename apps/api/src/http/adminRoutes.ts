// The super admin's surface.
//
// Everything here configures the installation. Nothing here reads a member's
// private resource, and the tests assert that rather than trusting the comment.
import { Router } from 'express';
import { appendEvent, ensureWorkspace, getWorkspace, listEvents, updateWorkspace, type Db } from '@josi-ce/core';
import {
  UserError, createUser, generatePassword, issueAuthToken, listUsers, updateUser,
  listActiveSessions, revokeAllSessions, revokeSession,
} from '@josi-ce/auth';
import { asyncRoute, param } from './async.js';
import { requireSuperAdmin } from './authz.js';

export interface AdminRoutesCtx {
  db: Db;
  /** Where an invite link points. Set from the configured public URL. */
  appUrl: string;
}

export function adminRoutes(ctx: AdminRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  // ------------------------------------------------------------- workspace
  r.get('/workspace', asyncRoute(async (_req, res) => res.json({ workspace: await getWorkspace(db) })));

  r.post('/workspace/recover', asyncRoute(async (req, res) => {
    const existing = await getWorkspace(db);
    if (existing) return res.json({ workspace: existing, recovered: false });
    const [owner] = await db.query<{ username: string; display_name: string | null }>(
      `select username, display_name from users where role = 'super_admin' limit 1`,
    );
    const [deployment] = await db.query<{ domain: string | null }>(
      `select domain from deployment_config where id = true`,
    );
    await ensureWorkspace(db, { name: owner?.display_name || owner?.username || 'My workspace' });
    if (deployment?.domain) await updateWorkspace(db, { settings: { publicAddress: deployment.domain } });
    await appendEvent(db, {
      actorUserId: req.user!.id, actor: 'super_admin', kind: 'workspace.recovered',
      subjectType: 'workspace', payload: { source: 'existing setup data' },
    });
    return res.status(201).json({ workspace: await getWorkspace(db), recovered: true });
  }));

  r.patch(
    '/workspace',
    asyncRoute(async (req, res) => {
      const { name, timezone, settings } = (req.body ?? {}) as Record<string, unknown>;
      const workspace = await updateWorkspace(db, {
        name: typeof name === 'string' ? name : undefined,
        timezone: typeof timezone === 'string' ? timezone : undefined,
        settings: settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : undefined,
      });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'workspace.updated',
        payload: { fields: Object.keys(req.body ?? {}) },
      });
      return res.json({ workspace });
    }),
  );

  // ----------------------------------------------------------------- users
  r.get('/users', asyncRoute(async (_req, res) => res.json({ users: await listUsers(db) })));

  /** Invites a member. CE has no self-signup: every account is created here.
   *
   * The role is forced to `member`. A second super admin is impossible at the
   * database level anyway, but refusing it here means the API says something
   * useful instead of surfacing a constraint violation. */
  r.post(
    '/users',
    asyncRoute(async (req, res) => {
      const { email, username, displayName } = (req.body ?? {}) as Record<string, string>;
      if (!email || !username) return res.status(400).json({ error: 'email and username required' });

      let user;
      try {
        user = await createUser(db, { email, username, displayName, role: 'member' });
      } catch (err) {
        if (err instanceof UserError) return res.status(409).json({ error: err.message });
        throw err;
      }
      const { token } = await issueAuthToken(db, { userId: user.id, purpose: 'invite' });
      const link = `${ctx.appUrl}/set-password?token=${token}`;
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'user.invited',
        subjectType: 'user',
        subjectId: user.id,
      });
      // Mail is Phase 8. Until then the link is returned so an operator can
      // hand it over — which is why this endpoint is super-admin gated.
      return res.status(201).json({ user, inviteLink: link });
    }),
  );

  r.patch(
    '/users/:userId',
    asyncRoute(async (req, res) => {
      const { email, username, displayName, status } = (req.body ?? {}) as Record<string, string>;
      // The super admin cannot disable themselves and lock the installation.
      if (param(req, 'userId') === req.user!.id && status === 'disabled') {
        return res.status(409).json({ error: 'you cannot disable your own account' });
      }
      try {
        const user = await updateUser(db, param(req, 'userId'), {
          email, username, displayName,
          status: status as 'active' | 'disabled' | undefined,
        });
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'super_admin',
          kind: 'user.updated',
          subjectType: 'user',
          subjectId: user.id,
          payload: { fields: Object.keys(req.body ?? {}) },
        });
        return res.json({ user });
      } catch (err) {
        if (err instanceof UserError) return res.status(409).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.post(
    '/users/:userId/reset-link',
    asyncRoute(async (req, res) => {
      const rows = await db.query<{ id: string }>(`select id from users where id = $1`, [param(req, 'userId')]);
      if (!rows.length) return res.status(404).json({ error: 'no such user' });
      const { token } = await issueAuthToken(db, { userId: rows[0].id, purpose: 'reset' });
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'auth.reset_issued_by_admin',
        subjectType: 'user',
        subjectId: rows[0].id,
      });
      return res.json({ ok: true, link: `${ctx.appUrl}/set-password?token=${token}` });
    }),
  );

  // -------------------------------------------------------------- sessions
  r.get('/sessions', asyncRoute(async (_req, res) => res.json({ sessions: await listActiveSessions(db) })));

  r.delete(
    '/sessions/:sessionId',
    asyncRoute(async (req, res) => {
      await revokeSession(db, param(req, 'sessionId'));
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'session.revoked',
        subjectType: 'session', subjectId: param(req, 'sessionId'),
      });
      return res.json({ ok: true });
    }),
  );

  r.delete(
    '/users/:userId/sessions',
    asyncRoute(async (req, res) => {
      const n = await revokeAllSessions(db, param(req, 'userId'));
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'super_admin', kind: 'session.revoked_all',
        subjectType: 'user', subjectId: param(req, 'userId'), payload: { count: n },
      });
      return res.json({ ok: true, revoked: n });
    }),
  );

  // ------------------------------------------------------------- audit log
  r.get(
    '/events',
    asyncRoute(async (req, res) => {
      const events = await listEvents(db, {
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        limit: Number(req.query.limit) || 100,
      });
      return res.json({ events });
    }),
  );

  // Kept for the invite flow above; exported here so the import is used even
  // when mail is not yet wired.
  void generatePassword;
  return r;
}
