import type { Db, MasterKey } from "@josi-ce/core";
import {
  requestWorkflowRun,
  type WorkflowDefinition,
  type WorkflowIntegration,
} from "@josi-ce/connectors";
import type { ToolSpec } from "./tools.js";

export const WORKFLOW_TOOL_NAMES = new Set([
  "list_native_workflows",
  "run_native_workflow",
]);
export const WORKFLOW_TOOLS: ToolSpec[] = [
  {
    def: {
      name: "list_native_workflows",
      description:
        "List active workflows discovered from native Zapier, n8n, and Make connections.",
      parameters: { type: "object", properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: "run_native_workflow",
      description:
        "Prepare one discovered Zapier, n8n, or Make workflow for the user. It never executes immediately: the exact provider, workflow, and input wait for the user to approve.",
      parameters: {
        type: "object",
        properties: {
          integration_id: { type: "string" },
          workflow_id: { type: "string" },
          input: { type: "object" },
        },
        required: ["integration_id", "workflow_id", "input"],
      },
    },
    actionClass: "external_write",
  },
];
export async function workflowToolAvailability(db: Db): Promise<ToolSpec[]> {
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int n from workflow_definitions w join workflow_integrations i on i.id=w.integration_id where i.enabled=true and w.active=true and w.exposed=true`,
  );
  return (row?.n ?? 0) > 0 ? WORKFLOW_TOOLS : [];
}
export async function executeWorkflowTool(
  db: Db,
  ctx: { userId: string; threadId: string | null; masterKey: () => MasterKey },
  name: string,
  input: Record<string, unknown>,
) {
  if (name === "list_native_workflows")
    return {
      workflows: await db.query(
        `select w.integration_id,w.external_id as workflow_id,w.name,w.description,i.provider from workflow_definitions w join workflow_integrations i on i.id=w.integration_id where i.enabled=true and w.active=true and w.exposed=true order by i.provider,w.name`,
      ),
    };
  const [row] = await db.query<any>(
    `select i.*,w.external_id,w.name as workflow_name,w.description,w.input_schema,w.execution_ref,w.active from workflow_integrations i join workflow_definitions w on w.integration_id=i.id where i.id=$1 and w.external_id=$2 and i.enabled=true and w.active=true and w.exposed=true`,
    [String(input.integration_id ?? ""), String(input.workflow_id ?? "")],
  );
  if (!row)
    return { ok: false, message: "That native workflow is not available." };
  const workflow: WorkflowDefinition = {
    integration_id: row.id,
    external_id: row.external_id,
    name: row.workflow_name,
    description: row.description,
    input_schema: row.input_schema,
    execution_ref: row.execution_ref,
    active: row.active,
  };
  const run = await requestWorkflowRun(db, ctx.masterKey(), {
    integration: row as WorkflowIntegration,
    workflow,
    ownerUserId: ctx.userId,
    threadId: ctx.threadId,
    input: (input.input &&
    typeof input.input === "object" &&
    !Array.isArray(input.input)
      ? input.input
      : {}) as Record<string, unknown>,
  });
  return {
    ok: true,
    status: "pending",
    run_id: run.id,
    message:
      "Prepared this exact native workflow run. It is waiting for the user to approve it in Automation workflows.",
  };
}
