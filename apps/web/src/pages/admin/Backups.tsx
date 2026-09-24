// Backups and portable exports.
//
// The archives existed before this screen did: the routes could create one and
// list it, and the operator had no way to retrieve either. A row saying
// "Portable export · Ready" described a file on a volume inside the container,
// which is not a place a person can reach — so the feature was, in practice,
// unavailable.
//
// The one thing this page must never imply is that an archive is a complete
// recovery. It is not. The installation master key is stored separately, is in
// no backup by construction, and is required alongside the archive — so the
// warning travels with the download rather than living somewhere else.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';

interface BackupRow {
  id: string;
  kind: 'full' | 'portable';
  byte_size: string | number;
  state: 'running' | 'complete' | 'failed';
  error_category: string | null;
  includes_recovery_copies: boolean;
  master_key_confirmed: boolean;
  created_at: string;
  completed_at: string | null;
  progress_percent: number;
  progress_phase: string;
  progress_step: number;
  progress_steps: number;
}

interface BackupsView {
  backups: BackupRow[];
  masterKeyGuidance: string;
}

interface DestinationField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string | null;
  help: string | null;
}

interface DestinationKindInfo {
  kind: string;
  label: string;
  credentialsHelp: string;
  docsUrl: string;
  fields: DestinationField[];
}

interface Destination {
  kind: string;
  label: string;
  bucket: string;
  region: string;
  accountId: string | null;
  endpoint: string | null;
  objectPrefix: string;
  credentialsSet: boolean;
  resolvedEndpoint: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  shareProtocol: 'smb' | 'nfs' | null;
  shareHost: string | null;
  shareName: string | null;
  encryptionEnabled: boolean;
}

interface DestinationView {
  catalog: DestinationKindInfo[];
  destination: Destination | null;
  localPath: string;
}

const KIND_LABEL: Record<BackupRow['kind'], string> = {
  full: 'Full backup',
  portable: 'Portable export',
};

/** What each state means to the person looking at the row, rather than the
 * enum value. "Ready" is only ever said about an archive that can be had. */
const STATE_LABEL: Record<BackupRow['state'], string> = {
  running: 'Still being written',
  complete: 'Ready',
  failed: 'Did not finish',
};

function size(bytes: string | number): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AdminBackups() {
  const [view, setView] = useState<BackupsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [, setClock] = useState(0);

  const load = useCallback(async () => {
    try {
      setView(await api.get<BackupsView>('/ops/admin/backups'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the backup history');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const activeBackup = view?.backups.find((b) => b.state === 'running');
  useEffect(() => {
    if (!busy && !activeBackup) return;
    const timer = window.setInterval(() => { void load(); }, 1000);
    return () => window.clearInterval(timer);
  }, [busy, activeBackup?.id, load]);
  useEffect(() => {
    if (!activeBackup) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [activeBackup?.id]);

  async function take(kind: 'full' | 'portable') {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await api.post<{ description: string }>('/ops/admin/backups', { kind });
      setNote(res.description);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That backup could not be taken');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Backups</h1>
      <p className="text-sm text-muted-foreground">
        A full backup is what a restore reads. A portable export is your data in a form you can take
        elsewhere, and deliberately carries no recovery copies.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card>
        <CardTitle>Take one now</CardTitle>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" disabled={busy || !!activeBackup} onClick={() => void take('full')}>
            {busy || activeBackup ? 'Backing up…' : 'Back up now'}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void take('portable')}>
            Portable export
          </Button>
        </div>
        {activeBackup ? (
          <div className="mt-3" role="status" aria-live="polite">
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>
                {activeBackup.progress_phase} · {Math.max(0, Math.floor((Date.now() - new Date(activeBackup.created_at).getTime()) / 1000))}s elapsed
              </span>
              <span>Step {activeBackup.progress_step} of {activeBackup.progress_steps} · {activeBackup.progress_percent}%</span>
            </div>
            <progress className="h-2 w-full accent-primary" max={100} value={activeBackup.progress_percent} aria-label="Backup progress" />
          </div>
        ) : null}
        {note ? <p className="mt-2 text-sm text-muted-foreground">{note}</p> : null}
      </Card>

      {/* Stated once, prominently, rather than repeated beside every row: an
          archive on its own does not restore this installation. */}
      {view?.masterKeyGuidance ? (
        <Card>
          <CardTitle>The master key is not in any of these</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">{view.masterKeyGuidance}</p>
        </Card>
      ) : null}

      <BackupDestination />

      <Card>
        <CardTitle>History</CardTitle>
        {!view ? <p className="mt-2 text-sm text-muted-foreground">Loading…</p> : null}
        {view && !view.backups.length ? (
          <Empty title="Nothing has been backed up yet">
            Take a full backup before you rely on this installation for anything.
          </Empty>
        ) : null}
        <ul className="mt-2 divide-y divide-border">
          {(view?.backups ?? []).map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span className="min-w-0">
                <span className="block text-sm">
                  {KIND_LABEL[b.kind]} · {STATE_LABEL[b.state]}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {new Date(b.created_at).toLocaleString()} · {size(b.byte_size)}
                  {b.state === 'failed' && b.error_category ? ` · ${b.error_category}` : ''}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone={b.state === 'complete' ? 'ok' : b.state === 'failed' ? 'danger' : 'muted'}>
                  {STATE_LABEL[b.state]}
                </Badge>
                {/* Only a completed archive gets a control. A pressable
                    Download on a row that has no file is the same lie the
                    missing route was. The link is a plain anchor so the
                    browser's own download handling applies; the session cookie
                    goes with it and the server decides. */}
                {b.state === 'complete' ? (
                  <a
                    className="inline-flex min-h-11 items-center rounded-md border border-input px-3 text-sm underline"
                    href={`/api/ops/admin/backups/${b.id}/download`}
                  >
                    Download
                  </a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/** Where backups are kept, set up by a person.
 *
 * This replaces a form that asked for a "secret prefix" — a string like
 * `primary` naming host files the operator was expected to create and mount
 * themselves before any of it worked. Nothing here asks anyone to touch the
 * host: the credential is typed once, sealed with the installation master key,
 * and proved against the bucket before the screen calls it configured.
 *
 * The fields come from the server's catalogue, so each vendor is asked for what
 * its own console calls things. Backblaze shows you a keyID and an
 * applicationKey; labelling those "Access key ID" and "Secret access key"
 * because that is what the protocol calls them sends an operator hunting for
 * fields that do not exist under those names.
 */
function BackupDestination() {
  const [view, setView] = useState<DestinationView | null>(null);
  const [kind, setKind] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Only ever true while a test this person asked for is running. */
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [recoveryKey, setRecoveryKey] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api.get<DestinationView>('/ops/admin/backups/destination');
      setView(next);
      if (next.destination) setKind(next.destination.kind);
      else setKind(next.catalog[0]?.kind ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the backup destination');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const entry = view?.catalog.find((c) => c.kind === kind) ?? null;
  const destination = view?.destination ?? null;

  // Switching vendor clears what was typed. An R2 token is not an AWS key, and
  // a field left populated from the previous choice would be sent to a
  // different company's endpoint.
  useEffect(() => { setValues({}); setResult(null); }, [kind]);

  function setField(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  /** A stored credential may be left blank to keep it, but only while the
   * vendor is unchanged — which is exactly what the server enforces. */
  const keepingCredential = !!destination?.credentialsSet && destination.kind === kind;
  const missing = (entry?.fields ?? []).filter((f) => {
    if (!f.required) return false;
    if (f.secret && keepingCredential) return false;
    return !(values[f.key] ?? '').trim();
  });

  async function save() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const saved = await api.put<{ recoveryKey?: string | null }>('/ops/admin/backups/destination', { kind, ...values, encryptionEnabled: values.encryptionEnabled !== 'false' });
      if (saved.recoveryKey) setRecoveryKey(saved.recoveryKey);
      setEditing(false);
      setValues({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That destination could not be saved');
    } finally {
      setBusy(false);
    }
  }

  async function browseNas() {
    setTesting(true);
    setError('');
    try {
      const found = await api.post<{ folders: string[] }>('/ops/admin/backups/destination/nas/browse', { ...values, shareProtocol: values.shareProtocol ?? 'smb' });
      setFolders(found.folders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The NAS could not be browsed');
    } finally { setTesting(false); }
  }

  /** Runs only from the button. Nothing here tests on open: a test is a real
   * signed request to somebody else's service, and opening a page is not a
   * reason to make one. */
  async function test() {
    setTesting(true);
    setError('');
    try {
      const res = await api.post<{ ok: boolean; detail: string }>(
        '/ops/admin/backups/destination/test', {},
      );
      setResult(res);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run');
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove this backup destination? Existing backups are not deleted.')) return;
    setBusy(true);
    setError('');
    try {
      await api.del('/ops/admin/backups/destination');
      setEditing(false);
      setValues({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That destination could not be removed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>Where backups are kept</CardTitle>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      {recoveryKey ? (
        <div className="mt-2 rounded-md border border-amber-500/40 p-3">
          <p className="text-sm font-medium">Save the backup recovery key now</p>
          <p className="mt-1 text-xs text-muted-foreground">This is the only visible copy. Keep it somewhere other than the backup destination.</p>
          <code className="mt-2 block break-all text-sm">••••••••••••{recoveryKey.slice(-4)}</code>
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void navigator.clipboard.writeText(recoveryKey)}>Copy</Button>
            <Button type="button" variant="secondary" onClick={() => { const blob = new Blob([`${recoveryKey}\n`], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'josi-backup-recovery-key.txt'; a.click(); URL.revokeObjectURL(a.href); }}>Download</Button>
          </div>
        </div>
      ) : null}

      {/* The volume is always there. Saying so is the difference between "no
          destination configured" and "backups are not being kept anywhere". */}
      <p className="mt-2 text-sm text-muted-foreground">
        Every backup is written to this server at <code>{view?.localPath ?? '/data/backups'}</code>.
        A copy somewhere else protects you from losing the server itself.
      </p>

      {destination && !editing ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">
              {view?.catalog.find((c) => c.kind === destination.kind)?.label ?? destination.kind}
              {destination.label ? ` · ${destination.label}` : ''}
            </span>
            {/* Never tested is its own state. A destination nobody has proved
                is not shown as working, and not shown as broken either. */}
            <Badge tone={destination.lastCheckOk === true ? 'ok' : destination.lastCheckOk === false ? 'danger' : 'muted'}>
              {destination.lastCheckOk === true
                ? 'tested'
                : destination.lastCheckOk === false ? 'last test failed' : 'not tested yet'}
            </Badge>
          </div>
          <dl className="text-sm text-muted-foreground">
            <div><dt className="inline font-medium">{destination.kind === 'nas' ? 'NAS: ' : 'Bucket: '}</dt><dd className="inline">{destination.kind === 'nas' ? `${destination.shareProtocol?.toUpperCase()} · ${destination.shareHost}/${destination.shareName}` : destination.bucket}</dd></div>
            {destination.kind !== 'r2' && destination.kind !== 'nas' ? (
              <div><dt className="inline font-medium">Region: </dt><dd className="inline">{destination.region}</dd></div>
            ) : null}
            {destination.objectPrefix ? (
              <div><dt className="inline font-medium">Folder: </dt><dd className="inline">{destination.objectPrefix}</dd></div>
            ) : null}
            {/* Assembled by the server from the stored fields, so an operator
                checking their bucket does not have to reconstruct it. */}
            {destination.kind !== 'nas' ? <div><dt className="inline font-medium">Address: </dt><dd className="inline break-all">{destination.resolvedEndpoint}</dd></div> : null}
          </dl>
          {destination.lastCheckOk === false && destination.lastCheckError ? (
            <ErrorNote>{destination.lastCheckError}</ErrorNote>
          ) : null}
          {result ? (
            <p className={`text-sm ${result.ok ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>
              {result.detail}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy || testing} onClick={() => void test()}>
              {testing ? 'Testing…' : destination.lastCheckOk === true ? 'Test again' : 'Test connection'}
            </Button>
            <Button type="button" variant="secondary" disabled={busy || testing}
                    onClick={() => {
                      setKind(destination.kind);
                      setValues({
                        label: destination.label,
                        bucket: destination.bucket,
                        region: destination.region,
                        accountId: destination.accountId ?? '',
                        endpoint: destination.endpoint ?? '',
                        objectPrefix: destination.objectPrefix,
                        shareProtocol: destination.shareProtocol ?? 'smb',
                        shareHost: destination.shareHost ?? '',
                        shareName: destination.shareName ?? '',
                        encryptionEnabled: String(destination.encryptionEnabled),
                      });
                      setEditing(true);
                      setResult(null);
                    }}>
              Change
            </Button>
            <Button type="button" variant="secondary" disabled={busy || testing} onClick={() => void remove()}>
              Remove destination
            </Button>
          </div>
        </div>
      ) : null}

      {!destination || editing ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <fieldset>
            <legend className="mb-1 block text-sm">Storage service</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(view?.catalog ?? []).map((c) => {
                const selected = kind === c.kind;
                return (
                  <label key={c.kind} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${selected ? 'border-primary bg-primary/15 text-primary' : 'border-input bg-background'}`}>
                    <input type="radio" name="destination-kind" value={c.kind} checked={selected} onChange={() => setKind(c.kind)} />
                    <span>{c.label}</span>
                    {selected ? <span className="ml-auto" aria-label="Selected">✓</span> : null}
                  </label>
                );
              })}
            </div>
            {entry ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {entry.credentialsHelp}{' '}
                <a className="underline" href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
                  Their documentation
                </a>
              </p>
            ) : null}
          </fieldset>

          {kind === 'nas' ? (
            <fieldset>
              <legend className="mb-1 text-sm">Share type</legend>
              <div className="flex gap-4 text-sm">
                {(['smb', 'nfs'] as const).map((protocol) => <label key={protocol} className="flex items-center gap-2"><input type="radio" name="nas-protocol" checked={(values.shareProtocol ?? 'smb') === protocol} onChange={() => setField('shareProtocol', protocol)} />{protocol.toUpperCase()}</label>)}
              </div>
            </fieldset>
          ) : null}

          <div>
            <label className="mb-1 block text-sm" htmlFor="destLabel">A name for this (optional)</label>
            <Input id="destLabel" name="label" value={values.label ?? ''}
                   placeholder="Off-site copy"
                   onChange={(e) => setField('label', e.target.value)} />
          </div>

          {(entry?.fields ?? []).map((f) => (
            <div key={f.key}>
              <label className="mb-1 block text-sm" htmlFor={`dest-${f.key}`}>
                {f.label}{f.required ? '' : ' (optional)'}
              </label>
              <Input
                id={`dest-${f.key}`}
                name={f.key}
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                autoCapitalize="none"
                placeholder={f.placeholder ?? undefined}
                value={values[f.key] ?? ''}
                onChange={(e) => setField(f.key, e.target.value)}
              />
              {f.help ? <p className="mt-1 text-xs text-muted-foreground">{f.help}</p> : null}
              {f.secret && keepingCredential ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Already saved. Leave empty to keep it.
                </p>
              ) : null}
            </div>
          ))}

          {kind === 'nas' ? (
            <div>
              <Button type="button" variant="secondary" disabled={testing || !values.shareHost || !values.shareName} onClick={() => void browseNas()}>{testing ? 'Connecting…' : 'Connect and browse'}</Button>
              {folders.length ? <select className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3" value={values.folder ?? ''} onChange={(e) => setField('folder', e.target.value)}><option value="">Share root</option>{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</select> : null}
            </div>
          ) : null}

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={values.encryptionEnabled !== 'false'} onChange={(e) => setField('encryptionEnabled', String(e.target.checked))} />
            <span><strong>Encrypt off-site backups</strong> (recommended). Turning this off means anyone with storage access can read the archive.</span>
          </label>

          <p className="text-xs text-muted-foreground">
            These are stored encrypted with this installation's master key. Josi never asks you to
            create or mount a file on the host.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !!missing.length}>
              {busy ? 'Saving…' : 'Save destination'}
            </Button>
            {destination ? (
              <Button type="button" variant="secondary" disabled={busy}
                      onClick={() => { setEditing(false); setValues({}); setKind(destination.kind); }}>
                Cancel
              </Button>
            ) : null}
          </div>
          {missing.length ? (
            <p className="text-xs text-muted-foreground">
              Still needed: {missing.map((f) => f.label).join(', ')}.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Saving clears any previous test result. A credential that has not been tried against the
            bucket it now points at has proved nothing.
          </p>
        </form>
      ) : null}
    </Card>
  );
}
