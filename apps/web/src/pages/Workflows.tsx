import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Input } from "@/components/ui";
import { plain } from "@/lib/plainLanguage";
type Flow = {
  integration_id: string;
  external_id: string;
  name: string;
  description: string | null;
  provider: string;
  integration_name: string;
};
type Run = {
  id: string;
  external_workflow_id: string;
  status: string;
  result_summary: string | null;
  created_at: string;
};
export function Workflows() {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown>>({});
  const load = useCallback(
    () =>
      Promise.all([
        api.get<{ workflows: Flow[] }>("/workflows"),
        api.get<{ runs: Run[] }>("/workflows/history"),
      ])
        .then(([a, b]) => {
          setFlows(a.workflows);
          setRuns(b.runs);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function prepare(f: Flow) {
    if (busy) return;
    setBusy(true);
    try {
      let input = {};
      if (inputs[`${f.integration_id}:${f.external_id}`]?.trim())
        input = JSON.parse(inputs[`${f.integration_id}:${f.external_id}`]);
      await api.post(
        `/workflows/${f.integration_id}/${encodeURIComponent(f.external_id)}/request`,
        { input },
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not prepare workflow");
    } finally {
      setBusy(false);
    }
  }
  async function decide(id: string, approve: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (approve && !preview[id]) {
        const value = await api.get(`/workflows/runs/${id}/preview`);
        setPreview({ ...preview, [id]: value });
        return;
      }
      await api.post(`/workflows/runs/${id}/decide`, { approve });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decide workflow");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Automation workflows</h1>
        <p className="text-sm text-muted-foreground">
          Native Zapier, n8n, and Make workflows discovered by an administrator.
          Every run waits for your approval.
        </p>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid gap-4">
        {flows.map((f) => (
          <Card key={`${f.integration_id}:${f.external_id}`}>
            <CardTitle>{f.name}</CardTitle>
            <p className="text-sm">
              {plain("workflow_provider", f.provider)} · {f.integration_name}
            </p>
            {f.description && (
              <p className="text-sm text-muted-foreground">{f.description}</p>
            )}
            <label className="mt-3 block text-sm">
              Input (JSON)
              <Input
                value={inputs[`${f.integration_id}:${f.external_id}`] ?? "{}"}
                onChange={(e) =>
                  setInputs({ ...inputs, [`${f.integration_id}:${f.external_id}`]: e.target.value })
                }
              />
            </label>
            <Button
              disabled={busy}
              className="mt-3"
              onClick={() => void prepare(f)}
            >
              Prepare for approval
            </Button>
          </Card>
        ))}
      </div>
      <section>
        <h2 className="font-semibold">Run history and approvals</h2>
        {runs.map((r) => (
          <Card key={r.id}>
            <p className="text-sm">
              <strong>{r.external_workflow_id}</strong> —{" "}
              {plain("workflow_run_status", r.status)}
            </p>
            {r.result_summary && <p>{r.result_summary}</p>}
            {r.status === "pending" && (
              <div className="mt-2 flex gap-2">
                <>
                  {preview[r.id] && (
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(preview[r.id], null, 2)}
                    </pre>
                  )}
                  <Button
                    disabled={busy}
                    onClick={() => void decide(r.id, true)}
                  >
                    {preview[r.id] ? "Approve exact run" : "Review exact input"}
                  </Button>
                </>
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() => void decide(r.id, false)}
                >
                  Deny
                </Button>
              </div>
            )}
          </Card>
        ))}
      </section>
    </div>
  );
}
