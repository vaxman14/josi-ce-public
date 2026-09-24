// Files from a connected Google Drive, OneDrive, Dropbox, Box, or Nextcloud
// account.
//
// This replaces the "planned" placeholder that used to sit at the bottom of
// the Connections page. The honesty rules that governed the placeholder govern
// the real thing: nothing here is pressable unless it works, every consent is
// a sentence fetched from the server (the same sentence the server records),
// and every state a folder can be in has plain words.
//
// Read-only, deliberately and visibly. Josi reads the folders a person picks;
// it cannot change, move or delete anything at the provider — every scope it
// asks for (OAuth or the WebDAV app password) cannot write.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { plain, plainDetail } from '@/lib/plainLanguage';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

type StorageProvider = 'google' | 'microsoft' | 'dropbox' | 'box' | 'nextcloud';

interface CloudMapping {
  id: string;
  provider: 'local' | 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'nextcloud';
  display_path: string;
  recursive: boolean;
  indexing_enabled: boolean;
  status: 'active' | 'paused' | 'revoked';
  paused_reason: string | null;
}

interface MappingStatus {
  total: number;
  byState: Record<string, number>;
  skipped: Array<{ reason: string; count: number }>;
  explanations: Record<string, string>;
}

interface RemoteFolder {
  id: string;
  name: string;
}

const MAPPING_PROVIDER: Record<StorageProvider, CloudMapping['provider']> = {
  google: 'google_drive',
  microsoft: 'onedrive',
  dropbox: 'dropbox',
  box: 'box',
  nextcloud: 'nextcloud',
};

const STORAGE_LABEL: Record<StorageProvider, string> = {
  google: 'Google Drive',
  microsoft: 'OneDrive',
  dropbox: 'Dropbox',
  box: 'Box',
  nextcloud: 'Nextcloud',
};

export function CloudFolders({
  provider, connectionId, capabilityOn,
}: {
  provider: StorageProvider;
  connectionId: string;
  capabilityOn: boolean;
}) {
  const [mappings, setMappings] = useState<CloudMapping[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ mappings: CloudMapping[] }>('/storage/mappings');
      setMappings(res.mappings.filter((m) => m.provider === MAPPING_PROVIDER[provider]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your folders');
    }
  }, [provider]);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await run();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that');
    } finally {
      setBusy(null);
    }
  }

  if (!capabilityOn) {
    return (
      <p className="mt-3 text-sm text-muted-foreground">
        To let Josi read folders from {STORAGE_LABEL[provider]}, switch on
        “Read files” above. It is off until you turn it on, and it is read-only —
        Josi cannot change or delete anything in your account.
      </p>
    );
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-2 text-sm font-medium">{STORAGE_LABEL[provider]} folders</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p className="mb-2 text-sm text-muted-foreground">{notice}</p> : null}

      {mappings === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {mappings?.length === 0 && !adding ? (
        <p className="mb-2 text-sm text-muted-foreground">
          No folders yet. Choose one and Josi will read it, index the text it can
          read, and make it searchable — for you only.
        </p>
      ) : null}

      <ul className="space-y-3">
        {mappings?.map((mapping) => (
          <li key={mapping.id} className="rounded-md border border-border p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">{mapping.display_path}</span>
              <Badge tone={mapping.status === 'active' ? 'ok' : 'danger'}>
                {plain('mapping_status', mapping.status)}
              </Badge>
            </div>
            {mapping.status === 'paused' && mapping.paused_reason ? (
              <p className="mt-1 text-sm text-destructive">
                {plain('mapping_paused_reason', mapping.paused_reason)}
                {plainDetail('mapping_paused_reason', mapping.paused_reason)
                  ? ` — ${plainDetail('mapping_paused_reason', mapping.paused_reason)}`
                  : ''}
              </p>
            ) : null}
            <MappingDetail mappingId={mapping.id} />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy === mapping.id}
                onClick={() => void act(mapping.id, async () => {
                  await api.post(`/storage/mappings/${mapping.id}/sync`, {});
                  setNotice('Sync queued. New and changed files appear as the worker gets to them.');
                })}
              >
                Sync now
              </Button>
              <Button
                variant="secondary"
                disabled={busy === mapping.id}
                onClick={() => void act(mapping.id, () =>
                  api.del(`/storage/mappings/${mapping.id}`))}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <FolderPicker
          provider={provider}
          connectionId={connectionId}
          onDone={() => { setAdding(false); void load(); }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="mt-3">
          <Button variant="secondary" onClick={() => setAdding(true)}>Add a folder</Button>
        </div>
      )}
    </div>
  );
}

/** What happened to the files in one folder — counts and reasons, fetched from
 * the status route so the words are the server's own. */
function MappingDetail({ mappingId }: { mappingId: string }) {
  const [status, setStatus] = useState<MappingStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<MappingStatus>(`/storage/mappings/${mappingId}/status`)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { /* the row above still renders; detail is additive */ });
    return () => { cancelled = true; };
  }, [mappingId]);

  if (!status || status.total === 0) return null;
  const indexed = status.byState.indexed ?? 0;
  return (
    <div className="mt-1 text-sm text-muted-foreground">
      <p>{indexed} of {status.total} file(s) indexed and searchable.</p>
      {status.skipped.map((s) => (
        <p key={s.reason}>
          {s.count} skipped — {status.explanations[s.reason] ?? s.reason}
        </p>
      ))}
    </div>
  );
}

/** Browse, then pick. Item 16b: picking a folder IS the commitment — the
 * moment its owner presses “Use this folder”, Josi maps it, turns indexing
 * on, and queues the first sync in the same action. No second “I agree”
 * click, no separate “start syncing” toggle afterwards.
 *
 * The consent sentence has not been dropped — it is a security artefact, not
 * copy the browser assembles, so it still comes from the server (M49/M50).
 * What changed is when it is shown: as a receipt of what Josi just started
 * doing, not a gate the person has to click through a second time to reach
 * the same outcome they already chose by picking the folder. */
function FolderPicker({
  provider, connectionId, onDone, onCancel,
}: {
  provider: StorageProvider;
  connectionId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState<RemoteFolder[]>([]);
  const [folders, setFolders] = useState<RemoteFolder[] | null>(null);
  const [error, setError] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const current = path[path.length - 1] ?? null;

  const browse = useCallback(async (parent: string | null) => {
    setFolders(null);
    setError('');
    try {
      const query = parent ? `?parent=${encodeURIComponent(parent)}` : '';
      const res = await api.get<{ folders: RemoteFolder[] }>(
        `/connections/${connectionId}/storage/folders${query}`,
      );
      setFolders(res.folders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list your folders');
    }
  }, [connectionId]);

  useEffect(() => { void browse(null); }, [browse]);

  const displayPath = `${STORAGE_LABEL[provider]}/${path.map((p) => p.name).join('/')}`;

  /** One click: map the folder, turn indexing on, queue the sync. If any step
   * fails the mapping already exists — “could not map that folder” would be
   * the wrong message once step one succeeded, so failures after creation are
   * reported as what they are (indexing/sync did not start) rather than
   * folded back into a generic mapping error. */
  async function useThisFolder() {
    if (!current) return;
    setBusy(true);
    setError('');
    try {
      const created = await api.post<{ mapping: { id: string }; consent: string }>('/storage/mappings', {
        provider: MAPPING_PROVIDER[provider],
        connectionId,
        remoteFolderId: current.id,
        displayPath,
        recursive,
      });
      const mappingId = created.mapping.id;
      try {
        // Indexing is its own consent (M49); the sentence the server just
        // returned already covers it, and this is the switch it covered.
        await api.put(`/storage/mappings/${mappingId}/indexing`, { enabled: true });
        // Syncing is no longer a separate step the owner has to remember to
        // press — picking the folder started it.
        await api.post(`/storage/mappings/${mappingId}/sync`, {});
        setReceipt(created.consent);
      } catch (innerErr) {
        // The folder is mapped; only the auto-start half of this click did
        // not complete. Say that plainly — “Sync now” on the mapping card
        // still reaches the same job.
        setError(
          innerErr instanceof ApiError
            ? `The folder was mapped, but syncing did not start: ${innerErr.message}`
            : 'The folder was mapped, but syncing did not start automatically. Use “Sync now” below.',
        );
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not map that folder');
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <Card className="mt-3">
        <CardTitle>Syncing started</CardTitle>
        <p className="text-sm">{receipt}</p>
        <div className="mt-3">
          <Button onClick={onDone}>Done</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mt-3">
      <CardTitle>Choose a folder</CardTitle>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <p className="mb-2 text-sm text-muted-foreground">
        {path.length ? displayPath : `The top of your ${STORAGE_LABEL[provider]}. Pick a folder — Josi maps one folder at a time, never the whole drive.`}
      </p>
      {folders === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {folders?.length === 0 ? (
        <p className="text-sm text-muted-foreground">No folders inside this one.</p>
      ) : null}
      <ul className="space-y-1">
        {folders?.map((f) => (
          <li key={f.id}>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => { setPath([...path, f]); void browse(f.id); }}
            >
              📁 {f.name}
            </Button>
          </li>
        ))}
      </ul>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={recursive}
          onChange={(e) => setRecursive(e.target.checked)}
        />
        Include subfolders, including ones added later
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        Josi will read it, index the text it can read, and start syncing the moment you use it below.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {path.length > 0 ? (
          <Button disabled={busy} onClick={() => void useThisFolder()}>
            {busy ? 'Starting…' : `Use “${current?.name}”`}
          </Button>
        ) : null}
        {path.length > 0 ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              const up = path.slice(0, -1);
              setPath(up);
              void browse(up[up.length - 1]?.id ?? null);
            }}
          >
            Up one level
          </Button>
        ) : null}
        <Button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}
