import { useUnsavedChanges } from '@/lib/useUnsavedChanges';
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Input } from "@/components/ui";
import { plain } from "@/lib/plainLanguage";
type Integration = {
  id: string;
  provider: string;
  name: string;
  base_url: string;
  enabled: boolean;
  allow_private_network: boolean;
  account_identity: string | null;
  workspace_identity: string | null;
  status: string;
  last_check_ok: boolean | null;
};
type Workflow = {
  integration_id: string;
  external_id: string;
  name: string;
  active: boolean;
  exposed: boolean;
  execution_ref: string;
};

export function AdminWorkflows() {
  const [items, setItems] = useState<Integration[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [provider, setProvider] = useState("zapier");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [allowPrivateNetwork, setAllowPrivateNetwork] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceType, setWorkspaceType] = useState<"team" | "organization">(
    "team",
  );
  const [schemas,setSchemas]=useState<Record<string,string>>({});
  const [webhookPaths, setWebhookPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [callbackSecret, setCallbackSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  useUnsavedChanges(!!(name || token || Object.values(webhookPaths).some(Boolean) || Object.values(schemas).some(Boolean)));
  const load = useCallback(
    () =>
      api
        .get<{ integrations: Integration[]; workflows: Workflow[] }>(
          "/admin/workflows",
        )
        .then((r) => {
          setItems(r.integrations);
          setWorkflows(r.workflows);
        })
        ,
    [],
  );
  useEffect(() => {
    void load().catch(e=>setError(e.message));
  }, [load]);
  async function save() {
    if(busy)return;
    setBusy(true);
    setSaved("");
    setError("");
    try {
      const r = await api.post<{ callbackSecret: string }>("/admin/workflows", {
        provider,
        name,
        baseUrl,
        token,
        allowPrivateNetwork,
        workspaceId,
        workspaceType,
      });
      setCallbackSecret(r.callbackSecret);
      await load();
      setToken("");setName("");
      setSaved("Provider verified and saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not verify and save");
    } finally {
      setBusy(false);
    }
  }
  async function discover(id: string) {
    if(busy)return;setBusy(true);setSaved("");
    try {
      await api.post(`/admin/workflows/${id}/discover`, {});
      await load();setSaved("Changes saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not discover workflows");
    } finally {setBusy(false);}
  }
  async function expose(flow: Workflow) {
    if(busy)return;setBusy(true);setSaved("");
    try {
      await api.put(
        `/admin/workflows/${flow.integration_id}/workflows/${encodeURIComponent(flow.external_id)}/exposure`,
        { exposed: !flow.exposed },
      );
      await load();setSaved("Changes saved.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not change workflow exposure",
      );
    } finally {setBusy(false);}
  }
  async function disconnect(id: string) {
    if(busy)return;setBusy(true);setSaved("");
    try {
      await api.del(`/admin/workflows/${id}`);
      await load();setSaved("Changes saved.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not disconnect provider",
      );
    } finally {setBusy(false);}
  }
  async function registerWebhook(flow: Workflow) {
    if(busy)return;
    const path = webhookPaths[`${flow.integration_id}:${flow.external_id}`]?.trim() ?? "";
    if (!/^\/webhook\/[A-Za-z0-9._~/-]+$/.test(path) || path.includes("..")) {
      setError(
        "Use an n8n production path beginning with /webhook/. Test webhooks and parent-directory paths are not accepted.",
      );
      return;
    }
    setBusy(true);setSaved("");
    try {
      setError("");
      await api.put(
        `/admin/workflows/${flow.integration_id}/workflows/${encodeURIComponent(flow.external_id)}/n8n-webhook`,
        { path, inputSchema: JSON.parse(schemas[`${flow.integration_id}:${flow.external_id}`] || '{"type":"object","properties":{}}') },
      );
      setWebhookPaths((current) => ({ ...current, [`${flow.integration_id}:${flow.external_id}`]: "" }));
      await load();setSaved("Changes saved.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not register n8n webhook",
      );
    } finally {setBusy(false);}
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Native workflow providers</h1>
        <p className="text-sm text-muted-foreground">
          Zapier uses its official MCP connection token. Make uses its API token
          and team/organization identity. n8n uses its public API plus a
          registered production webhook for each callable workflow.
        </p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {saved && <p role="status">{saved}</p>}
      <Card>
        <CardTitle>Add or reconnect provider</CardTitle>
        <label className="block text-sm">
          Provider
          <select
            className="mt-1 block rounded border p-2"
            value={provider}
            onChange={(e) => {if((name || token) && !window.confirm("Discard unsaved provider changes?"))return;setProvider(e.target.value);setName("");setToken("");setBaseUrl("");setCallbackSecret("");}}
          >
            <option value="zapier">Zapier</option>
            <option value="n8n">n8n</option>
            <option value="make">Make</option>
          </select>
        </label>
        <label className="block text-sm">
          Name
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {provider === "n8n" && (
          <>
            <label className="block text-sm">
              n8n URL
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
            <label className="my-2 flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowPrivateNetwork}
                onChange={(e) => setAllowPrivateNetwork(e.target.checked)}
              />
              Allow this self-hosted n8n server on the private network
            </label>
            {allowPrivateNetwork && (
              <p className="text-sm text-muted-foreground">
                Only enable this for a server you control. Josi will be allowed
                to send workflow data to that LAN address.
              </p>
            )}
          </>
        )}
        {provider === "make" && (<><label className="block text-sm">Make region URL<Input placeholder="https://us1.make.com" value={baseUrl} onChange={e=>setBaseUrl(e.target.value)}/></label>
          <div className="flex gap-2">
            <label className="block text-sm">
              Workspace type
              <select
                value={workspaceType}
                onChange={(e) =>
                  setWorkspaceType(e.target.value as "team" | "organization")
                }
              >
                <option value="team">Team</option>
                <option value="organization">Organization</option>
              </select>
            </label>
            <label className="block text-sm">
              Workspace ID
              <Input
                inputMode="numeric"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              />
            </label>
          </div></>
        )}
        <label className="block text-sm">
          {provider === "zapier" ? "MCP connection token" : "API credential"}
          <Input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <Button
          disabled={
            !name || !token || busy || (provider === "make" && !workspaceId)
          }
          onClick={() => void save()}
        >
          {busy ? "Testing credential…" : "Test and save provider"}
        </Button>
        {callbackSecret && (
          <p className="mt-2 text-sm">
            Callback signing secret (shown once): <code>{callbackSecret}</code>
          </p>
        )}
      </Card>
      {items.map((i) => (
        <Card key={i.id}>
          <CardTitle>{i.name}</CardTitle>
          <p className="text-sm">
            {plain("workflow_provider", i.provider)} · {plain("workflow_integration_status", i.status)}
            {i.account_identity ? ` · ${i.account_identity}` : ""}
            {i.workspace_identity ? ` · ${i.workspace_identity}` : ""}
          </p>
          <div className="flex gap-2">
            <Button disabled={busy || i.status === "disconnected"} onClick={() => void discover(i.id)}>
              Discover workflows
            </Button>
            <Button disabled={busy} variant="secondary" onClick={() => void disconnect(i.id)}>
              Disconnect
            </Button>
          </div>
          <div className="mt-3 space-y-2">
            {workflows
              .filter((w) => w.integration_id === i.id)
              .map((w) => (
                <div
                  key={w.external_id}
                  className="flex items-center justify-between gap-3 border-t pt-2"
                >
                  <span className="text-sm">{w.name}</span>
                  {i.provider === "n8n" && !w.execution_ref ? (
                    <div className="min-w-0 flex-1">
                      <label className="text-sm">
                        Production webhook path
                        <Input
                          placeholder="/webhook/your-production-path"
                          value={webhookPaths[`${w.integration_id}:${w.external_id}`] ?? ""}
                          onChange={(event) =>
                            setWebhookPaths((current) => ({
                              ...current,
                              [`${w.integration_id}:${w.external_id}`]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Copy the production path from an active n8n Webhook
                        node. Test webhook paths are refused.
                      </p>
                      <label className="block text-sm">Input JSON Schema<Input value={schemas[`${w.integration_id}:${w.external_id}`]??'{"type":"object","properties":{}}'} onChange={e=>setSchemas({...schemas,[`${w.integration_id}:${w.external_id}`]:e.target.value})}/></label>
                      <Button
                        className="mt-2"
                        variant="secondary"
                        disabled={
                          busy || !/^\/webhook\/[A-Za-z0-9._~/-]+$/.test(
                            webhookPaths[`${w.integration_id}:${w.external_id}`] ?? "",
                          ) ||
                          (webhookPaths[`${w.integration_id}:${w.external_id}`] ?? "").includes("..")
                        }
                        onClick={() => void registerWebhook(w)}
                      >
                        Register webhook
                      </Button>
                    </div>
                  ) : (
                    <Button disabled={busy} variant="secondary" onClick={() => void expose(w)}>
                      {w.exposed ? "Remove from Josi" : "Expose to Josi"}
                    </Button>
                  )}
                </div>
              ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
