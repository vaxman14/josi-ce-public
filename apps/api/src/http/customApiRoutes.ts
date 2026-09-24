// Custom API connections over HTTP.
//
// The whole surface, and who may reach it:
//
//   ADMINISTRATOR — configures the pipe. Never sees what goes through it.
//     GET    /admin/custom-apis                        connections + allowlists
//     POST   /admin/custom-apis                        define one
//     PATCH  /admin/custom-apis/:id                    edit; resets verification
//     POST   /admin/custom-apis/:id/test               ask the API
//     POST   /admin/custom-apis/:id/enable | /disable  needs a successful test
//     DELETE /admin/custom-apis/:id
//     POST   /admin/custom-apis/:id/endpoints          add one action
//     POST   /admin/custom-apis/:id/endpoints/import   OpenAPI: preview, then save
//     PATCH  /admin/custom-apis/endpoints/:endpointId
//     POST   /admin/custom-apis/endpoints/:id/enable | /disable
//     DELETE /admin/custom-apis/endpoints/:endpointId
//
//   MEMBER — decides what is done in their name. Never configures anything.
//     GET    /custom-apis                              what Josi may do, and where
//     GET    /custom-apis/pending                      my waiting requests
//     POST   /custom-apis/pending/:id/approve          decide AND send, once
//     POST   /custom-apis/pending/:id/deny
//
// Four claims, each with a test attacking it:
//
//   * NO RESPONSE FROM THIS FILE CONTAINS A CREDENTIAL. Not the plaintext, not
//     the ciphertext, not a prefix, not a length. `CREDENTIAL_MASK` is a
//     constant, and every administrator DTO goes through `assertMetadataOnly`.
//   * NOTHING REACHES THE ASSISTANT ON THE STRENGTH OF A FORM. A connection
//     cannot be enabled until the API has answered, and every endpoint under it
//     is separately off until somebody switches it on.
//   * A PENDING REQUEST BELONGS TO ONE PERSON. Another member's id is 404 — not
//     403, which would confirm it exists. There is no admin read of it, and a
//     super admin using these member routes is a member.
//   * APPROVING IS SENDING, EXACTLY ONCE. The decision and the request are one
//     route and one conditional UPDATE, so an approved call cannot sit
//     unexecuted or be spent twice.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, loadMasterKey, type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  CREDENTIAL_MASK, CustomApiCallError, CustomApiError, CustomApiInputError,
  availableCustomApiActions, buildCustomApiTestRequest, categoryForCustomApiStatus, claimApproved, createCustomApi, createCustomApiEndpoint,
  customApiById, customApiEndpointById, customApiFetch, customApiSentence,
  deleteCustomApi, deleteCustomApiEndpoint, denyCustomApiCall, disableCustomApi,
  enableCustomApi, listCustomApiEndpoints, listCustomApis, listPendingCalls,
  openApprovedRequest, openCustomApiCredentials, parseOpenApiDocument, proposeFromOpenApi, recordCallResult, recordCustomApiCheck, setCustomApiEndpointEnabled,
  updateCustomApi, updateCustomApiEndpoint,
  validateCustomApiAuthHeader, validateCustomApiAuthKind, validateCustomApiBaseUrl,
  validateCustomApiCredentials, validateCustomApiMethod, validateCustomApiName,
  validateCustomApiOperationId, validateCustomApiParameters, validateCustomApiPathTemplate,
  validateCustomApiSlug, validateCustomApiSummary, validateCustomApiTestPath,
  type CustomApiConnectionRow, type CustomApiEndpointDraft, type CustomApiEndpointRow,
  type CustomApiMethod,
} from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { assertMetadataOnly, requireAuth, requireSuperAdmin } from './authz.js';

export interface CustomApiRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the tests. No suite contacts a real API. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof CustomApiInputError) return res.status(400).json({ error: err.message });
      // A pending request that is not yours reads exactly like one that never
      // existed. Anything else about a pending request — already decided,
      // expired — is a conflict, because the row is real and the caller owns it.
      if (err instanceof CustomApiCallError) {
        return res.status(err.notFound ? 404 : 409).json({ error: err.message });
      }
      // An API's refusal is a 502 with a category: the request was fine, the
      // answer was not. The message is one CE wrote — never the API's.
      if (err instanceof CustomApiError) {
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

function requireKey(ctx: CustomApiRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable');
  }
}

// -------------------------------------------------------------------- views

/**
 * What an ADMINISTRATOR sees about a connection.
 *
 * `credentialMask` is a constant — not the last four characters and not the
 * length. A mask derived from the secret is still made of the secret, and
 * "which credential is this?" is answered by the name somebody typed.
 * `credentials_enc` is not served either: ciphertext is something an attacker
 * can work on offline, and no surface needs it.
 */
function connectionView(row: CustomApiConnectionRow, endpoints: CustomApiEndpointRow[]) {
  const dto = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    baseUrl: row.base_url,
    host: row.host,
    authKind: row.auth_kind,
    authHeader: row.auth_header,
    credentialMask: CREDENTIAL_MASK,
    testPath: row.test_path,
    enabled: row.enabled,
    connectionStatus: row.status,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    lastErrorCategory: row.last_error_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endpoints: endpoints.map(endpointView),
  };
  assertMetadataOnly(dto);
  return dto;
}

function endpointView(row: CustomApiEndpointRow) {
  return {
    id: row.id,
    connectionId: row.connection_id,
    operationId: row.operation_id,
    summary: row.summary,
    method: row.method,
    pathTemplate: row.path_template,
    capability: row.capability,
    parameters: row.parameters ?? [],
    acceptsBody: row.accepts_body,
    enabled: row.enabled,
    origin: row.source,
    updatedAt: row.updated_at,
  };
}

// -------------------------------------------------------------- the request

/** Reads a connection form. Every field goes through the connectors package's
 * validators, so a hand-typed row and an imported one are held to one grammar. */
function readConnectionForm(body: Record<string, unknown>, existing?: CustomApiConnectionRow) {
  const name = body.name !== undefined || !existing
    ? validateCustomApiName(body.name)
    : existing.name;

  const base = body.baseUrl !== undefined || !existing
    ? validateCustomApiBaseUrl(body.baseUrl)
    : { baseUrl: existing.base_url, host: existing.host };

  const authKind = body.authKind !== undefined || !existing
    ? validateCustomApiAuthKind(body.authKind)
    : existing.auth_kind;

  const authHeader = authKind === 'api_key'
    ? (body.authHeader !== undefined || !existing || existing.auth_kind !== 'api_key'
      ? validateCustomApiAuthHeader(body.authHeader)
      : existing.auth_header)
    : null;

  const testPath = body.testPath !== undefined || !existing
    ? validateCustomApiTestPath(body.testPath)
    : existing.test_path;

  return { name, base, authKind, authHeader, testPath };
}

function readEndpointForm(body: Record<string, unknown>, source: 'manual' | 'openapi'): CustomApiEndpointDraft {
  const method = validateCustomApiMethod(body.method);
  const pathTemplate = validateCustomApiPathTemplate(body.pathTemplate);
  return {
    operationId: validateCustomApiOperationId(body.operationId),
    summary: validateCustomApiSummary(body.summary),
    method,
    pathTemplate,
    parameters: validateCustomApiParameters(body.parameters, pathTemplate),
    acceptsBody: body.acceptsBody === true,
    source,
  };
}

async function connectionOr404(db: Db, id: string): Promise<CustomApiConnectionRow> {
  const row = await customApiById(db, id);
  if (!row) throw new RouteError(404, 'not found');
  return row;
}

/**
 * Contacts the API and records what happened.
 *
 * Shared by the administrator's test button and — through
 * `recordCustomApiCheck` — by every assistant call, so the health shown on the
 * admin page reflects real use rather than only the last time somebody pressed
 * a button.
 */
async function runTest(
  ctx: CustomApiRoutesCtx,
  connection: CustomApiConnectionRow,
  actorUserId: string,
): Promise<{ ok: boolean; status: number }> {
  const key = requireKey(ctx);
  const request = buildCustomApiTestRequest(connection);
  try {
    const response = await customApiFetch(
      { connection, request, secret: openCustomApiCredentials(key, connection) },
      { fetchImpl: ctx.fetchImpl, resolve: ctx.resolve },
    );
    const ok = response.status < 400;
    const category = ok ? null : categoryForCustomApiStatus(response.status);
    await recordCustomApiCheck(ctx.db, { connectionId: connection.id, ok, category });
    await appendEvent(ctx.db, {
      actorUserId,
      actor: 'super_admin',
      kind: 'custom_api.connection_tested',
      subjectType: 'custom_api_connection',
      subjectId: connection.id,
      // A status number and a category. Never the API's body, which may quote a
      // request that carried this installation's credential.
      payload: { slug: connection.slug, ok, resultStatus: response.status, category },
    });
    if (!ok) {
      throw new CustomApiError(customApiSentence(connection.name, category!), {
        category: category!, status: response.status,
      });
    }
    return { ok, status: response.status };
  } catch (err) {
    if (err instanceof CustomApiError && err.status === undefined) {
      // Never reached the API at all: DNS, a refused address, a redirect, a
      // timeout. Recorded with its category so the page can say which.
      await recordCustomApiCheck(ctx.db, { connectionId: connection.id, ok: false, category: err.category });
      await appendEvent(ctx.db, {
        actorUserId,
        actor: 'super_admin',
        kind: 'custom_api.connection_tested',
        subjectType: 'custom_api_connection',
        subjectId: connection.id,
        payload: { slug: connection.slug, ok: false, category: err.category },
      });
    }
    throw err;
  }
}

// ------------------------------------------------------------------- admin

export function adminCustomApiRoutes(ctx: CustomApiRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** Every connection and its complete allowlist. Metadata only. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const connections = await listCustomApis(db);
      const out = [];
      for (const connection of connections) {
        out.push(connectionView(connection, await listCustomApiEndpoints(db, connection.id)));
      }
      return res.json({ connections: out });
    }),
  );

  /**
   * Define a connection.
   *
   * It arrives DISABLED and UNVERIFIED whatever the request body says: there is
   * no field here that switches anything on, and `enableCustomApi` refuses
   * until the API has answered. So the worst a crafted request can produce is a
   * row nothing uses.
   */
  r.post(
    '/',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const form = readConnectionForm(body);
      const slug = validateCustomApiSlug(body.slug, form.name);
      const credentials = validateCustomApiCredentials(form.authKind, body);

      // The master key is required BEFORE anything is stored: an installation
      // that cannot seal has no business holding a credential at all.
      const key = requireKey(ctx);

      const existing = await listCustomApis(db);
      if (existing.some((c) => c.slug === slug)) {
        throw new RouteError(409, `there is already a connection called "${slug}"`);
      }

      const row = await createCustomApi(db, key, {
        actorUserId: req.user!.id,
        name: form.name,
        slug,
        baseUrl: form.base.baseUrl,
        host: form.base.host,
        authKind: form.authKind,
        authHeader: form.authHeader,
        credentials,
        testPath: form.testPath,
      });
      return res.status(201).json({ connection: connectionView(row, []) });
    }),
  );

  /** Edit. Changing where or how it connects resets the verification and
   * switches it off — see `updateCustomApi`. */
  r.patch(
    '/:id',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const form = readConnectionForm(body, connection);
      // Absent = leave the stored credential alone. A form that re-sent a
      // masked value would otherwise store the mask as the credential.
      const replacing = body.secret !== undefined
        || body.username !== undefined
        || body.password !== undefined
        || form.authKind !== connection.auth_kind;
      const credentials = replacing ? validateCustomApiCredentials(form.authKind, body) : undefined;
      const key = requireKey(ctx);

      const row = await updateCustomApi(db, key, {
        actorUserId: req.user!.id,
        connection,
        name: form.name,
        baseUrl: form.base.baseUrl,
        host: form.base.host,
        authKind: form.authKind,
        authHeader: form.authHeader,
        credentials,
        testPath: form.testPath,
      });
      return res.json({ connection: connectionView(row, await listCustomApiEndpoints(db, row.id)) });
    }),
  );

  /** Ask the API, now. A GET to the configured test path and nothing else. */
  r.post(
    '/:id/test',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const result = await runTest(ctx, connection, req.user!.id);
      const fresh = await customApiById(db, connection.id);
      return res.json({
        ok: true,
        status: result.status,
        connection: connectionView(fresh!, await listCustomApiEndpoints(db, connection.id)),
      });
    }),
  );

  r.post(
    '/:id/enable',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const row = await enableCustomApi(db, { actorUserId: req.user!.id, connection });
      return res.json({ connection: connectionView(row, await listCustomApiEndpoints(db, row.id)) });
    }),
  );

  r.post(
    '/:id/disable',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const row = await disableCustomApi(db, { actorUserId: req.user!.id, connection });
      return res.json({ connection: connectionView(row, await listCustomApiEndpoints(db, row.id)) });
    }),
  );

  r.delete(
    '/:id',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      await deleteCustomApi(db, { actorUserId: req.user!.id, connection });
      return res.json({ ok: true });
    }),
  );

  // ---------------------------------------------------------- the allowlist

  r.post(
    '/:id/endpoints',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const draft = readEndpointForm((req.body ?? {}) as Record<string, unknown>, 'manual');
      const existing = await listCustomApiEndpoints(db, connection.id);
      if (existing.some((e) => e.operation_id === draft.operationId)) {
        throw new RouteError(409, `this connection already has an action called "${draft.operationId}"`);
      }
      const row = await createCustomApiEndpoint(db, {
        actorUserId: req.user!.id, connection, draft,
      });
      return res.status(201).json({ endpoint: endpointView(row) });
    }),
  );

  /**
   * OpenAPI import, in two deliberate steps through one route.
   *
   * WITHOUT `operations`, this SAVES NOTHING and returns what the document
   * proposes. That default is the point: an import route whose first effect is
   * to write 200 rows is an import route somebody runs by accident. The
   * administrator reads the list, chooses, and calls again naming the ones they
   * want — and even those arrive disabled.
   *
   * The document's `servers` are reported back and never used. The host stays
   * the one on the form.
   */
  r.post(
    '/:id/endpoints/import',
    handle(async (req, res) => {
      const connection = await connectionOr404(db, param(req, 'id'));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = proposeFromOpenApi(parseOpenApiDocument(body.document));

      const wanted = Array.isArray(body.operations)
        ? new Set(body.operations.filter((v): v is string => typeof v === 'string'))
        : null;

      if (!wanted) {
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'super_admin',
          kind: 'custom_api.spec_previewed',
          subjectType: 'custom_api_connection',
          subjectId: connection.id,
          payload: {
            slug: connection.slug,
            proposed: result.proposals.length,
            skipped: result.skipped.length,
          },
        });
        return res.json({
          saved: 0,
          proposals: result.proposals,
          skipped: result.skipped,
          declaredServers: result.declaredServers,
          title: result.title,
          note: 'Nothing has been saved. Choose the actions you want and import again; each one '
            + `arrives switched off. Josi ignores the addresses in that document and will only ever call ${connection.host}.`,
        });
      }

      const existing = new Set(
        (await listCustomApiEndpoints(db, connection.id)).map((e) => e.operation_id),
      );
      const saved: CustomApiEndpointRow[] = [];
      const rejected: Array<{ operationId: string; reason: string }> = [];
      for (const draft of result.proposals) {
        if (!wanted.has(draft.operationId)) continue;
        if (existing.has(draft.operationId)) {
          rejected.push({
            operationId: draft.operationId,
            reason: 'this connection already has an action with that name',
          });
          continue;
        }
        existing.add(draft.operationId);
        saved.push(await createCustomApiEndpoint(db, { actorUserId: req.user!.id, connection, draft }));
      }

      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: 'custom_api.spec_imported',
        subjectType: 'custom_api_connection',
        subjectId: connection.id,
        payload: { slug: connection.slug, saved: saved.length, rejected: rejected.length },
      });
      return res.status(201).json({
        saved: saved.length,
        endpoints: saved.map(endpointView),
        rejected,
        note: 'Every imported action is switched off. Switch on only the ones Josi should be able to use.',
      });
    }),
  );

  r.patch(
    '/endpoints/:endpointId',
    handle(async (req, res) => {
      const endpoint = await customApiEndpointById(db, param(req, 'endpointId'));
      if (!endpoint) throw new RouteError(404, 'not found');
      const connection = await connectionOr404(db, endpoint.connection_id);
      const draft = readEndpointForm((req.body ?? {}) as Record<string, unknown>, endpoint.source);
      const siblings = await listCustomApiEndpoints(db, connection.id);
      if (siblings.some((e) => e.operation_id === draft.operationId && e.id !== endpoint.id)) {
        throw new RouteError(409, `this connection already has an action called "${draft.operationId}"`);
      }
      const row = await updateCustomApiEndpoint(db, {
        actorUserId: req.user!.id, connection, endpoint, draft,
      });
      return res.json({
        endpoint: endpointView(row),
        note: 'Changing what an action does switches it off again, so somebody reviews the new version.',
      });
    }),
  );

  for (const [suffix, enabled] of [['enable', true], ['disable', false]] as const) {
    r.post(
      `/endpoints/:endpointId/${suffix}`,
      handle(async (req, res) => {
        const endpoint = await customApiEndpointById(db, param(req, 'endpointId'));
        if (!endpoint) throw new RouteError(404, 'not found');
        const connection = await connectionOr404(db, endpoint.connection_id);
        const row = await setCustomApiEndpointEnabled(db, {
          actorUserId: req.user!.id, connection, endpoint, enabled,
        });
        return res.json({ endpoint: endpointView(row) });
      }),
    );
  }

  r.delete(
    '/endpoints/:endpointId',
    handle(async (req, res) => {
      const endpoint = await customApiEndpointById(db, param(req, 'endpointId'));
      if (!endpoint) throw new RouteError(404, 'not found');
      const connection = await connectionOr404(db, endpoint.connection_id);
      await deleteCustomApiEndpoint(db, { actorUserId: req.user!.id, connection, endpoint });
      return res.json({ ok: true });
    }),
  );

  return r;
}

// ------------------------------------------------------------------ member

export function customApiRoutes(ctx: CustomApiRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /**
   * What Josi may do on this installation's connected APIs, and where those
   * requests go.
   *
   * Shown to every member rather than to administrators alone, on purpose: an
   * assistant that can reach an outside service on your behalf is something you
   * should be able to look up without asking. It is metadata — names, actions,
   * hosts — and carries no credential.
   */
  r.get(
    '/',
    handle(async (_req, res) => {
      const actions = await availableCustomApiActions(db);
      const byConnection = new Map<string, {
        name: string; slug: string; host: string;
        actions: Array<{ operationId: string; summary: string; capability: string; needsApproval: boolean }>;
      }>();
      for (const { connection, endpoint } of actions) {
        const entry = byConnection.get(connection.id) ?? {
          name: connection.name, slug: connection.slug, host: connection.host, actions: [],
        };
        entry.actions.push({
          operationId: endpoint.operation_id,
          summary: endpoint.summary,
          capability: endpoint.capability,
          needsApproval: endpoint.capability !== 'read',
        });
        byConnection.set(connection.id, entry);
      }
      return res.json({ connections: [...byConnection.values()] });
    }),
  );

  /** Mine and only mine. The query is by `owner_user_id`, so there is no id for
   * a caller to substitute. */
  r.get(
    '/pending',
    handle(async (req, res) => {
      const rows = await listPendingCalls(db, req.user!.id);
      return res.json({
        pending: rows.map((row) => ({
          id: row.id,
          connectionName: row.connection_name,
          operationId: row.operation_id,
          capability: row.capability,
          // What would happen, in words, before anybody agrees to it.
          summary: row.summary,
          requestedAt: row.created_at,
          expiresAt: row.expires_at,
        })),
      });
    }),
  );

  /**
   * Approve, and send — one route, one transaction's worth of guarantee.
   *
   * `claimApproved` moves the row out of `pending` with a conditional UPDATE, so
   * a double-tapped button or two open tabs produce one request and one 409.
   * The sealed payload is then re-hashed before it is sent: an approval that
   * does not pin what it approved is a rubber stamp.
   */
  r.post(
    '/pending/:id/approve',
    handle(async (req, res) => {
      const key = requireKey(ctx);
      const call = await claimApproved(db, { callId: param(req, 'id'), decidedBy: req.user!.id });

      const endpoint = await customApiEndpointById(db, call.endpoint_id);
      const connection = endpoint ? await customApiById(db, endpoint.connection_id) : null;
      if (!endpoint || !connection) {
        await recordCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok: false, status: null,
          slug: 'unknown', operationId: 'unknown',
        });
        throw new RouteError(409, 'that action no longer exists, so Josi did not make the request');
      }
      // The switches are checked AGAIN here. An administrator who switched the
      // action off while somebody was deciding meant it, and an approval is not
      // a way past an allowlist.
      if (!connection.enabled || !endpoint.enabled) {
        await recordCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok: false, status: null,
          slug: connection.slug, operationId: endpoint.operation_id,
        });
        throw new RouteError(
          409,
          'an administrator switched that action off while this was waiting, so Josi did not make the request',
        );
      }

      const payload = openApprovedRequest(key, call);
      try {
        const response = await customApiFetch(
          {
            connection,
            // Every field comes from the SEALED payload, whose hash
            // `openApprovedRequest` has just re-verified — not from the endpoint
            // row, which somebody could have edited while this waited. What is
            // sent is what was described, or nothing is sent at all.
            request: {
              url: payload.url,
              method: payload.method as CustomApiMethod,
              body: payload.body,
            },
            secret: openCustomApiCredentials(key, connection),
          },
          { fetchImpl: ctx.fetchImpl, resolve: ctx.resolve },
        );
        const ok = response.status < 400;
        await recordCustomApiCheck(db, {
          connectionId: connection.id,
          ok,
          category: ok ? null : categoryForCustomApiStatus(response.status),
        });
        await recordCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok, status: response.status,
          slug: connection.slug, operationId: endpoint.operation_id,
        });
        return res.json({
          ok,
          status: response.status,
          // The API's own answer goes back to the person who authorised the
          // request. It is theirs; it is not written to a log or an event.
          result: response.body,
          truncated: response.truncated,
          ...(ok ? {} : { error: customApiSentence(connection.name, categoryForCustomApiStatus(response.status)) }),
        });
      } catch (err) {
        const category = err instanceof CustomApiError ? err.category : 'provider_error';
        await recordCustomApiCheck(db, { connectionId: connection.id, ok: false, category });
        await recordCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok: false, status: null,
          slug: connection.slug, operationId: endpoint.operation_id,
        });
        throw err;
      }
    }),
  );

  r.post(
    '/pending/:id/deny',
    handle(async (req, res) => {
      const row = await denyCustomApiCall(db, { callId: param(req, 'id'), decidedBy: req.user!.id });
      return res.json({ ok: true, status: row.status });
    }),
  );

  return r;
}
