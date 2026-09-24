// Developer services: the member's own connection, and the administrator's
// permission over it.
//
// The split is the point of this file. A person connects their own GitHub with
// their own token, in their own Workspace. An administrator decides who is
// permitted to do that at all — and never types a credential, because there is
// no installation-wide one to type.
//
// Two rules hold everywhere below:
//
//   * Permission is enforced on the WRITE, not by hiding a control. A screen
//     that omits a button is presentation; the route is the authorization.
//   * "Allowed" and "connected" are never conflated. An administrator looking
//     at a service that nobody uses has to be able to tell whether nobody
//     wanted it or nobody was permitted it.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, asSecret, deleteVaultSlot, loadMasterKey, openCredentialPayload, storeCredentialPayload,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  DEVELOPER_SERVICES, DEVELOPER_SERVICE_CATALOG, checkDeveloperToken, describeDeveloperService,
  discoverObsidianVaults, readObsidianNote,
  isDeveloperService, isPermissionMode, mayConnect, summarizeScope,
  type DeveloperService, type EffectiveScope, type PermissionMode,
} from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface DeveloperServiceCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the suites so no test reaches a real service. */
  fetchImpl?: typeof fetch;
}

class RouteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

function requireKey(ctx: DeveloperServiceCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable, so nothing can be saved securely.');
  }
}

interface PolicyRow { service: DeveloperService; mode: PermissionMode; note: string | null }

/** Every service's policy, with the named people attached.
 *
 * Read in one place so the member route and the admin route cannot disagree
 * about who is permitted. */
async function loadScopes(db: Db): Promise<Map<DeveloperService, EffectiveScope & { note: string | null }>> {
  const policies = await db.query<PolicyRow>(
    `select service, mode, note from developer_service_policy`,
  );
  const named = await db.query<{ service: DeveloperService; user_id: string }>(
    `select service, user_id from developer_service_allowed_users`,
  );
  const out = new Map<DeveloperService, EffectiveScope & { note: string | null }>();
  for (const service of DEVELOPER_SERVICES) {
    const policy = policies.find((p) => p.service === service);
    out.set(service, {
      // A service with no row has never been permitted, which is the same
      // answer as an explicit refusal rather than an error.
      mode: policy?.mode ?? 'not_allowed',
      note: policy?.note ?? null,
      allowedUserIds: named.filter((n) => n.service === service).map((n) => n.user_id),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the member

export function developerServiceRoutes(ctx: DeveloperServiceCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** What I may connect, and what I have connected. */
  r.get(
    '/',
    handle(async (req, res) => {
      const userId = req.user!.id;
      const scopes = await loadScopes(db);
      const mine = await db.query<{
        service: DeveloperService; account_label: string | null; status: string;
        last_check_at: string | null; last_check_ok: boolean | null; last_error: string | null;
        last_used_at: string | null;
      }>(
        `select service, account_label, status, last_check_at, last_check_ok, last_error, last_used_at
         from developer_connections where owner_user_id = $1`,
        [userId],
      );

      return res.json({
        services: DEVELOPER_SERVICE_CATALOG.map((d) => {
          const scope = scopes.get(d.service)!;
          const connection = mine.find((m) => m.service === d.service) ?? null;
          return {
            service: d.service,
            label: d.label,
            tokenLabel: d.tokenLabel,
            tokenHelp: d.tokenHelp,
            tokenUrl: d.tokenUrl,
            capability: d.capability,
            usernameLabel: d.usernameLabel ?? null,
            emailLabel: d.emailLabel ?? null,
            baseUrlLabel: d.baseUrlLabel ?? null,
            // Whether I MAY, kept separate from whether I HAVE.
            allowed: mayConnect(scope, userId),
            // The administrator's own words when they refused it, so a person
            // is told why by the person who decided rather than by a generic
            // "not available".
            note: scope.note,
            connection: connection
              ? {
                  accountLabel: connection.account_label,
                  status: connection.status,
                  lastCheckAt: connection.last_check_at,
                  lastCheckOk: connection.last_check_ok,
                  lastError: connection.last_error,
                  lastUsedAt: connection.last_used_at,
                }
              : null,
          };
        }),
      });
    }),
  );

  /** Obsidian is native filesystem discovery, never a Sync credential. */
  r.get('/obsidian-vaults', requireSuperAdmin, handle(async (_req, res) => {
    try {
      const vaults = await discoverObsidianVaults(process.env.JOSI_WORKSPACE_ROOT || '/workspace');
      return res.json({ available: true, vaults });
    } catch {
      return res.json({ available: false, vaults: [], detail: 'The Local Workspace mount is not available.' });
    }
  }));

  r.get('/obsidian-note', requireSuperAdmin, handle(async(req,res)=>{
    try{return res.json(await readObsidianNote(process.env.JOSI_WORKSPACE_ROOT||'/workspace',String(req.query.vault??''),String(req.query.note??'')));}
    catch{throw new RouteError(400,'That Markdown note is unavailable inside the selected vault.');}
  }));

  /** Connect, with my own token.
   *
   * The token is checked against the service before it is stored. Storing an
   * unverified credential would let somebody leave this screen believing they
   * had connected something. */
  r.put(
    '/:service',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
      const userId = req.user!.id;

      const scopes = await loadScopes(db);
      const scope = scopes.get(service)!;
      if (!mayConnect(scope, userId)) {
        // 403 with the administrator's reason where there is one. Not 404: the
        // service plainly exists, and pretending otherwise would send somebody
        // looking for a bug instead of asking their administrator.
        throw new RouteError(
          403,
          scope.note
            ? `An administrator has not permitted this service here. ${scope.note}`
            : 'An administrator has not permitted this service here.',
        );
      }

      const token = asSecret(req.body?.token);
      if (token.isEmpty) {
        const descriptor = describeDeveloperService(service)!;
        throw new RouteError(400, `a ${descriptor.tokenLabel.toLowerCase()} is required`);
      }

      const check = await checkDeveloperToken({
        service,
        // Revealed for this one request and nothing else: not stored in the
        // clear, not logged, not echoed back.
        token: token.reveal(),
        username: str(req.body?.username, 200),
        email: str(req.body?.email, 320),
        baseUrl: str(req.body?.baseUrl, 500),
        fetchImpl: ctx.fetchImpl,
      });
      if (!check.ok) {
        throw new RouteError(400, check.detail);
      }

      const stored = await storeCredentialPayload(db, requireKey(ctx), {
        ownerUserId:userId,kind:'api_key',service:`developer.${service}`,slot:'token',
        label:`${describeDeveloperService(service)!.label} credential`,payload:{token:token.reveal(),username:str(req.body?.username,200),email:str(req.body?.email,320),baseUrl:str(req.body?.baseUrl,500)},actorUserId:userId,
      });
      await db.query(
        `insert into developer_connections
           (owner_user_id, service, credentials_enc, account_label, status,
            last_check_at, last_check_ok, last_error)
         values ($1, $2, $3, $4, 'active', now(), true, null)
         on conflict (owner_user_id, service) do update set
           credentials_enc = excluded.credentials_enc,
           account_label = excluded.account_label,
           status = 'active', last_check_at = now(), last_check_ok = true, last_error = null`,
        [userId, service, stored, check.accountLabel ?? null],
      );
      await appendEvent(db, {
        actorUserId: userId,
        actor: 'member',
        kind: 'developer_service.connected',
        // Which service, never the token and never anything from inside the
        // account beyond the name the owner already sees.
        payload: { service },
      });
      return res.json({ ok: true, accountLabel: check.accountLabel ?? null });
    }),
  );

  /** Re-check my own connection. */
  r.post(
    '/:service/check',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
      const [row] = await db.query<{ credentials_enc: string | null }>(
        `select credentials_enc from developer_connections
         where owner_user_id = $1 and service = $2`,
        [req.user!.id, service],
      );
      if (!row?.credentials_enc) throw new RouteError(404, 'you have not connected that service');

      const opened = await openCredentialPayload<Record<string,string>>(db,requireKey(ctx),{ownerUserId:req.user!.id,service:`developer.${service}`,slot:'token',stored:row.credentials_enc});
      const check = await checkDeveloperToken({
        service, token: opened.token ?? '', username:opened.username, email:opened.email,
        baseUrl:opened.baseUrl, fetchImpl: ctx.fetchImpl,
      });
      await db.query(
        `update developer_connections
         set last_check_at = now(), last_check_ok = $1, last_error = $2,
             status = $3, account_label = coalesce($4, account_label)
         where owner_user_id = $5 and service = $6`,
        [
          check.ok,
          check.ok ? null : check.detail,
          check.ok ? 'active' : 'needs_reconnect',
          check.accountLabel ?? null,
          req.user!.id,
          service,
        ],
      );
      return res.json({ ok: check.ok, detail: check.detail });
    }),
  );

  /** Disconnect. The token goes with the row. */
  r.delete(
    '/:service',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
      await db.query(
        `delete from developer_connections where owner_user_id = $1 and service = $2`,
        [req.user!.id, service],
      );
      await deleteVaultSlot(db,{ownerUserId:req.user!.id,service:`developer.${service}`,slot:'token',actorUserId:req.user!.id});
      await appendEvent(db, {
        actorUserId: req.user!.id, actor: 'member',
        kind: 'developer_service.disconnected', payload: { service },
      });
      return res.status(204).end();
    }),
  );

  return r;
}

// ----------------------------------------------------------------- the admin

export function adminDeveloperServiceRoutes(ctx: DeveloperServiceCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** The permission for each service, and separately the health of whoever has
   * connected one.
   *
   * There is no credential field anywhere in this response and no route below
   * that accepts one. An administrator governs who may connect; the token is
   * the connecting person's own. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const scopes = await loadScopes(db);
      const people = await db.query<{ id: string; username: string; email: string }>(
        `select id, username, email from users where role in ('member', 'super_admin')
         order by username`,
      );
      const health = await db.query<{
        service: DeveloperService; owner_user_id: string; username: string;
        account_label: string | null; status: string;
        last_check_at: string | null; last_check_ok: boolean | null; last_error: string | null;
        last_used_at: string | null;
      }>(
        `select c.service, c.owner_user_id, u.username, c.account_label, c.status,
                c.last_check_at, c.last_check_ok, c.last_error, c.last_used_at
         from developer_connections c
         join users u on u.id = c.owner_user_id
         order by c.service, u.username`,
      );
      const nameById = new Map(people.map((p) => [p.id, p.username]));

      return res.json({
        // Everyone who could be named, for the selector. Username and email
        // only — enough to tell two people apart and nothing else.
        people: people.map((p) => ({ id: p.id, username: p.username, email: p.email })),
        services: DEVELOPER_SERVICE_CATALOG.map((d) => {
          const scope = scopes.get(d.service)!;
          const connections = health.filter((h) => h.service === d.service);
          return {
            service: d.service,
            label: d.label,
            capability: d.capability,
            // The permission.
            mode: scope.mode,
            allowedUserIds: scope.allowedUserIds,
            note: scope.note,
            summary: summarizeScope(
              scope,
              scope.allowedUserIds.map((id) => nameById.get(id) ?? 'someone removed'),
            ),
            // And, separately, who has actually connected. A service permitted
            // for everyone with nobody connected is a different fact from a
            // service nobody may connect, and the two must not be read off the
            // same number.
            connections: connections.map((c) => ({
              userId: c.owner_user_id,
              username: c.username,
              accountLabel: c.account_label,
              status: c.status,
              lastCheckAt: c.last_check_at,
              lastCheckOk: c.last_check_ok,
              lastError: c.last_error,
              lastUsedAt: c.last_used_at,
            })),
          };
        }),
      });
    }),
  );

  /** Set who may connect a service.
   *
   * Naming people does not connect anything for them, and un-naming somebody
   * does not delete what they already connected — it stops them using it, and
   * the connection row stays so that re-permitting them does not make them
   * paste a token again. Deleting somebody's credential is theirs to do. */
  r.put(
    '/:service',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');

      const mode = req.body?.mode;
      if (!isPermissionMode(mode)) {
        throw new RouteError(400, 'choose whether this is allowed, and for whom');
      }
      const note = str(req.body?.note, 500) || null;
      // Absent and empty are different requests. An absent `userIds` means
      // "leave the list as it is"; an empty array means "nobody", which is a
      // real choice an administrator part-way through selecting can make.
      const sentUserIds = Array.isArray(req.body?.userIds);
      const userIds: string[] = sentUserIds
        ? req.body.userIds.filter((v: unknown): v is string => typeof v === 'string').slice(0, 500)
        : [];

      // An empty list with `specific_users` is permitted and means nobody. It
      // is a real state — an administrator part-way through choosing — and
      // refusing it would force them to pick somebody they did not mean to.
      await db.query(
        `insert into developer_service_policy (service, mode, note, updated_at, updated_by)
         values ($1, $2, $3, now(), $4)
         on conflict (service) do update set
           mode = excluded.mode, note = excluded.note,
           updated_at = now(), updated_by = excluded.updated_by`,
        [service, mode, note, req.user!.id],
      );

      if (mode === 'specific_users' && sentUserIds) {
        // Replace the list rather than merge it: the request carries the whole
        // selection, and merging would make removing somebody impossible.
        const valid = userIds.length
          ? await db.query<{ id: string }>(
            `select id from users where id = any($1::uuid[])`, [userIds],
          )
          : [];
        await db.query(`delete from developer_service_allowed_users where service = $1`, [service]);
        for (const row of valid) {
          await db.query(
            `insert into developer_service_allowed_users (service, user_id) values ($1, $2)
             on conflict do nothing`,
            [service, row.id],
          );
        }
      }
      // Other modes, and a request that names no list at all, leave the stored
      // list alone on purpose: an administrator who switches to "everyone" and
      // back has not lost the list they built.

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'developer_service.policy_set',
        payload: { service, mode, namedCount: mode === 'specific_users' ? userIds.length : 0 },
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}
