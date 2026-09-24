import type { Express } from "express";
import { Router } from "express";
import {
  loadMasterKey,
  openSealed,
  type Db,
  type LoadOptions,
} from "@josi-ce/core";
import {
  disconnectWorkflowIntegration,
  discoverWorkflows,
  executeWorkflowRun,
  isWorkflowProvider,
  previewWorkflowRun,
  recordWorkflowCallback,
  registerN8nWebhook,
  requestWorkflowRun,
  saveWorkflowIntegration,
  verifyWorkflowCallback,
  workflowHistory,
  WorkflowError,
  type WorkflowIntegration,
} from "@josi-ce/connectors";
import { asyncRoute, param } from "./async.js";
import { requireAuth, requireSuperAdmin } from "./authz.js";

interface Ctx {
  db: Db;
  masterKey?: LoadOptions | false;
  fetchImpl?: typeof fetch;
}
const key = (ctx: Ctx) => {
  if (ctx.masterKey === false)
    throw new WorkflowError(
      "This installation cannot store secrets right now.",
      503,
    );
  return loadMasterKey(ctx.masterKey ?? {});
};
const handle = (fn: any) =>
  asyncRoute(async (req, res) => {
    try {
      return await fn(req, res);
    } catch (e) {
      if (e instanceof WorkflowError)
        return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

export function adminWorkflowRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireSuperAdmin);
  r.get(
    "/",
    handle(async (_req: any, res: any) =>
      res.json({
        integrations: await ctx.db.query(
          `select id,provider,name,base_url,enabled,allow_private_network,account_identity,workspace_identity,status,last_check_at,last_check_ok,created_at,updated_at from workflow_integrations order by provider,name`,
        ),
        workflows: await ctx.db.query(
          `select integration_id,external_id,name,active,exposed,execution_ref from workflow_definitions order by name`,
        ),
      }),
    ),
  );
  r.post(
    "/",
    handle(async (req: any, res: any) => {
      const provider = String(req.body?.provider ?? "");
      if (!isWorkflowProvider(provider))
        throw new WorkflowError("Choose Zapier, n8n, or Make.");
      const saved = await saveWorkflowIntegration(ctx.db, key(ctx), {
        provider,
        name: String(req.body?.name ?? ""),
        baseUrl: String(req.body?.baseUrl ?? ""),
        token: String(req.body?.token ?? ""),
        allowPrivateNetwork: req.body?.allowPrivateNetwork === true,
        workspaceId: String(req.body?.workspaceId ?? ""),
        workspaceType:
          req.body?.workspaceType === "organization" ? "organization" : "team",
        actorUserId: req.user.id,
        fetchImpl: ctx.fetchImpl,
      });
      return res
        .status(201)
        .json({
          integration: {
            id: saved.id,
            provider: saved.provider,
            name: saved.name,
            baseUrl: saved.base_url,
            enabled: saved.enabled,
            allowPrivateNetwork: saved.allow_private_network,
            accountIdentity: saved.account_identity,
            workspaceIdentity: saved.workspace_identity,
            status: saved.status,
          },
          callbackSecret: saved.callbackSecret,
        });
    }),
  );
  r.post(
    "/:id/discover",
    handle(async (req: any, res: any) => {
      const [integration] = await ctx.db.query<WorkflowIntegration>(
        `select * from workflow_integrations where id=$1`,
        [param(req, "id")],
      );
      if (!integration) throw new WorkflowError("Integration not found.", 404);
      const workflows = await discoverWorkflows(
        ctx.db,
        key(ctx),
        integration,
        ctx.fetchImpl,
      );
      await ctx.db.query(
        `update workflow_integrations set enabled=true where id=$1`,
        [integration.id],
      );
      return res.json({
        workflows,
        note: "Discovered workflows remain private until explicitly exposed.",
      });
    }),
  );
  r.put(
    "/:id/workflows/:workflowId/exposure",
    handle(async (req: any, res: any) => {
      const rows = await ctx.db.query(
        `update workflow_definitions set exposed=$3 where integration_id=$1 and external_id=$2 returning integration_id,external_id,name,exposed`,
        [
          param(req, "id"),
          param(req, "workflowId"),
          req.body?.exposed === true,
        ],
      );
      if (!rows.length) throw new WorkflowError("Workflow not found.", 404);
      return res.json({ workflow: rows[0] });
    }),
  );
  r.put(
    "/:id/workflows/:workflowId/n8n-webhook",
    handle(async (req: any, res: any) =>
      res.json({
        workflow: await registerN8nWebhook(
          ctx.db,
          param(req, "id"),
          param(req, "workflowId"),
          String(req.body?.path ?? ""),
          req.body?.inputSchema ?? { type: "object", properties: {} },
        ),
      }),
    ),
  );
  r.delete(
    "/:id",
    handle(async (req: any, res: any) =>
      res.json(await disconnectWorkflowIntegration(ctx.db, param(req, "id"))),
    ),
  );
  return r;
}

async function accessible(ctx: Ctx, integrationId: string, workflowId: string) {
  const [row] = await ctx.db.query<any>(
    `select i.*,w.external_id,w.name as workflow_name,w.description,w.input_schema,w.execution_ref,w.active from workflow_integrations i join workflow_definitions w on w.integration_id=i.id where i.id=$1 and w.external_id=$2 and i.enabled=true and w.active=true and w.exposed=true`,
    [integrationId, workflowId],
  );
  if (!row) throw new WorkflowError("Workflow not found.", 404);
  return row;
}
const definition = (row: any) => ({
  integration_id: row.id,
  external_id: row.external_id,
  name: row.workflow_name,
  description: row.description,
  input_schema: row.input_schema,
  execution_ref: row.execution_ref,
  active: row.active,
});

export function workflowRoutes(ctx: Ctx) {
  const r = Router();
  r.use(requireAuth);
  r.get(
    "/",
    handle(async (_req: any, res: any) =>
      res.json({
        workflows: await ctx.db.query(
          `select w.integration_id,w.external_id,w.name,w.description,w.input_schema,i.provider,i.name as integration_name from workflow_definitions w join workflow_integrations i on i.id=w.integration_id where i.enabled=true and w.active=true and w.exposed=true order by i.provider,w.name`,
        ),
      }),
    ),
  );
  r.get(
    "/runs/:id/preview",
    handle(async (req: any, res: any) => {
      const [run] = await ctx.db.query<any>(
        `select r.input_enc,w.name,i.provider from workflow_runs r join workflow_integrations i on i.id=r.integration_id join workflow_definitions w on w.integration_id=r.integration_id and w.external_id=r.external_workflow_id where r.id=$1 and r.owner_user_id=$2 and r.status='pending'`,
        [param(req, "id"), req.user.id],
      );
      if (!run) throw new WorkflowError("Pending run not found.", 404);
      return res.json({
        provider: run.provider,
        workflow: run.name,
        input: openSealed<{ input: unknown }>(key(ctx), run.input_enc).input,
      });
    }),
  );
  r.get(
    "/history",
    handle(async (req: any, res: any) =>
      res.json({ runs: await workflowHistory(ctx.db, req.user.id) }),
    ),
  );
  r.post(
    "/:integrationId/:workflowId/preview",
    handle(async (req: any, res: any) => {
      const row = await accessible(
        ctx,
        param(req, "integrationId"),
        param(req, "workflowId"),
      );
      return res.json(
        previewWorkflowRun(definition(row), req.body?.input ?? {}),
      );
    }),
  );
  r.post(
    "/:integrationId/:workflowId/request",
    handle(async (req: any, res: any) => {
      const row = await accessible(
        ctx,
        param(req, "integrationId"),
        param(req, "workflowId"),
      );
      const run = await requestWorkflowRun(ctx.db, key(ctx), {
        integration: row,
        workflow: definition(row),
        ownerUserId: req.user.id,
        threadId: req.body?.threadId ?? null,
        input: req.body?.input ?? {},
      });
      return res.status(202).json({ runId: run.id, status: "pending" });
    }),
  );
  r.post(
    "/runs/:id/decide",
    handle(async (req: any, res: any) =>
      res.json(
        await executeWorkflowRun(ctx.db, key(ctx), {
          runId: param(req, "id"),
          ownerUserId: req.user.id,
          approve: req.body?.approve === true,
          fetchImpl: ctx.fetchImpl,
        }),
      ),
    ),
  );
  return r;
}

export function mountWorkflowCallbacks(app: Express, ctx: Ctx) {
  app.post(
    "/api/workflow-callbacks/:id",
    handle(async (req: any, res: any) => {
      const [integration] = await ctx.db.query<WorkflowIntegration>(
        `select * from workflow_integrations where id=$1 and enabled=true`,
        [param(req, "id")],
      );
      const raw = (req.rawBody as Buffer | undefined)?.toString("utf8") ?? "";
      if (
        !integration ||
        !raw ||
        !(await verifyWorkflowCallback(
          ctx.db,
          key(ctx),
          integration,
          raw,
          String(req.get("x-josi-signature") ?? ""),
          String(req.get("x-josi-timestamp") ?? ""),
        ))
      )
        return res.status(404).json({ error: "not found" });
      const eventId = String(req.get("x-josi-event-id") ?? "").slice(0, 200);
      if (!eventId) return res.status(400).json({ error: "event id required" });
      if(!['succeeded','failed'].includes(req.body?.status))return res.status(400).json({error:'valid completion status required'});
      const seen=await ctx.db.query(`select event_id from workflow_callback_events where integration_id=$1 and event_id=$2`,[integration.id,eventId]);
      if(seen.length)return res.json({ok:true,duplicate:true});
      const run = await recordWorkflowCallback(ctx.db, {
        integrationId: integration.id,
        eventId,
        externalRunId: String(req.body?.runId ?? ""),
        status: req.body?.status === "succeeded" ? "succeeded" : "failed",
        summary:
          typeof req.body?.summary === "string" ? req.body.summary : undefined,
      });
      return res.json({ ok: true, runId: run.id });
    }),
  );
}
