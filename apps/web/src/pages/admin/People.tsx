// Who is in this workspace.
import { useEffect, useState } from 'react';
import { api, type User } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface StorageGrant {
  user_id: string; may_map_local: boolean; may_map_cloud: boolean; may_index: boolean;
  max_files: number | null; max_bytes: number | null; mappings: number;
}

// item 40h-DECIDED: the workspace default is 20GB unless an administrator has
// set this person's own override. Kept in sync with packages/db/migrations
// 0007/0031's `storage_policy.max_total_bytes_per_user` default — shown here
// only as a display fallback, never written back as if it were this person's
// own value, so "effective 20GB" and "an admin typed 20" stay distinguishable
// in the data even though they read the same in the UI.
const DEFAULT_QUOTA_BYTES = 21474836480;
const GB = 1024 * 1024 * 1024;
const bytesToGb = (bytes: number) => Math.round((bytes / GB) * 100) / 100;

export function AdminPeople() {
  const [users, setUsers] = useState<User[]>([]);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [storage, setStorage] = useState<Record<string, StorageGrant>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Draft GB text per user, edited before Save is pressed. Separate from
  // `storage` (the last-saved server state) so typing doesn't fight a
  // half-finished number, and so Save can be disabled until it actually
  // differs from the effective value.
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});

  const load = async () => {
    const [people, grants] = await Promise.all([
      api.get<{ users: User[] }>('/admin/users'),
      api.get<{ users: StorageGrant[] }>('/storage/admin/capabilities'),
    ]);
    setUsers(people.users);
    setStorage(Object.fromEntries(grants.users.map((g) => [g.user_id, g])));
  };
  useEffect(() => { void load(); }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const result = await api.post<{ inviteLink: string }>('/admin/users', {
        email: form.get('email'), username: form.get('username'),
      });
      // CE has no mail delivery until Phase 8, so the link is handed over
      // rather than sent. Shown here because there is nowhere else for it to go
      // — and said plainly rather than implying an email went out.
      setInvite(result.inviteLink);
      event.currentTarget.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them');
    }
  }

  async function setStorageGrant(userId: string, patch: Partial<StorageGrant>) {
    const current = storage[userId];
    if (!current) return;
    setBusy(userId); setError('');
    try {
      await api.put(`/storage/admin/capabilities/${userId}`, {
        mayMapLocal: patch.may_map_local ?? current.may_map_local,
        mayMapCloud: patch.may_map_cloud ?? current.may_map_cloud,
        mayIndex: patch.may_index ?? current.may_index,
        maxFiles: current.max_files,
        maxBytes: 'max_bytes' in patch ? patch.max_bytes : current.max_bytes,
      });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not change storage access'); }
    finally { setBusy(null); }
  }

  // item 40h-DECIDED: an admin edits the per-person storage limit in GB; we
  // convert to bytes at the boundary because that's the unit the schema and
  // the enforcement in packages/storage/src/gates.ts both use. An empty draft
  // clears the override and falls back to the 20GB workspace default.
  async function saveQuota(userId: string) {
    const draft = (quotaDraft[userId] ?? '').trim();
    let maxBytes: number | null;
    if (draft === '') {
      maxBytes = null;
    } else {
      const gb = Number(draft);
      if (!Number.isFinite(gb) || gb <= 0) {
        setError('Storage limit must be a number greater than zero, or blank for the default');
        return;
      }
      maxBytes = Math.round(gb * GB);
    }
    await setStorageGrant(userId, { max_bytes: maxBytes });
    setQuotaDraft((d) => { const next = { ...d }; delete next[userId]; return next; });
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">People</h1>

      <Card>
        <CardTitle>Add someone</CardTitle>
        <form onSubmit={create} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm" htmlFor="new-email">Email</label>
            <Input id="new-email" name="email" type="email" inputMode="email" required />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="new-username">Username</label>
            <Input id="new-username" name="username" autoCapitalize="none" required />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit">Add person</Button>
        </form>
        {invite ? (
          <div className="mt-3 rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-sm font-medium">Give them this link</p>
            <p className="mt-1 text-xs text-muted-foreground">
              No email was sent — this installation cannot send mail yet. The link sets their password once.
            </p>
            <code className="mt-2 block break-all text-xs">{invite}</code>
          </div>
        ) : null}
      </Card>

      <ul className="space-y-2">
        {users.map((u) => (
          <li key={u.id}>
            <Card>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{u.username}</span>
                <Badge tone={u.role === 'super_admin' ? 'primary' : 'muted'}>
                  {u.role === 'super_admin' ? 'administrator' : 'member'}
                </Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">{u.email}</p>
              {storage[u.id] ? (
                <div className="mt-3 border-t border-border pt-3">
                  <p className="mb-2 text-xs font-medium">Folder and indexing access</p>
                  <div className="flex flex-wrap gap-2">
                    {([
                      ['may_map_local', 'Local folders'], ['may_map_cloud', 'Cloud folders'], ['may_index', 'Index/search'],
                    ] as const).map(([key, label]) => (
                      <Button key={key} variant={storage[u.id][key] ? 'primary' : 'secondary'}
                        disabled={busy === u.id}
                        onClick={() => void setStorageGrant(u.id, { [key]: !storage[u.id][key] })}>
                        {label}: {storage[u.id][key] ? 'On' : 'Off'}
                      </Button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{storage[u.id].mappings} mapped folder(s). Turning indexing off purges derived searchable text.</p>

                  <div className="mt-3 border-t border-border pt-3">
                    <label className="mb-1 block text-xs font-medium" htmlFor={`quota-${u.id}`}>Storage limit (GB)</label>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {storage[u.id].max_bytes === null
                        ? `Using the workspace default: ${bytesToGb(DEFAULT_QUOTA_BYTES)} GB`
                        : `Custom limit set by an administrator: ${bytesToGb(storage[u.id].max_bytes as number)} GB`}
                    </p>
                    <div className="flex items-center gap-2">
                      <Input
                        id={`quota-${u.id}`}
                        inputMode="decimal"
                        placeholder={String(bytesToGb(DEFAULT_QUOTA_BYTES))}
                        value={quotaDraft[u.id] ?? ''}
                        onChange={(e) => setQuotaDraft((d) => ({ ...d, [u.id]: e.target.value }))}
                        className="max-w-32"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy === u.id || !(u.id in quotaDraft)}
                        onClick={() => void saveQuota(u.id)}
                      >
                        Save
                      </Button>
                      {storage[u.id].max_bytes !== null ? (
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy === u.id}
                          onClick={() => void setStorageGrant(u.id, { max_bytes: null })}
                        >
                          Reset to default
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
