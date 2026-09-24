// Connecting a Google or Microsoft account.
//
// Four things this surface must get right, and each has a test attacking it:
//
//   * A connection belongs to one person. Another member's is 404, and the
//     super admin's view is health metadata — never the address, never the
//     scopes, never a token.
//   * Turning on a write capability the provider never granted is refused and
//     sends the person back through consent (M32), rather than storing a wish.
//   * The admin ceiling can only deny. There is no code path here that grants.
//   * The callback believes the stored handshake, not the query string.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, asSecret, loadMasterKey, type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  CAPABILITIES, CapabilityError, ConnectorError, NoClientError, NEXTCLOUD_STORAGE_CAPABILITY,
  OAUTH_PROVIDERS, STORAGE_CAPABILITY, isOAuthProvider,
  accessTokenFor, buildAuthUrl, can, capabilitySpec, capabilityViews, clientStatuses, connectNextcloud,
  connectionFor, connectionsFor, createStateStore, deleteClient, deleteConnection, exchangeCode, fetchIdentity, getConnection,
  listFolderPage, listNextcloudFolder, loadClient, nextcloudCredentialsFor, normalizeServerUrl,
  refusalReason, revokeAtProvider, safeReturnPath, saveClient, scopesFor, setCapability, upsertConnection,
  verifyWebdavCredentials,
  type EntryPage, type OAuthProvider, type Provider,
} from '@josi-ce/connectors';
import { openCredentialPayload } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface ConnectorRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the tests. No suite contacts Google, Microsoft, Dropbox, Box
   * or any Nextcloud server. */
  fetchImpl?: typeof fetch;
  appUrl: string;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// The OAuth handshake routes (/start, /callback) and the admin client console
// only ever meant these four — Nextcloud has no handshake and no client to
// register, so it is never one of them. `ALL_PROVIDERS` is the wider list used
// by the routes that read or list connections generically.
const PROVIDERS: readonly OAuthProvider[] = OAUTH_PROVIDERS;
const ALL_PROVIDERS: readonly Provider[] = [...OAUTH_PROVIDERS, 'nextcloud'];

/** The storage capability for whichever of the five providers this is —
 * mirrors `storageCapabilityFor` in storageSync.ts, kept local because this
 * file does not otherwise need the OAuth/WebDAV session split that function
 * lives next to. */
function storageCapabilityFor(provider: Provider): string {
  return isOAuthProvider(provider) ? STORAGE_CAPABILITY[provider] : NEXTCLOUD_STORAGE_CAPABILITY;
}

async function canonicalDeployment(db: Db, fallback: string): Promise<{ origin: string; publicHttpsBase: string | null }> {
  const configured = fallback.replace(/\/$/, '');
  let publicOrigin: string | null = null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(configured);
  } catch { /* malformed APP_URL falls back to the stored installation state */ }
  if (parsed?.protocol === 'https:' && parsed.hostname !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)) {
    publicOrigin = parsed.origin;
  }
  const [deployment] = await db.query<{ domain: string }>(
    `select domain from deployment_config where id = true`,
  );
  const domain = deployment?.domain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const origin = publicOrigin ?? (domain ? `https://${domain}` : configured);
  const publicHttpsBase = publicOrigin ?? (domain && domain !== 'localhost' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) ? `https://${domain}` : null);
  return { origin, publicHttpsBase };
}

/** For the handshake routes only — /start and /callback exist for OAuth
 * providers alone. Nextcloud's own connect route below checks its own
 * arguments; there is no `provider` path segment for it to validate. */
function isOAuthRouteProvider(value: string): value is OAuthProvider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function requireKey(ctx: ConnectorRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable');
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof NoClientError) return res.status(409).json({ error: err.message });
      if (err instanceof CapabilityError) {
        return res.status(409).json({ error: err.message, state: err.state });
      }
      if (err instanceof ConnectorError) {
        // A category and a sentence. Never the provider's body.
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

// ------------------------------------------------------------------ member

export function connectorRoutes(ctx: ConnectorRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** What I have connected, and what each connection may do. */
  r.get(
    '/',
    handle(async (req, res) => {
      const clients = await clientStatuses(db);
      const out = [];
      for (const provider of ALL_PROVIDERS) {
        const connections = await connectionsFor(db, { ownerUserId: req.user!.id, provider });
        const connection = connections[0] ?? null;
        const view = async (item: typeof connection) => {
          if (!item) return null;
          const capabilities = await capabilityViews(db, { connection: item, provider });
          return {
            id: item.id,
            account: item.account_email,
            status: item.status,
            lastCheckAt: item.last_check_at,
            lastCheckOk: item.last_check_ok,
            errorCategory: item.last_error_category,
            createdAt: item.created_at,
            serverUrl: item.meta?.serverUrl ?? null,
            capabilities,
            needsPermissionUpgrade: isOAuthProvider(provider)
              ? capabilities.some((capability) => capability.needsConsent)
              : false,
          };
        };
        out.push({
          provider,
          // Whether an administrator has set this installation's application up.
          // Nextcloud has no application to register — it is always "available",
          // because the thing that would make it unavailable (no client
          // configured) does not apply to a provider with no client at all.
          available: provider === 'nextcloud'
            ? true
            : clients.find((c) => c.provider === provider)?.configured ?? false,
          connection: await view(connection),
          connections: await Promise.all(connections.map(view)),
          capabilities: await capabilityViews(db, { connection, provider }),
        });
      }
      // `connections` is the Phase 1 contract and stays: that suite asserts a
      // member sees only their own, and the claim is as true now as it was
      // then. Phase 7 adds `providers` alongside it rather than renaming it —
      // a passing test that stopped covering anything would be worse than a
      // failing one.
      return res.json({
        connections: out.map((p) => p.connection).filter(Boolean),
        providers: out,
      });
    }),
  );

  /** One connection, to its owner.
   *
   * Also Phase 1's contract: 404 for anyone else, 404 for a malformed id, and
   * never the sealed credential. Kept as a route rather than folded into the
   * list because those tests attack it directly. */
  r.get(
    '/:id',
    handle(async (req, res) => {
      const id = param(req, 'id');
      // A malformed id is "not found", never a query.
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new RouteError(404, 'not found');
      const connection = await getConnection(db, id);
      if (!connection || connection.owner_user_id !== req.user!.id) {
        throw new RouteError(404, 'not found');
      }
      return res.json({
        connection: {
          id: connection.id,
          provider: connection.provider,
          account: connection.account_email,
          status: connection.status,
          lastCheckAt: connection.last_check_at,
          lastCheckOk: connection.last_check_ok,
          errorCategory: connection.last_error_category,
          createdAt: connection.created_at,
        },
        capabilities: await capabilityViews(db, { connection, provider: connection.provider }),
      });
    }),
  );

  /** The folders inside a connected account, for choosing one to map.
   *
   * Owner-only and 404 for anyone else, like every connection route. The
   * listing is live and nothing about it is stored: browsing is not mapping,
   * and until a mapping exists with consent recorded, Josi keeps nothing.
   * Requires the storage capability to be ON — not merely granted — so a
   * person who granted the scope but left the switch off is not browsed. */
  r.get(
    '/:id/storage/folders',
    handle(async (req, res) => {
      const id = param(req, 'id');
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new RouteError(404, 'not found');
      const connection = await getConnection(db, id);
      if (!connection || connection.owner_user_id !== req.user!.id) {
        throw new RouteError(404, 'not found');
      }

      const capability = storageCapabilityFor(connection.provider);
      const verdict = await can(db, { ownerUserId: req.user!.id, capability });
      if (!verdict.allowed) {
        return res.status(409).json({
          error: refusalReason(verdict.state, capability),
          state: verdict.state,
        });
      }

      // 'root' is every provider's own alias for the top of the account. A
      // mapping still has to name a real folder — M46 forbids "map my whole
      // Drive" — but browsing starts somewhere.
      const listArgs = {
        folderId: str(req.query.parent, 250) || 'root',
        pageCursor: str(req.query.cursor, 2000) || null,
      };

      let page: EntryPage;
      if (isOAuthProvider(connection.provider)) {
        const key = requireKey(ctx);
        const client = await loadClient(db, key, connection.provider);
        const accessToken = await accessTokenFor(db, key, { connection, client }, { fetchImpl: ctx.fetchImpl });
        page = await listFolderPage(connection.provider, { accessToken, ...listArgs }, { fetchImpl: ctx.fetchImpl });
      } else {
        const key = requireKey(ctx);
        const creds = await nextcloudCredentialsFor(db, key, connection);
        page = await listNextcloudFolder(creds, listArgs, { fetchImpl: ctx.fetchImpl });
      }

      return res.json({
        folders: page.entries.filter((e) => e.folder).map((e) => ({ id: e.sourceId, name: e.name })),
        nextPageCursor: page.nextPageCursor,
      });
    }),
  );

  /** Begin a handshake. Returns the URL rather than redirecting, so the client
   * decides when to leave the page and the response stays inspectable. */
  r.post(
    '/:provider/start',
    handle(async (req, res) => {
      const provider = param(req, 'provider');
      if (!isOAuthRouteProvider(provider)) throw new RouteError(404, 'no such provider');
      const key = requireKey(ctx);
      const client = await loadClient(db, key, provider);

      // OAuth consent is account-level. New connections and legacy upgrades
      // request the complete bundle supported by this provider once. Local
      // capability switches remain off until their owner enables them, so a
      // broad provider grant is not permission for Josi to act.
      const capabilities = CAPABILITIES
        .filter((c) => c.provider === provider)
        .map((c) => c.key);

      const store = createStateStore(db, key);
      const targetConnectionId = str(req.body?.connectionId, 80) || null;
      if (targetConnectionId) {
        const target = await getConnection(db, targetConnectionId);
        if (!target || target.owner_user_id !== req.user!.id || target.provider !== provider) {
          throw new RouteError(404, 'connection not found');
        }
      }
      const scopes = scopesFor(provider, capabilities);
      const { state, challenge } = await store.start({
        userId: req.user!.id,
        sessionId: req.user!.session_id,
        provider,
        capabilities,
        scopes,
        returnPath: safeReturnPath(req.body?.returnPath),
        targetConnectionId,
      });

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'user',
        kind: 'connection.handshake_started',
        payload: { provider, capabilities },
      });

      return res.json({
        url: buildAuthUrl(client, { state, scopes, codeChallenge: challenge }),
        capabilities,
      });
    }),
  );

  /** The provider sends the browser back here.
   *
   * Everything trusted comes from the stored handshake. The query string
   * supplies exactly two things: the state to look up, and the code to
   * exchange. */
  r.get(
    '/:provider/callback',
    handle(async (req, res) => {
      const provider = param(req, 'provider');
      if (!isOAuthRouteProvider(provider)) throw new RouteError(404, 'no such provider');

      const fail = (reason: string) =>
        res.redirect(`/app/connections?error=${encodeURIComponent(reason)}`);

      // The provider itself can refuse — a person clicking "cancel" lands here.
      if (typeof req.query.error === 'string') {
        await appendEvent(db, {
          actorUserId: req.user?.id ?? null,
          actor: 'user',
          kind: 'connection.handshake_declined',
          payload: { provider },
        });
        return fail('declined');
      }

      const key = requireKey(ctx);
      const store = createStateStore(db, key);
      const consumed = await store.consume({
        state: String(req.query.state ?? ''),
        provider,
        sessionId: req.user?.session_id ?? null,
      });
      if (!consumed.ok) {
        await appendEvent(db, {
          actorUserId: req.user?.id ?? null,
          actor: 'system',
          kind: 'connection.handshake_refused',
          payload: { provider, reason: consumed.reason },
        });
        return fail(consumed.reason);
      }

      const handshake = consumed.handshake;
      const client = await loadClient(db, key, provider);
      const code = String(req.query.code ?? '');
      if (!code) return fail('no_code');

      let tokens;
      try {
        tokens = await exchangeCode(
          client,
          { code, verifier: handshake.verifier, scopes: handshake.scopes },
          { fetchImpl: ctx.fetchImpl },
        );
      } catch (err) {
        const category = err instanceof ConnectorError ? err.category : 'provider_error';
        await appendEvent(db, {
          actorUserId: handshake.userId,
          actor: 'system',
          kind: 'connection.exchange_failed',
          payload: { provider, category },
        });
        return fail(category);
      }

      // Who the tokens belong to. Best effort: a provider that will not say is
      // not a reason to refuse a working connection.
      let identity = { accountId: null as string | null, email: null as string | null };
      try {
        identity = await fetchIdentity(provider, tokens.accessToken, { fetchImpl: ctx.fetchImpl });
      } catch {
        identity = { accountId: null, email: null };
      }

      const existingConnection = handshake.targetConnectionId
        ? await getConnection(db, handshake.targetConnectionId)
        : null;
      await upsertConnection(db, key, {
        // From the STORED handshake, never from the session on this request and
        // never from the query string.
        ownerUserId: handshake.userId,
        provider,
        tokens,
        accountEmail: identity.email,
        providerAccountId: identity.accountId,
        targetConnectionId: handshake.targetConnectionId,
        requestedCapabilities: handshake.capabilities,
        // Provider consent never enables additional local write capabilities.
        enableRequestedCapabilities: false,
      });

      return res.redirect(handshake.returnPath);
    }),
  );

  /** Turn a capability on or off. */
  r.put(
    '/:id/capabilities/:capability',
    handle(async (req, res) => {
      const connection = await getConnection(db, param(req, 'id'));
      // Not yours and does not exist answer identically.
      if (!connection || connection.owner_user_id !== req.user!.id) {
        throw new RouteError(404, 'not found');
      }
      const views = await setCapability(db, {
        connection,
        capability: param(req, 'capability'),
        enabled: req.body?.enabled === true,
        actorUserId: req.user!.id,
      });
      return res.json({ capabilities: views });
    }),
  );

  r.delete(
    '/:id',
    handle(async (req, res) => {
      const connection = await getConnection(db, param(req, 'id'));
      if (!connection || connection.owner_user_id !== req.user!.id) {
        throw new RouteError(404, 'not found');
      }

      // Withdraw local authority before awaiting a remote revocation request.
      await db.query(`update connections set status='revoked' where id=$1`,[connection.id]);
      let note: string | undefined;
      // Nextcloud has no OAuth revoke endpoint to call — there is no client to
      // load and no token to revoke, only a WebDAV app password whose owner
      // withdraws it in their own Nextcloud account. Deleting Josi's copy is
      // the whole of what this route can do for that provider, exactly the
      // honest half-measure Microsoft's disconnect already documents above.
      if (connection.secrets_enc && isOAuthProvider(connection.provider)) {
        try {
          const key = requireKey(ctx);
          const client = await loadClient(db, key, connection.provider);
          const secrets = await openCredentialPayload<{ refreshToken: string | null }>(db,key,{ownerUserId:connection.owner_user_id,service:`connector.${connection.provider}`,slot:connection.id,stored:connection.secrets_enc});
          if (secrets.refreshToken) {
            const result = await revokeAtProvider(client, secrets.refreshToken, { fetchImpl: ctx.fetchImpl });
            note = result.note;
          }
        } catch {
          // Our copy goes regardless. A provider we cannot reach must never
          // stop somebody disconnecting.
          note = 'Josi deleted its copy of the tokens but could not reach the provider to revoke them.';
        }
      } else if (connection.provider === 'nextcloud') {
        note = 'Josi deleted its copy of the app password. To withdraw it entirely, remove it in your '
          + 'Nextcloud account under Settings → Security → Devices & sessions.';
      }

      await deleteConnection(db, {
        connectionId: connection.id, actorUserId: req.user!.id, actor: 'user',
      });
      return res.json({ ok: true, note });
    }),
  );

  /** Connect a self-hosted Nextcloud: the server URL, the person's username,
   * and an app password they generate in their own Nextcloud account under
   * Settings → Security → Devices & sessions. No OAuth handshake — there is no
   * central application to register or redirect through — so this is a single
   * request rather than a /start + /callback pair, and the credential is
   * verified against the server BEFORE it is stored (M28's spirit applied to a
   * provider with no client secret to configure: prove the credential works
   * rather than store a wish). */
  r.post(
    '/nextcloud/connect',
    handle(async (req, res) => {
      const serverUrlInput = str(req.body?.serverUrl, 500);
      const username = str(req.body?.username, 200);
      const appPassword = typeof req.body?.appPassword === 'string' ? req.body.appPassword : '';
      if (!serverUrlInput) throw new RouteError(400, 'a server address is required');
      if (!username) throw new RouteError(400, 'a username is required');
      if (!appPassword.trim()) throw new RouteError(400, 'an app password is required');

      // Validation of what the person TYPED, not a provider failure — caught
      // and re-thrown as a 400 here so it does not fall into the generic
      // ConnectorError handler below, which answers 502 for what it assumes
      // is an upstream problem. A malformed address is a form error, not the
      // server "refusing a request" it was never sent.
      let serverUrl: string;
      try {
        serverUrl = normalizeServerUrl(serverUrlInput);
      } catch (err) {
        const message = err instanceof ConnectorError ? err.message : 'that is not a usable server address';
        throw new RouteError(400, message);
      }
      const verified = await verifyWebdavCredentials(
        { serverUrl, username, appPassword }, { fetchImpl: ctx.fetchImpl },
      );
      if (!verified.ok) {
        throw new RouteError(
          verified.category === 'network' ? 502 : 401,
          verified.category === 'network'
            ? 'could not reach that server'
            : 'that server refused the username and app password',
        );
      }

      const key = requireKey(ctx);
      const connection = await connectNextcloud(db, key, {
        ownerUserId: req.user!.id, serverUrl, username, appPassword,
      });
      return res.status(201).json({
        connection: {
          id: connection.id,
          provider: 'nextcloud',
          account: connection.account_email,
          status: connection.status,
          serverUrl,
        },
        capabilities: await capabilityViews(db, { connection, provider: 'nextcloud' }),
      });
    }),
  );

  return r;
}

// ------------------------------------------------------------------- admin

export function adminConnectorRoutes(ctx: ConnectorRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** The installation's own OAuth applications, and the capability ceiling. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const deployment = await canonicalDeployment(db, ctx.appUrl);
      const appUrl = deployment.origin;
      // Google and Microsoft only accept an HTTPS redirect on a real domain
      // name. This used to be discovered inside the setup wizard, which offered
      // the registration as step 6 on installations that could never complete
      // it; the wizard no longer asks, and this page is where the answer
      // belongs. A base means an application can be registered right now.
      const httpsBase = deployment.publicHttpsBase;
      const policy = await db.query<{ capability: string; allowed: boolean; note: string | null }>(
        `select capability, allowed, note from admin_capability_policy`,
      );
      const byKey = new Map(policy.map((p) => [p.capability, p]));
      return res.json({
        clients: await clientStatuses(db),
        // Whether an OAuth application can be registered at all yet, and why
        // not. The page draws no credential fields while this is false rather
        // than offering a form whose result no provider would accept.
        registration: {
          available: !!httpsBase,
          publicHttpsBase: httpsBase,
          detectedOrigin: appUrl,
          reason: httpsBase
            ? null
            : 'Google and Microsoft only accept an HTTPS redirect on a real domain name. This '
              + 'installation is reachable only on your network, so there is nothing to register '
              + 'yet. Set a public domain and this becomes available without reinstalling '
              + 'anything.',
        },
        // Every capability with whether it is permitted installation-wide.
        // There is no "granted" here, only "allowed" — the shape itself says
        // this can deny and cannot bestow.
        policy: CAPABILITIES.map((c) => ({
          key: c.key,
          provider: c.provider,
          label: c.label,
          kind: c.kind,
          allowed: byKey.get(c.key)?.allowed ?? true,
          note: byKey.get(c.key)?.note ?? null,
        })),
        // Suggested callback URLs, so an operator registering an application
        // knows what to paste into Google's or Microsoft's console.
        suggestedRedirectUris: PROVIDERS.map((provider) => ({
          provider,
          uri: `${appUrl}/api/connections/${provider}/callback`,
          additionalUris: provider === 'google' ? [`${appUrl}/api/auth/google/callback`] : [],
        })),
      });
    }),
  );

  r.put(
    '/clients/:provider',
    handle(async (req, res) => {
      const provider = param(req, 'provider');
      if (!isOAuthRouteProvider(provider)) throw new RouteError(404, 'no such provider');

      const clientId = str(req.body?.clientId, 400);
      const clientSecret = asSecret(req.body?.clientSecret);
      const redirectUri = str(req.body?.redirectUri, 500);
      if (!clientId) throw new RouteError(400, 'a client id is required');
      if (clientSecret.isEmpty) throw new RouteError(400, 'a client secret is required');
      if (!/^https?:\/\//.test(redirectUri)) throw new RouteError(400, 'the redirect URI must be an http(s) URL');

      await saveClient(db, requireKey(ctx), {
        provider,
        clientId,
        clientSecret: clientSecret.reveal(),
        redirectUri,
        actorUserId: req.user!.id,
      });
      return res.json({ clients: await clientStatuses(db) });
    }),
  );

  r.delete(
    '/clients/:provider',
    handle(async (req, res) => {
      const provider = param(req, 'provider');
      if (!isOAuthRouteProvider(provider)) throw new RouteError(404, 'no such provider');
      await deleteClient(db, { provider, actorUserId: req.user!.id });
      return res.json({ clients: await clientStatuses(db) });
    }),
  );

  /** The ceiling. Deny-only by construction: this writes `allowed`, and there
   * is nothing anywhere that turns a user's capability on. */
  r.put(
    '/policy/:capability',
    handle(async (req, res) => {
      const capability = param(req, 'capability');
      if (!capabilitySpec(capability)) throw new RouteError(404, 'no such capability');
      const allowed = req.body?.allowed !== false;
      const note = str(req.body?.note, 300) || null;

      await db.query(
        `insert into admin_capability_policy (capability, allowed, note) values ($1, $2, $3)
         on conflict (capability) do update set allowed = excluded.allowed, note = excluded.note`,
        [capability, allowed, note],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: allowed ? 'connector.capability_permitted' : 'connector.capability_forbidden',
        payload: { capability },
      });
      return res.json({ capability, allowed, note });
    }),
  );

  /** Connection health across the workspace.
   *
   * Whose it is, whether it works, when it was checked, and what kind of
   * failure. NOT the address, NOT the scopes, NOT a token, and nothing about
   * what is inside the account. M30. */
  r.get(
    '/connections',
    handle(async (_req, res) => {
      const rows = await db.query<{
        id: string; owner_user_id: string; username: string; provider: string; status: string;
        last_check_at: string | null; last_check_ok: boolean | null; last_error_category: string | null;
        created_at: string;
      }>(
        `select c.id, c.owner_user_id, u.username, c.provider, c.status,
                c.last_check_at, c.last_check_ok, c.last_error_category, c.created_at
         from connections c join users u on u.id = c.owner_user_id
         order by u.username, c.provider`,
      );
      return res.json({ connections: rows });
    }),
  );

  /** An administrator may cut a connection off. That is plumbing: it removes
   * access, and at no point does it show them what was inside. */
  r.delete(
    '/connections/:id',
    handle(async (req, res) => {
      const connection = await getConnection(db, param(req, 'id'));
      if (!connection) throw new RouteError(404, 'not found');
      await deleteConnection(db, {
        connectionId: connection.id, actorUserId: req.user!.id, actor: 'super_admin',
      });
      return res.status(204).end();
    }),
  );

  return r;
}
