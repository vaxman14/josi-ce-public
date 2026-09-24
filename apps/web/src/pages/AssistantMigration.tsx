import { useEffect, useRef, useState } from 'react';
import type { Classification, MigrationItem, MigrationManifest, MigrationReceipt, Provenance } from '@josi-ce/persona';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote } from '@/components/ui';

const categories = ['personality', 'preferences', 'behaviour', 'memory', 'conversation', 'automation', 'workspace'] as const;
const statuses: Classification[] = ['imported unchanged', 'transformed', 'duplicate', 'sensitive/refused', 'unsupported', 'ignored'];
const canImport = (item: MigrationItem) => ['imported unchanged', 'transformed'].includes(item.classification);
const editable = (item: MigrationItem) => item.category === 'memory' && !!item.content && (canImport(item) || item.classification === 'duplicate');
const fieldClass = 'min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm';
type Batch = { id: string; created_at: string; rolled_back_at: string | null; receipt: Omit<MigrationReceipt, 'items'> };
type Archive = { id: string; source_provenance: Provenance; created_at: string; excerpt?: string; content?: string };

function Counts({ items }: { items: Array<{ classification: Classification }> }) {
  return <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">{statuses.map(status => <div key={status} className="rounded border border-border p-2">
    <dt className="capitalize">{status}</dt><dd className="font-semibold">{items.filter(item => item.classification === status).length}</dd>
  </div>)}</dl>;
}

function downloadReceipt(receipt: MigrationReceipt) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `josi-migration-${receipt.batchId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AssistantMigration({ onDone }: { onDone?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'upload' | 'select' | 'review' | 'receipt'>('upload');
  const [source, setSource] = useState('auto');
  const [files, setFiles] = useState<File[]>([]);
  const [previewId, setPreviewId] = useState('');
  const [expires, setExpires] = useState('');
  const [manifest, setManifest] = useState<MigrationManifest>();
  const [reviewed, setReviewed] = useState<MigrationManifest>();
  const [revision, setRevision] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<MigrationReceipt>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(0);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchOffset, setBatchOffset] = useState(0);
  const [rollbackId, setRollbackId] = useState('');
  const [query, setQuery] = useState('');
  const [archives, setArchives] = useState<Archive[]>([]);
  const [archiveOffset, setArchiveOffset] = useState(0);
  const [archive, setArchive] = useState<Archive>();
  const heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const activePreview = useRef('');
  useEffect(() => { heading.current?.focus(); }, [step, open]);
  useEffect(() => () => { if (activePreview.current) void api.del(`/migrations/previews/${activePreview.current}`).catch(() => undefined); }, []);

  async function perform(label: string, action: () => Promise<void>) {
    setBusy(label); setError(''); setNotice('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : 'The request failed. Please try again.'); }
    finally { setBusy(''); }
  }
  async function refreshBatches(offset = batchOffset) {
    const result = await api.get<{ batches: Batch[] }>(`/migrations/batches?offset=${offset}`);
    setBatches(result.batches); setBatchOffset(offset);
  }
  async function start() {
    setOpen(true);
    await perform('Loading migration history…', () => refreshBatches(0));
  }
  async function scan() {
    await perform('Uploading and scanning your files…', async () => {
      if (!files.length || files.length > 100 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) throw new Error('Choose 1–100 files, no more than 8 MiB total.');
      const form = new FormData(); files.forEach(file => form.append('files', file, file.name));
      const result = await api.upload<{ previewId: string; expiresAt: string; manifest: MigrationManifest }>(`/migrations/scan?source=${source}`, form);
      setPreviewId(result.previewId); activePreview.current = result.previewId;
      setExpires(result.expiresAt); setManifest(result.manifest); setEdits({});
      setSelected(new Set()); setCategory('all'); setPage(0); setStep('select');
      setFiles([]); if (input.current) input.current.value = '';
    });
  }
  async function review() {
    await perform('Checking your selection…', async () => {
      const selections = [...selected].map(id => ({ id, ...(edits[id] !== undefined ? { content: edits[id] } : {}) }));
      const result = await api.post<{ revision: string; manifest: MigrationManifest }>(`/migrations/${previewId}/review`, { selections });
      setReviewed(result.manifest); setRevision(result.revision); setPage(0); setCategory('all'); setStep('review');
    });
  }
  async function commit() {
    await perform('Saving the reviewed import…', async () => {
      const result = await api.post<{ receipt: MigrationReceipt }>(`/migrations/${previewId}/commit`, { revision, confirm: 'import' });
      setReceipt(result.receipt); setStep('receipt'); setManifest(undefined); setReviewed(undefined); setEdits({}); setSelected(new Set());
      activePreview.current = ''; await refreshBatches(0);
    });
  }
  function resetCompletedWizard() {
    activePreview.current = ''; setOpen(false); setPreviewId(''); setExpires(''); setManifest(undefined); setReviewed(undefined); setRevision('');
    setFiles([]); setEdits({}); setSelected(new Set()); setReceipt(undefined); setStep('upload'); setCategory('all'); setPage(0); setError(''); setNotice('');
    if (input.current) input.current.value = '';
  }
  function done() {
    // A completed batch is durable server state. Done only resets this local wizard and closes its settings disclosure.
    resetCompletedWizard(); onDone?.();
  }
  async function discard() {
    await perform('Discarding preview…', async () => {
      if (activePreview.current) {
        // Expiry already discarded it. Other failures must remain visible.
        try { await api.del(`/migrations/previews/${activePreview.current}`); }
        catch (err) { if (!(err instanceof Error && 'status' in err && err.status === 404)) throw err; }
      }
      activePreview.current = ''; setPreviewId(''); setManifest(undefined); setReviewed(undefined); setFiles([]); setEdits({}); setSelected(new Set()); setReceipt(undefined); setStep('upload');
    });
  }
  function toggle(id: string, checked: boolean) { setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; }); }
  async function search(offset = 0) {
    await perform('Searching imported history…', async () => {
      const result = await api.get<{ archives: Archive[] }>(`/migrations/archives?q=${encodeURIComponent(query)}&offset=${offset}`);
      setArchives(result.archives); setArchiveOffset(offset); setArchive(undefined);
      if (!result.archives.length) setNotice('No imported conversations match this search.');
    });
  }
  const shown = step === 'review' ? reviewed : manifest;
  const filtered = shown?.items.filter(item => category === 'all' || item.category === category) ?? [];

  if (!open) return <div className="space-y-3"><p className="text-sm text-muted-foreground">Bring your own portable assistant profiles, memories and conversation history into Josi.</p>
    <Button onClick={() => void start()}>Migrate from another assistant</Button></div>;

  return <section aria-label="Migrate from another assistant" aria-busy={!!busy} className="min-w-0 space-y-4">
    <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">Migrate from another assistant — {step === 'select' ? 'select and edit' : step}</h2>
    <ol aria-label="Migration steps" className="flex flex-wrap gap-3 text-sm">{['upload', 'select', 'review', 'receipt'].map((value, i) =>
      <li key={value} aria-current={step === value ? 'step' : undefined} className={step === value ? 'font-semibold text-primary' : 'text-muted-foreground'}>{i + 1}. {value}</li>)}</ol>
    <p className="text-sm">Migration transfers data you own and personality preferences. It does not transfer model identity, provider credentials, tool access or unrestricted authority. Josi’s approval and security rules still apply.</p>
    <p className="text-sm text-muted-foreground">Existing profiles and facts are kept. Conversation archives are read-only and never enter prompts. External actions, tasks and automations are never activated. Workspace files need separate mapping or copying.</p>
    {busy && <p role="status" className="text-sm">{busy}</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {step === 'upload' && <div className="space-y-3">
      <label className="block text-sm">Source assistant<select className={fieldClass} value={source} disabled={!!busy} onChange={event => setSource(event.target.value)}>
        <option value="auto">Detect from documented format</option><option value="openclaw">OpenClaw</option><option value="hermes">Hermes</option><option value="josi">Josi version-1 export</option>
      </select></label>
      <p className="text-sm">For individual MEMORY.md or USER.md files, choose the source explicitly. Hermes supports its memories files and flat JSONL session export; OpenClaw supports workspace Markdown and Pi session JSONL v3. Other formats will be reported.</p>
      <label htmlFor="migration-files" className="block text-sm font-medium">Choose your ZIP, Markdown, JSON or JSONL files</label>
      <input ref={input} id="migration-files" className={fieldClass} type="file" multiple accept=".zip,.md,.json,.jsonl" disabled={!!busy} onChange={event => setFiles(Array.from(event.target.files ?? []))} aria-describedby="migration-limits" />
      <p id="migration-limits" className="text-xs text-muted-foreground">One ZIP or up to 100 individual files; 8 MiB upload total, 200 ZIP entries, 1 MiB per expanded file, 16 MiB expanded total. Raw archives are processed in memory and not retained. Sanitized previews are kept briefly in the installation database and expire after 10 minutes.</p>
      <Button disabled={!!busy || !files.length} onClick={() => void scan()}>Scan and preview</Button>
    </div>}
    {(step === 'select' || step === 'review') && shown && <div className="space-y-4">
      <p className="text-sm">{step === 'select' ? 'Dry run: nothing has been saved. Select the items you want; edit or redact proposed memories below.' : 'Final dry run: review these exact results before committing.'} Preview expires {new Date(expires).toLocaleTimeString()}.</p>
      <p className="text-xs text-muted-foreground">“Imported unchanged” and “transformed” describe the proposed result until you press Import.</p>
      <Counts items={shown.items} />
      {step === 'select' && <fieldset disabled={!!busy} className="rounded border border-border p-3"><legend className="px-1 text-sm">Select categories</legend>
        <div className="flex flex-wrap gap-3">{categories.map(name => {
          const candidates = manifest!.items.filter(item => item.category === name && canImport(item));
          return <label key={name} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" disabled={!candidates.length} checked={!!candidates.length && candidates.every(item => selected.has(item.id))}
            onChange={event => { const checked = event.target.checked; setSelected(previous => { const next = new Set(previous); candidates.forEach(item => checked ? next.add(item.id) : next.delete(item.id)); return next; }); }} />{name} ({candidates.length})</label>;
        })}</div></fieldset>}
      <label className="block text-sm">Show category<select className={fieldClass} value={category} onChange={event => { setCategory(event.target.value); setPage(0); }}>
        <option value="all">All categories</option>{categories.map(name => <option key={name}>{name}</option>)}</select></label>
      <div className="space-y-3">{filtered.slice(page * 25, (page + 1) * 25).map(item => <article key={item.id} className="min-w-0 space-y-2 rounded border border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2"><p className="break-all text-sm font-medium">{item.provenance.path} · {item.provenance.locator}</p>
          <span className="text-xs font-semibold">{item.classification}</span></div>
        <p className="text-xs text-muted-foreground">{item.provenance.source} · {item.provenance.format}</p><p className="text-sm">{item.reason}</p>
        {step === 'select' && (canImport(item) || editable(item)) && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" aria-label={`Select ${item.provenance.path} ${item.provenance.locator}`} checked={selected.has(item.id)} disabled={!!busy} onChange={event => toggle(item.id, event.target.checked)} />Select this item</label>}
        {step === 'select' && editable(item) ? <label className="block text-sm">Proposed memory — edit or redact<textarea aria-label={`Edit proposed memory from ${item.provenance.path} ${item.provenance.locator}`} className={`${fieldClass} min-h-24`} maxLength={2000} value={edits[item.id] ?? item.content} disabled={!!busy}
          onChange={event => { setEdits(previous => ({ ...previous, [item.id]: event.target.value })); toggle(item.id, true); }} /></label>
          : item.content && <details><summary className="min-h-11 cursor-pointer py-2 text-sm">View proposed content</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{item.content}</pre></details>}
      </article>)}</div>
      <div className="flex flex-wrap items-center gap-2"><Button variant="secondary" disabled={!page || !!busy} onClick={() => setPage(page - 1)}>Previous items</Button>
        <span className="text-sm">{filtered.length ? page * 25 + 1 : 0}–{Math.min(filtered.length, (page + 1) * 25)} of {filtered.length}</span>
        <Button variant="secondary" disabled={(page + 1) * 25 >= filtered.length || !!busy} onClick={() => setPage(page + 1)}>Next items</Button></div>
      <div className="flex flex-wrap gap-2">{step === 'select' ? <Button disabled={!!busy || !selected.size} onClick={() => void review()}>Review {selected.size} selected items</Button>
        : <><Button disabled={!!busy || !reviewed?.items.some(canImport)} onClick={() => void commit()}>Import {reviewed?.items.filter(canImport).length ?? 0} reviewed items</Button>
          <Button variant="secondary" disabled={!!busy} onClick={() => { setPage(0); setStep('select'); }}>Back to selection</Button></>}
        <Button variant="secondary" disabled={!!busy} onClick={() => void discard()}>Discard preview</Button></div>
    </div>}
    {step === 'receipt' && receipt && <div className="space-y-3"><p role="status" className="font-medium">Import completed. {receipt.created} new rows saved.</p>
      <p className="break-all text-sm">Batch: {receipt.batchId}</p><Counts items={receipt.items} />
      <p className="text-sm">The receipt records each item’s source, format, file, location and hash. Rollback below removes the rows created by this batch, including later edits to those imported rows.</p>
      <div className="flex flex-wrap gap-2"><Button onClick={done} disabled={!!busy}>Done</Button><Button variant="secondary" onClick={() => downloadReceipt(receipt)}>Download receipt</Button><Button variant="secondary" onClick={() => void discard()} disabled={!!busy}>Start another migration</Button></div>
    </div>}
    <Card><h3 className="mb-3 font-semibold">Your import batches</h3><p className="mb-3 text-sm">Rollback permanently removes only rows created by the selected batch. Pre-existing data stays intact.</p>
      <div className="space-y-3">{batches.map(batch => <div key={batch.id} className="space-y-2 border-b border-border pb-3">
        <p className="break-all text-sm">{new Date(batch.created_at).toLocaleString()} · {batch.receipt.created} rows · {batch.id}</p>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!!busy} onClick={() => void perform('Loading receipt…', async () => {
          const result = await api.get<{ receipt: MigrationReceipt }>(`/migrations/batches/${batch.id}`); downloadReceipt(result.receipt);
        })}>Receipt</Button>
          {batch.rolled_back_at ? <p className="text-sm">Rolled back {new Date(batch.rolled_back_at).toLocaleString()}</p> : <Button variant="danger" disabled={!!busy} onClick={() => setRollbackId(batch.id)}>Roll back batch</Button>}</div>
        {rollbackId === batch.id && <div className="space-y-2 rounded border border-border p-3"><p className="text-sm">Remove this batch’s imported rows, including any edits made to them since import?</p>
          <div className="flex flex-wrap gap-2"><Button variant="danger" disabled={!!busy} onClick={() => void perform('Rolling back this batch…', async () => {
            const result = await api.post<{ removed: number }>(`/migrations/batches/${batch.id}/rollback`, { confirm: 'rollback' });
            setRollbackId(''); setArchive(undefined); setArchives([]); await refreshBatches(); setNotice(`Rollback completed. ${result.removed} rows removed.`);
          })}>Confirm rollback</Button><Button variant="secondary" disabled={!!busy} onClick={() => setRollbackId('')}>Cancel</Button></div></div>}
      </div>)}{!batches.length && <p className="text-sm text-muted-foreground">No batches on this page.</p>}</div>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={!!busy || batchOffset === 0} onClick={() => void perform('Loading batches…', () => refreshBatches(Math.max(0, batchOffset - 20)))}>Newer batches</Button>
        <Button variant="secondary" disabled={!!busy || batches.length < 20} onClick={() => void perform('Loading batches…', () => refreshBatches(batchOffset + 20))}>Older batches</Button></div>
    </Card>
    <Card><h3 className="mb-3 font-semibold">Imported conversation archive</h3><p className="mb-3 text-sm">Searchable, read-only historical text. It cannot be resumed and is never loaded into an assistant prompt.</p>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); void search(); }}><label className="block text-sm">Search history<input className={fieldClass} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></label><Button disabled={!!busy} type="submit">Search archive</Button></form>
      <div className="mt-3 space-y-2">{archives.map(row => <div key={row.id} className="min-w-0 rounded border border-border p-3"><p className="break-all text-sm">{row.source_provenance.source} · {row.source_provenance.path} · {row.source_provenance.locator}</p>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{row.excerpt}</p><Button variant="secondary" disabled={!!busy} onClick={() => void perform('Loading archived conversation…', async () => {
          const result = await api.get<{ archive: Archive }>(`/migrations/archives/${row.id}`); setArchive(result.archive);
        })}>Read conversation</Button></div>)}</div>
      <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={!!busy || archiveOffset === 0} onClick={() => void search(Math.max(0, archiveOffset - 20))}>Previous conversations</Button>
        <Button variant="secondary" disabled={!!busy || archives.length < 20} onClick={() => void search(archiveOffset + 20)}>More conversations</Button></div>
      {archive && <article className="mt-4 rounded border border-border p-3"><h4 className="break-all font-medium">{archive.source_provenance.path}</h4>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{archive.content}</pre><Button variant="secondary" onClick={() => setArchive(undefined)}>Close conversation</Button></article>}
    </Card>
  </section>;
}
