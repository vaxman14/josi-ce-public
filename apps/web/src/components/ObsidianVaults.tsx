import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, CardTitle, ErrorNote, Input } from "@/components/ui";
export function ObsidianVaults() {
  const [vaults, setVaults] = useState<{ path: string; name: string }[]>([]),
    [vault, setVault] = useState(""),
    [note, setNote] = useState(""),
    [markdown, setMarkdown] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  async function discover() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.get<{
        available: boolean;
        vaults: { path: string; name: string }[];
      }>("/connections/developer/obsidian-vaults");
      setVaults(r.vaults);
      setStatus(
        r.available
          ? `${r.vaults.length} workspace vaults found.`
          : "Configure the Local Workspace mount through Network & address first.",
      );
    } catch {
      setError("Could not inspect the workspace.");
    } finally {
      setBusy(false);
    }
  }
  async function read() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.get<{ markdown: string }>(
        `/connections/developer/obsidian-note?vault=${encodeURIComponent(vault)}&note=${encodeURIComponent(note)}`,
      );
      setMarkdown(r.markdown);
    } catch {
      setError("Choose an accessible Markdown note within the selected vault.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardTitle>Obsidian workspace vaults</CardTitle>
      <p className="text-sm">
        Native read-only Markdown access for administrators through the
        installer’s workspace mount. Attachments and .obsidian settings remain
        untouched. No Sync credential is required.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button disabled={busy} onClick={() => void discover()}>
        Discover vaults
      </Button>
      <p role="status">{status}</p>
      {vaults.length > 0 && (
        <>
          <label className="block">
            Vault
            <select
              value={vault}
              onChange={(e) => {
                setVault(e.target.value);
                setMarkdown("");
              }}
            >
              <option value="">Choose a vault</option>
              {vaults.map((v) => (
                <option key={v.path} value={v.path}>
                  {v.name} ({v.path})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Markdown note path
            <Input
              placeholder="Notes/example.md"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Button
            disabled={busy || !vault || !note.endsWith(".md")}
            onClick={() => void read()}
          >
            Read note
          </Button>
        </>
      )}
      {markdown && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words">
          {markdown}
        </pre>
      )}
    </Card>
  );
}
