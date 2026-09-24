import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Workspace { name: string; timezone: string }

export function AdminWorkspace() {
  // Every outcome is named. This page used to swallow the failure and render
  // "Loading…" forever; see the note in lib/useResource.ts.
  const resource = useResource<{ workspace: Workspace }>('/admin/workspace', {
    isEmpty: (r) => !r?.workspace,
  });
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    if (resource.state === 'ready' && resource.data) setWorkspace(resource.data.workspace);
  }, [resource.state, resource.data]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaveError('');
    setSaved(false);
    try {
      const r = await api.patch<{ workspace: Workspace }>('/admin/workspace', {
        name: form.get('name'), timezone: form.get('timezone'),
      });
      setWorkspace(r.workspace);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  async function recover() {
    setRecovering(true); setSaveError('');
    try {
      const r = await api.post<{ workspace: Workspace }>('/admin/workspace/recover', {});
      setWorkspace(r.workspace);
      resource.reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not recover the workspace');
    } finally { setRecovering(false); }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      {/* The heading does not wait on a fetch: a page whose title appears only
          after a successful request has nothing to show when one fails. */}
      <h1 className="text-xl font-semibold tracking-tight">Workspace</h1>

      {resource.state === 'loading' ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : null}

      {resource.state === 'empty' ? (
        <Card>
          <CardTitle>No workspace yet</CardTitle>
          <p className="text-sm text-muted-foreground">
            This installation has no workspace record. Recover it from the administrator and
            deployment settings already saved here.
          </p>
          {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
          <Button className="mt-3" disabled={recovering} onClick={() => void recover()}>
            {recovering ? 'Recovering…' : 'Recover workspace'}
          </Button>
        </Card>
      ) : null}

      {resource.state === 'unauthorized' ? (
        <Card>
          <CardTitle>Not available to you</CardTitle>
          <p className="text-sm text-muted-foreground">{resource.message}</p>
          <Button className="mt-3" onClick={() => { window.location.href = '/app/login'; }}>
            Go to sign-in
          </Button>
        </Card>
      ) : null}

      {resource.state === 'error' || resource.state === 'timeout' ? (
        <Card>
          <CardTitle>
            {resource.state === 'timeout' ? 'The server did not answer' : 'This could not be loaded'}
          </CardTitle>
          <ErrorNote>{resource.message}</ErrorNote>
          <Button className="mt-3" onClick={resource.reload}>Try again</Button>
        </Card>
      ) : null}

      {resource.state === 'ready' && workspace ? (
        <Card>
          <CardTitle>Business profile</CardTitle>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm" htmlFor="ws-name">Name</label>
              <Input id="ws-name" name="name" defaultValue={workspace.name} required />
            </div>
            <div>
              <label className="mb-1 block text-sm" htmlFor="ws-tz">Time zone</label>
              <Input id="ws-tz" name="timezone" defaultValue={workspace.timezone} required />
            </div>
            {saveError ? <ErrorNote>{saveError}</ErrorNote> : null}
            <Button type="submit">Save</Button>
            {saved ? <p className="text-sm text-emerald-400">Saved.</p> : null}
          </form>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Name and identity</CardTitle>
        <p className="text-sm text-muted-foreground">
          Josi CE is created and published by SOCAL RECEPTIONIST LLC. The code is licensed under the
          AGPL — you may modify and redistribute it, including its branding assets.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          The Josi name and marks are separate from that licence. Running Josi CE, or passing it on
          unmodified with its branding, needs no permission. A modified version should carry your own
          identity rather than ours, so nobody is told your work came from us. The full policy is in
          TRADEMARK.md.
        </p>
      </Card>
    </div>
  );
}
