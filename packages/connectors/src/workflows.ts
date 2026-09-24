import { Agent, fetch as undiciFetch } from "undici";
import { Ajv } from "ajv";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import {
  appendEvent,
  json,
  openSealed,
  seal,
  openCredentialPayload,
  storeCredentialPayload,
  deleteVaultSlot,
  type Db,
  type MasterKey,
} from "@josi-ce/core";
import { assertPublicHost } from "./customApiRequest.js";

/** Reuse the network policy, not the Custom API connector protocol. */
const publicWorkflowFetch: typeof fetch = async (url, init) => {
  const addresses = await assertPublicHost(new URL(String(url)).hostname);
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, _options, callback) =>
        callback(null, addresses[0], isIP(addresses[0])),
    },
  });
  try {
    const response = await undiciFetch(String(url), {
      ...(init as any),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      dispatcher,
    });
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 512 * 1024)
          throw new WorkflowError(
            "Provider response exceeded the size limit.",
            502,
          );
        chunks.push(chunk);
      }
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      headers: Object.fromEntries(response.headers),
    });
  } finally {
    await dispatcher.close();
  }
};

export type WorkflowProvider = "zapier" | "n8n" | "make";
export interface WorkflowIntegration {
  id: string;
  created_by: string;
  provider: WorkflowProvider;
  name: string;
  base_url: string;
  credentials_enc: string;
  callback_secret_enc: string;
  enabled: boolean;
  allow_private_network: boolean;
  account_identity: string | null;
  workspace_identity: string | null;
  status: string;
}
export interface WorkflowDefinition {
  integration_id: string;
  external_id: string;
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  execution_ref: string;
  active: boolean;
  exposed?: boolean;
}
export interface WorkflowRun {
  id: string;
  integration_id: string;
  external_workflow_id: string;
  owner_user_id: string;
  status: string;
  external_run_id: string | null;
  result_summary: string | null;
  error_category: string | null;
  created_at: string;
}
type Credentials = {
  token: string;
  workspaceId?: string;
  workspaceType?: "team" | "organization";
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS: WorkflowProvider[] = ["zapier", "n8n", "make"];
const defaults: Record<WorkflowProvider, string> = {
  zapier: "https://mcp.zapier.com",
  n8n: "",
  make: "https://us1.make.com",
};
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function isWorkflowProvider(v: string): v is WorkflowProvider {
  return PROVIDERS.includes(v as WorkflowProvider);
}

function privateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local"))
    return true;
  if (isIP(h) === 4) {
    const p = h.split(".").map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }
  return (
    isIP(h) === 6 &&
    (h === "::1" ||
      h === "::" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe8") ||
      h.startsWith("fe9") ||
      h.startsWith("fea") ||
      h.startsWith("feb"))
  );
}
function safeBase(
  provider: WorkflowProvider,
  raw: string,
  allowPrivateNetwork = false,
): string {
  const value = (raw || defaults[provider]).replace(/\/$/, "");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new WorkflowError("Enter a valid provider URL.");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (provider !== "n8n" && u.port)
  )
    throw new WorkflowError(
      "Workflow provider URLs must be HTTPS origins without credentials, query strings, or fragments.",
    );
  if (provider === "zapier" && u.hostname !== "mcp.zapier.com")
    throw new WorkflowError(
      "Zapier connections must use the official mcp.zapier.com endpoint.",
    );
  if (
    provider === "make" &&
    !/^(eu1|eu2|us1|us2)\.make\.com$/i.test(u.hostname)
  )
    throw new WorkflowError("Make connections must use a make.com endpoint.");
  if (provider === "n8n" && privateAddress(u.hostname) && !allowPrivateNetwork)
    throw new WorkflowError(
      "Private-network n8n requires the deliberate LAN access option.",
    );
  return value;
}

export async function saveWorkflowIntegration(
  db: Db,
  key: MasterKey,
  args: {
    provider: WorkflowProvider;
    name: string;
    baseUrl?: string;
    token: string;
    actorUserId: string;
    allowPrivateNetwork?: boolean;
    workspaceId?: string;
    workspaceType?: "team" | "organization";
    fetchImpl?: typeof fetch;
  },
) {
  if (!isWorkflowProvider(args.provider) || !args.name.trim() || !args.token)
    throw new WorkflowError("Provider, name, and credential are required.");
  const base = safeBase(
    args.provider,
    args.baseUrl ?? "",
    args.allowPrivateNetwork === true,
  );
  // Hosted n8n must resolve entirely to public addresses. A self-hosted LAN
  // endpoint is accepted only behind the explicit operator switch above.
  if (args.provider === "n8n" && !args.allowPrivateNetwork && !args.fetchImpl)
    await assertPublicHost(new URL(base).hostname);
  if (
    args.provider === "make" &&
    (!args.workspaceId || !/^\d+$/.test(args.workspaceId))
  )
    throw new WorkflowError("Make requires a numeric team or organization id.");
  const identity = await testWorkflowCredential({
    provider: args.provider,
    baseUrl: base,
    token: args.token,
    workspaceId: args.workspaceId,
    workspaceType: args.workspaceType,
    fetchImpl:
      args.fetchImpl ??
      (args.provider === "n8n" && !args.allowPrivateNetwork
        ? publicWorkflowFetch
        : fetch),
  });
  // Reserve the stable provider/name identity before writing Vault slots. Two
  // administrators cannot create competing slot ids for the same connection.
  const [existing]=await db.query<WorkflowIntegration>(`insert into workflow_integrations(id,provider,name,base_url,credentials_enc,callback_secret_enc,created_by,status,enabled)
    values($1,$2,$3,$4,'','',$5,'error',false) on conflict(provider,name) do update set enabled=false returning *`,[randomUUID(),args.provider,args.name.trim(),base,args.actorUserId]);
  const id=existing.id,owner=existing.created_by;
  const secret=existing.callback_secret_enc&&existing.status!=='disconnected'?(await workflowSecret<{secret:string}>(db,key,existing,'callback')).secret:randomBytes(32).toString('base64url');
  const credential = await storeCredentialPayload(db, key, {
    ownerUserId: owner,
    kind: "api_key",
    service: `workflow.${args.provider}`,
    slot: id,
    label: args.name,
    payload: {
      token: args.token,
      workspaceId: args.workspaceId,
      workspaceType: args.workspaceType,
    },
    actorUserId: args.actorUserId,
  });
  const callback = await storeCredentialPayload(db, key, {
    ownerUserId: owner,
    kind: "api_key",
    service: `workflow.${args.provider}`,
    slot: `${id}.callback`,
    label: `${args.name} callback`,
    payload: { secret },
    actorUserId: args.actorUserId,
  });
  const rows = await db.query<WorkflowIntegration>(
    `insert into workflow_integrations(id,provider,name,base_url,credentials_enc,callback_secret_enc,created_by,allow_private_network,account_identity,workspace_identity,status,last_check_at,last_check_ok)
    values($10,$1,$2,$3,$4,$5,$6,$7,$8,$9,'active',now(),true) on conflict(provider,name) do update set base_url=excluded.base_url,credentials_enc=excluded.credentials_enc,callback_secret_enc=excluded.callback_secret_enc,allow_private_network=excluded.allow_private_network,account_identity=excluded.account_identity,workspace_identity=excluded.workspace_identity,status='active',enabled=false,last_check_at=now(),last_check_ok=true,updated_at=now() returning *`,
    [
      args.provider,
      args.name.trim(),
      base,
      credential,
      callback,
      owner,
      args.allowPrivateNetwork === true,
      identity.account,
      identity.workspace,
      id,
    ],
  );
  // A credential rotation must not silently rotate the callback verifier: the
  // provider still has the old value until the operator explicitly changes it.
  await db.query(
    `update workflow_definitions set exposed=false where integration_id=$1`,
    [id],
  );
  const callbackSecret = secret;
  return { ...rows[0], callbackSecret };
}
async function workflowSecret<T extends object>(
  db: Db,
  key: MasterKey,
  row: WorkflowIntegration,
  kind: "credential" | "callback",
): Promise<T> {
  return openCredentialPayload<T>(db, key, {
    ownerUserId: row.created_by,
    service: `workflow.${row.provider}`,
    slot: kind === "callback" ? `${row.id}.callback` : row.id,
    stored: kind === "callback" ? row.callback_secret_enc : row.credentials_enc,
  });
}
const auth = (p: WorkflowProvider, token: string): Record<string, string> =>
  p === "n8n"
    ? { "X-N8N-API-KEY": token }
    : { Authorization: p === "make" ? `Token ${token}` : `Bearer ${token}` };
const makeQuery = (c: Credentials) =>
  `${c.workspaceType === "organization" ? "organizationId" : "teamId"}=${encodeURIComponent(c.workspaceId ?? "")}`;
const discoveryPath = (p: WorkflowProvider, c: Credentials) =>
  p === "zapier"
    ? "/api/v1/connect"
    : p === "n8n"
      ? "/api/v1/workflows?active=true"
      : `/api/v2/scenarios?${makeQuery(c)}&isActive=true`;
async function mcpRequest(
  baseUrl: string,
  token: string,
  method: string,
  params: unknown,
  fetchImpl: typeof fetch,
) {
  let session: string | null = null;
  let protocol: string | null = null;
  async function send(
    method: string,
    params: unknown,
    notification = false,
  ): Promise<any> {
    const id = notification ? undefined : randomBytes(8).toString("hex");
    const response = await fetchImpl(`${baseUrl}/api/v1/connect`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(session ? { "Mcp-Session-Id": session } : {}),
        ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new WorkflowError(
        `Zapier rejected the MCP request (${response.status}).`,
        502,
      );
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new WorkflowError("Zapier returned an empty response.", 502);
    const decoder = new TextDecoder();
    let text = "",
      size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 512 * 1024)
          throw new WorkflowError(
            "Zapier response exceeded the size limit.",
            502,
          );
        text = (text + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, "\n");
        if (
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          let boundary: number;
          while ((boundary = text.indexOf("\n\n")) >= 0) {
            const event = text.slice(0, boundary);
            text = text.slice(boundary + 2);
            const data = event
              .split("\n")
              .filter((x) => x.startsWith("data:"))
              .map((x) => x.slice(5).trim())
              .join("\n");
            if (!data) continue;
            const body = JSON.parse(data);
            if (body.id === id) return body;
          }
        }
      }
      const body = JSON.parse(text);
      if (body.id !== id)
        throw new WorkflowError("Zapier returned a mismatched response.", 502);
      return body;
    } finally {
      await reader.cancel();
    }
  }
  const init = await send("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "josi-ce", version: "1.0" },
  });
  if (init.error || !init.result?.protocolVersion)
    throw new WorkflowError("Zapier MCP initialization failed.", 502);
  protocol = init.result.protocolVersion;
  await send("notifications/initialized", {}, true);
  return send(method, params);
}

export async function testWorkflowCredential(args: {
  provider: WorkflowProvider;
  baseUrl: string;
  token: string;
  workspaceId?: string;
  workspaceType?: "team" | "organization";
  fetchImpl?: typeof fetch;
}) {
  if (args.provider === "zapier") {
    const body = await mcpRequest(
      args.baseUrl,
      args.token,
      "tools/list",
      {},
      args.fetchImpl ?? fetch,
    );
    if (body.error)
      throw new WorkflowError("Zapier rejected the connection token.", 422);
    return {
      ok: true as const,
      account: "Zapier MCP connection",
      workspace: null,
    };
  }
  const credentials = {
    token: args.token,
    workspaceId: args.workspaceId,
    workspaceType: args.workspaceType,
  };
  const response = await (args.fetchImpl ?? fetch)(
    args.baseUrl + discoveryPath(args.provider, credentials),
    {
      headers: {
        accept: "application/json",
        ...auth(args.provider, args.token),
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok)
    throw new WorkflowError(
      `${args.provider} rejected the credential (${response.status}).`,
      422,
    );
  await response.json().catch(() => ({}));
  return {
    ok: true as const,
    account: args.provider === "n8n" ? "n8n API key" : null,
    workspace:
      args.provider === "make"
        ? `${args.workspaceType ?? "team"}:${args.workspaceId}`
        : new URL(args.baseUrl).host,
  };
}
const parseList = (p: WorkflowProvider, b: any): any[] =>
  p === "zapier"
    ? (b.result?.tools ?? [])
    : p === "n8n"
      ? (b.data ?? [])
      : (b.scenarios ?? []);
function makeSchema(fields: any[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {},
    required: string[] = [];
  for (const field of fields) {
    if (typeof field.name !== "string")
      throw new WorkflowError("Make returned an invalid input interface.", 502);
    const types: Record<string, string> = {
      text: "string",
      number: "number",
      integer: "integer",
      uinteger: "integer",
      boolean: "boolean",
      array: "array",
      collection: "object",
      date: "string",
      buffer: "string",
    };
    const type = types[field.type];
    if (!type)
      throw new WorkflowError(
        "This Make input type is not supported; adjust the scenario interface.",
        422,
      );
    properties[field.name] =
      type === "object"
        ? makeSchema(field.spec ?? [])
        : type === "array"
          ? {
              type,
              items: field.spec
                ? { type: types[field.spec.type] ?? "string" }
                : {},
            }
          : { type };
    if (field.required) required.push(field.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}
export async function discoverWorkflows(db:Db,key:MasterKey,integration:WorkflowIntegration,fetchImpl:typeof fetch=fetch):Promise<WorkflowDefinition[]>{
 try{return await discoverWorkflowsImpl(db,key,integration,fetchImpl);}catch{
  await db.query(`update workflow_integrations set status='error',enabled=false,last_check_at=now(),last_check_ok=false where id=$1`,[integration.id]);
  throw new WorkflowError('Workflow discovery failed. Recheck the credential, permissions and provider availability.',502);
 }
}
async function discoverWorkflowsImpl(
  db: Db,
  key: MasterKey,
  integration: WorkflowIntegration,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowDefinition[]> {
  if (
    integration.provider === "n8n" &&
    !integration.allow_private_network &&
    fetchImpl === fetch
  )
    fetchImpl = publicWorkflowFetch;
  const credentials = await workflowSecret<Credentials>(
    db,
    key,
    integration,
    "credential",
  );
  const { token } = credentials;
  const items:any[]=[];let cursor:string|undefined,offset=0;
  for(let page=0;page<5;page++){
    let body:any;
    if(integration.provider==='zapier'){
      body=await mcpRequest(integration.base_url,token,'tools/list',cursor?{cursor}:{},fetchImpl);
      if(body.error||!Array.isArray(body.result?.tools))throw new WorkflowError('Zapier returned no tool catalog.',502);
    }else{
      const suffix=integration.provider==='n8n'?`&limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`:`&pg[limit]=100&pg[offset]=${offset}`;
      const response=await fetchImpl(integration.base_url+discoveryPath(integration.provider,credentials)+suffix,{headers:{accept:'application/json',...auth(integration.provider,token)},redirect:'error',signal:AbortSignal.timeout(20_000)});
      if(!response.ok)throw new WorkflowError('Provider discovery failed.',502);
      body=await response.json();
      if(!Array.isArray(integration.provider==='n8n'?body.data:body.scenarios))throw new WorkflowError('Provider returned no workflow catalog.',502);
    }
    const batch=parseList(integration.provider,body);items.push(...batch);
    cursor=integration.provider==='zapier'?body.result.nextCursor:body.nextCursor;offset+=batch.length;
    const more=integration.provider==='make'?batch.length===100:!!cursor;
    if(!more)break;
    if(page===4)throw new WorkflowError('The catalog exceeds 500 workflows; narrow the provider connection.',422);
  }
  const found: WorkflowDefinition[] = [];
  for (const item of items) {
    const external = String(item.id ?? item.name ?? item.scenarioId ?? "");
    if (!external) continue;
    const execution = integration.provider === "n8n" ? "" : external;
    let schema = item.inputSchema ??
      item.input_schema ?? { type: "object", properties: {} };
    if (integration.provider === "make") {
      const response = await fetchImpl(
        `${integration.base_url}/api/v2/scenarios/${encodeURIComponent(external)}/interface`,
        {
          headers: { accept: "application/json", ...auth("make", token) },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok)
        throw new WorkflowError("Make input interface discovery failed.", 502);
      const body: any = await response.json();
      if (!Array.isArray(body.interface?.input))
        throw new WorkflowError("Make returned no input interface.", 502);
      schema = makeSchema(body.interface.input);
    }

    const [row] = await db.query<WorkflowDefinition>(
      `insert into workflow_definitions(integration_id,external_id,name,description,input_schema,execution_ref,active)
      values($1,$2,$3,$4,$5,$6,true) on conflict(integration_id,external_id) do update set name=excluded.name,description=excluded.description,input_schema=case when excluded.execution_ref='' then workflow_definitions.input_schema else excluded.input_schema end,execution_ref=case when excluded.execution_ref='' then workflow_definitions.execution_ref else excluded.execution_ref end,active=true,discovered_at=now() returning *`,
      [
        integration.id,
        external,
        String(item.name ?? item.title ?? "Workflow"),
        item.description ?? null,
        json(schema),
        execution,
      ],
    );
    found.push(row);
  }
  await db.query(
    `update workflow_definitions set active=false where integration_id=$1 and not(external_id=any($2::text[]))`,
    [integration.id, found.map((x) => x.external_id)],
  );
  await db.query(
    `update workflow_integrations set status='active',last_check_at=now(),last_check_ok=true where id=$1`,
    [integration.id],
  );
  return found;
}

const schemaValidator = new Ajv({
  strict: false,
  allErrors: true,
  validateFormats: false,
});
export function validateWorkflowInput(
  schema: Record<string, unknown>,
  input: unknown,
) {
  try {
    const validate = schemaValidator.compile(schema);
    if (!validate(input)) throw new Error("invalid");
  } catch {
    throw new WorkflowError(
      "Workflow input is invalid or its provider schema is unsupported.",
      422,
    );
  }
  return true;
}
export function previewWorkflowRun(
  workflow: WorkflowDefinition,
  input: Record<string, unknown>,
) {
  validateWorkflowInput(workflow.input_schema, input);
  return {
    workflow: { id: workflow.external_id, name: workflow.name },
    input,
    requiresApproval: true,
  };
}
export async function registerN8nWebhook(
  db: Db,
  integrationId: string,
  workflowId: string,
  path: string,
  inputSchema: Record<string, unknown>,
) {
  if (!/^\/webhook\/[A-Za-z0-9._~/-]+$/.test(path) || path.includes(".."))
    throw new WorkflowError(
      "Enter an n8n production webhook path beginning with /webhook/.",
    );
  try {
    schemaValidator.compile(inputSchema);
  } catch {
    throw new WorkflowError("Enter a valid JSON input schema.", 422);
  }
  const rows = await db.query<WorkflowDefinition>(
    `update workflow_definitions set execution_ref=$3,input_schema=$4 where integration_id=$1 and external_id=$2 and exists(select 1 from workflow_integrations i where i.id=$1 and i.provider='n8n') returning *`,
    [integrationId, workflowId, path, json(inputSchema)],
  );
  if (!rows.length) throw new WorkflowError("Workflow not found.", 404);
  return rows[0];
}
export async function disconnectWorkflowIntegration(db: Db, id: string) {
  const rows = await db.query(
    `update workflow_integrations set enabled=false,status='disconnected',credentials_enc='',last_check_ok=false,updated_at=now() where id=$1 returning id,provider,created_by`,
    [id],
  );
  if (!rows.length) throw new WorkflowError("Integration not found.", 404);
  await db.query(
    `update workflow_definitions set exposed=false where integration_id=$1`,
    [id],
  );
  for (const slot of [id, `${id}.callback`])
    await deleteVaultSlot(db, {
      ownerUserId: String(rows[0].created_by),
      service: `workflow.${rows[0].provider}`,
      slot,
      actorUserId: String(rows[0].created_by),
    });
  return { disconnected: true };
}

function workflowBoundary(row: any): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.provider,
        row.base_url,
        row.credentials_enc,
        row.execution_ref,
        row.input_schema,
      ]),
    )
    .digest("hex");
}

export async function requestWorkflowRun(
  db: Db,
  key: MasterKey,
  args: {
    integration: WorkflowIntegration;
    workflow: WorkflowDefinition;
    ownerUserId: string;
    threadId?: string | null;
    input: Record<string, unknown>;
  },
) {
  if (args.threadId) {
    const [thread] = await db.query(
      `select id from threads where id=$1 and owner_user_id=$2`,
      [args.threadId, args.ownerUserId],
    );
    if (!thread) throw new WorkflowError("Thread not found.", 404);
  }
  validateWorkflowInput(args.workflow.input_schema, args.input);
  const canonical = JSON.stringify(args.input);
  const hash = createHash("sha256").update(canonical).digest("hex");
  if (Buffer.byteLength(canonical) > 64 * 1024)
    throw new WorkflowError("Workflow input is larger than 64 KB.", 413);
  const [run] = await db.query<WorkflowRun>(
    `insert into workflow_runs(integration_id,external_workflow_id,owner_user_id,thread_id,status,input_enc,input_hash,expires_at)
    values($1,$2,$3,$4,'pending',$5,$6,now()+interval '15 minutes') returning *`,
    [
      args.integration.id,
      args.workflow.external_id,
      args.ownerUserId,
      args.threadId ?? null,
      seal(key, {
        input: args.input,
        boundary: workflowBoundary({ ...args.integration, ...args.workflow }),
      }),
      hash,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: "agent",
    kind: "workflow.run_requested",
    subjectType: "workflow_run",
    subjectId: run.id,
    payload: {
      provider: args.integration.provider,
      workflow: args.workflow.name,
    },
  });
  return run;
}
export async function executeWorkflowRun(
  db: Db,
  key: MasterKey,
  args: {
    runId: string;
    ownerUserId: string;
    approve: boolean;
    fetchImpl?: typeof fetch;
  },
) {
  await db.query(
    `update workflow_runs set status='expired',finished_at=now(),error_category='approval_expired' where status='pending' and expires_at<now()`,
  );
  if (!UUID.test(args.runId))
    throw new WorkflowError("There is no workflow request with that id.", 404);
  const rows = await db.query<any>(
    `select r.*,i.provider,i.created_by,i.base_url,i.credentials_enc,i.callback_secret_enc,i.status as integration_status,i.enabled,i.allow_private_network,w.active,w.exposed,w.input_schema,w.execution_ref from workflow_runs r join workflow_integrations i on i.id=r.integration_id join workflow_definitions w on w.integration_id=r.integration_id and w.external_id=r.external_workflow_id where r.id=$1 and r.owner_user_id=$2`,
    [args.runId, args.ownerUserId],
  );
  const row = rows[0];
  if (!row)
    throw new WorkflowError("There is no workflow request with that id.", 404);
  if (
    row.integration_status !== "active" ||
    !row.credentials_enc ||
    !row.enabled ||
    !row.active ||
    !row.exposed
  )
    throw new WorkflowError("That workflow provider is disconnected.", 409);
  if (row.provider === "n8n" && !row.execution_ref)
    throw new WorkflowError(
      "This n8n workflow has no registered production webhook.",
      409,
    );
  if (row.status !== "pending" || new Date(row.expires_at) < new Date())
    throw new WorkflowError(
      "That workflow request is no longer awaiting approval.",
      409,
    );
  if (!args.approve) {
    await db.query(
      `update workflow_runs set status='denied',decided_at=now() where id=$1 and status='pending'`,
      [row.id],
    );
    return { status: "denied" };
  }
  const claimed = await db.query<any>(
    `update workflow_runs set status='running',decided_at=now(),started_at=now() where id=$1 and status='pending' returning *`,
    [row.id],
  );
  if (!claimed.length)
    throw new WorkflowError("That workflow request was already decided.", 409);
  const { input, boundary } = openSealed<{
    input: Record<string, unknown>;
    boundary: string;
  }>(key, row.input_enc);
  if (boundary !== workflowBoundary(row)) {
    await db.query(
      `update workflow_runs set status='denied',error_category='authorization_changed' where id=$1`,
      [row.id],
    );
    throw new WorkflowError(
      "Workflow authorization changed. Prepare a new request.",
      409,
    );
  }
  validateWorkflowInput(row.input_schema, input);
  const { token } = await workflowSecret<Credentials>(
    db,
    key,
    { ...row, id: row.integration_id },
    "credential",
  );
  try {
    if (row.provider === "n8n" && !row.allow_private_network && !args.fetchImpl)
      await assertPublicHost(new URL(row.base_url).hostname);
    let body: any;
    if (row.provider === "zapier")
      body = await mcpRequest(
        row.base_url,
        token,
        "tools/call",
        { name: row.execution_ref, arguments: input },
        args.fetchImpl ?? fetch,
      );
    else {
      const path =
        row.provider === "n8n"
          ? row.execution_ref
          : `/api/v2/scenarios/${encodeURIComponent(row.execution_ref)}/run`;
      const payload =
        row.provider === "make" ? { data: input, responsive: true } : input;
      const response = await (
        args.fetchImpl ??
        (row.provider === "n8n" && !row.allow_private_network
          ? publicWorkflowFetch
          : fetch)
      )(row.base_url + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Josi-Run-Id": row.id,
          ...(row.provider === "n8n"
            ? {
                "X-Josi-Workflow-Key": (
                  await workflowSecret<{ secret: string }>(
                    db,
                    key,
                    { ...row, id: row.integration_id },
                    "callback",
                  )
                ).secret,
              }
            : auth(row.provider, token)),
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(row.provider === "make" ? 45_000 : 20_000),
      });
      body = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new WorkflowError(
          `The ${row.provider} workflow refused the request (${response.status}).`,
          502,
        );
    }
    if (
      body.error ||
      body.result?.isError ||
      body.status === "3" ||
      body.status === 3
    )
      throw new WorkflowError(
        `The ${row.provider} workflow reported a failure.`,
        502,
      );
    const external =
      String(
        body.id ??
          body.run_id ??
          body.executionId ??
          (row.provider === "n8n" ? row.id : ""),
      ) || null;
    const completed =
      row.provider === "zapier" ||
      body.status === "succeeded" ||
      body.status === "success" ||
      body.status === "1" ||
      body.status === 1 ||
      body.status === "2" ||
      body.status === 2;
    await db.query(
      `update workflow_runs set status=$2,external_run_id=$3,finished_at=case when $2='succeeded' then now() else null end,result_summary=case when $2='succeeded' then 'Provider reported successful completion.' else null end where id=$1`,
      [row.id, completed ? "succeeded" : "running", external],
    );
    await appendEvent(db, {
      actorUserId: args.ownerUserId,
      actor: "user",
      kind: "workflow.run_executed",
      subjectType: "workflow_run",
      subjectId: row.id,
      payload: {
        provider: row.provider,
        status: completed ? "succeeded" : "running",
      },
    });
    return {
      status: completed ? "succeeded" : "running",
      runId: row.id,
      externalRunId: external,
    };
  } catch (e) {
    await db.query(
      `update workflow_runs set status='failed',error_category='provider_error',finished_at=now() where id=$1`,
      [row.id],
    );
    throw new WorkflowError(
      "The provider request failed. Check connection health before preparing a new run.",
      502,
    );
  }
}
export async function verifyWorkflowCallback(
  db: Db,
  key: MasterKey,
  integration: WorkflowIntegration,
  rawBody: string,
  signature: string,
  timestamp?: string,
): Promise<boolean> {
  if (!timestamp) return false;
  const seconds = Number(timestamp);
  if (
    !Number.isFinite(seconds) ||
    Math.abs(Date.now() - seconds * 1000) > 5 * 60_000
  )
    return false;
  const { secret } = await workflowSecret<{ secret: string }>(
    db,
    key,
    integration,
    "callback",
  );
  const supplied = signature.replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return (
    /^[a-f0-9]{64}$/.test(supplied) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  );
}
export async function recordWorkflowCallback(db:Db,args:{integrationId:string;externalRunId:string;status:'succeeded'|'failed';summary?:string;eventId?:string}) {
 const rows=await db.query<WorkflowRun>(`with claimed as (
   insert into workflow_callback_events(integration_id,event_id)
   select $1,$5 where exists(select 1 from workflow_runs where integration_id=$1 and external_run_id=$2 and status='running')
   on conflict do nothing returning event_id
 ) update workflow_runs set status=$3,result_summary=$4,error_category=case when $3='failed' then 'provider_error' else null end,finished_at=now()
 where integration_id=$1 and external_run_id=$2 and status='running' and exists(select 1 from claimed) returning *`,[
 args.integrationId,args.externalRunId,args.status,args.status==='succeeded'?'Provider reported successful completion.':'Provider reported a failure.',args.eventId??randomUUID()]);
 if(!rows.length)throw new WorkflowError('No running workflow matches this callback.',404);
 return rows[0];
}
export const workflowHistory = async (db: Db, ownerUserId: string) => {
  await db.query(`update workflow_runs set status='expired',finished_at=now(),error_category='approval_expired' where owner_user_id=$1 and status='pending' and expires_at<now()`,[ownerUserId]);
  await db.query(
    `delete from workflow_callback_events where received_at<now()-interval '30 days'`,
  );
  await db.query(
    `delete from workflow_runs where created_at<now()-interval '30 days'`,
  );
  return db.query<WorkflowRun>(
    `select id,integration_id,external_workflow_id,owner_user_id,status,external_run_id,result_summary,error_category,created_at from workflow_runs where owner_user_id=$1 order by created_at desc limit 100`,
    [ownerUserId],
  );
};
