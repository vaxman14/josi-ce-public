import { useEffect, useState } from 'react';
import { WorkspaceCodingAdmin } from '@/components/WorkspaceCodingAdmin';
import { api } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { Button, Card, CollapsibleCard, ErrorNote, Input } from '@/components/ui';

interface StoragePolicy {
  max_file_bytes: number | string;
  max_total_bytes_per_user: number | string;
  max_files_per_user: number;
  allowed_extensions: string[];
  archives_enabled: boolean;
  archive_max_entries: number;
  archive_max_total_bytes: number | string;
  archive_max_depth: number;
  archive_max_seconds: number;
}

const MB = 1024 * 1024;
const toMb = (bytes: number | string) => Math.round(Number(bytes) / MB);

export function AdminStorage() {
  const resource = useResource<{ policy: StoragePolicy }>('/storage/admin/policy');
  const [policy, setPolicy] = useState<StoragePolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (resource.state === 'ready' && resource.data) setPolicy(resource.data.policy);
  }, [resource.state, resource.data]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!policy) return;
    const form = new FormData(event.currentTarget);
    const extensions = String(form.get('extensions') ?? '')
      .split(/[\s,]+/).map((v) => v.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const result = await api.put<{ policy: StoragePolicy }>('/storage/admin/policy', {
        maxFileBytes: Number(form.get('maxFileMb')) * MB,
        maxTotalBytesPerUser: Number(form.get('maxTotalMb')) * MB,
        maxFilesPerUser: Number(form.get('maxFiles')),
        allowedExtensions: extensions,
        archivesEnabled: form.get('archivesEnabled') === 'on',
        archiveMaxEntries: Number(form.get('archiveMaxEntries')),
        archiveMaxTotalBytes: Number(form.get('archiveMaxTotalMb')) * MB,
        archiveMaxDepth: Number(form.get('archiveMaxDepth')),
        archiveMaxSeconds: Number(form.get('archiveMaxSeconds')),
      });
      setPolicy(result.policy);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save storage settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Storage</h1>
      <WorkspaceCodingAdmin />
      {resource.state === 'loading' ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {resource.state === 'error' || resource.state === 'timeout' ? (
        <Card><ErrorNote>{resource.message}</ErrorNote><Button className="mt-3" onClick={resource.reload}>Try again</Button></Card>
      ) : null}

      {resource.state === 'ready' && policy ? (
        <form onSubmit={save} className="space-y-4">
          <CollapsibleCard title="Indexing limits" summary="File size, total storage, and item-count limits" defaultOpen>
            <p className="mb-4 text-sm text-muted-foreground">
              These workspace limits protect the server. A limit may cause files to be skipped; raising it can increase CPU, memory and disk use.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField name="maxFileMb" label="Maximum file size (MB)" value={toMb(policy.max_file_bytes)} />
              <NumberField name="maxTotalMb" label="Maximum storage per person (MB)" value={toMb(policy.max_total_bytes_per_user)} />
              <NumberField name="maxFiles" label="Maximum files per person" value={policy.max_files_per_user} />
            </div>
          </CollapsibleCard>

          <CollapsibleCard title="Allowed file types" summary={`${policy.allowed_extensions.length} extensions allowed`}>
            <p className="mb-3 text-sm text-muted-foreground">
              Enter extensions separated by commas or spaces, without dots. Executables, disk images, keys and unknown binaries should remain excluded.
            </p>
            <label className="mb-1 block text-sm font-medium" htmlFor="storage-extensions">Extensions</label>
            <textarea
              id="storage-extensions" name="extensions" required
              defaultValue={policy.allowed_extensions.join(', ')}
              className="min-h-28 w-full rounded-md border border-input bg-background p-3 text-base sm:text-sm"
            />
          </CollapsibleCard>

          <CollapsibleCard title="Archives" summary={policy.archives_enabled ? 'Archive indexing enabled' : 'Archive indexing disabled'}>
            <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
              <input name="archivesEnabled" type="checkbox" defaultChecked={policy.archives_enabled} className="h-5 w-5" />
              Index supported archives
            </label>
            <p className="mb-4 text-sm text-muted-foreground">
              Archives are off by default. When enabled, every extracted entry still passes the file-type, encryption and malware gates below.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberField name="archiveMaxEntries" label="Maximum entries per archive" value={policy.archive_max_entries} />
              <NumberField name="archiveMaxTotalMb" label="Maximum expanded size (MB)" value={toMb(policy.archive_max_total_bytes)} />
              <NumberField name="archiveMaxDepth" label="Maximum nested depth (1–3)" value={policy.archive_max_depth} max={3} />
              <NumberField name="archiveMaxSeconds" label="Maximum processing time (seconds)" value={policy.archive_max_seconds} />
            </div>
          </CollapsibleCard>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save storage settings'}</Button>
            {saved ? <p className="text-sm text-emerald-400">Saved.</p> : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function NumberField({ name, label, value, max }: { name: string; label: string; value: number; max?: number }) {
  return <div><label className="mb-1 block text-sm font-medium" htmlFor={`storage-${name}`}>{label}</label>
    <Input id={`storage-${name}`} name={name} type="number" min={1} max={max} step={1} defaultValue={value} required />
  </div>;
}
