import { useEffect, useState } from 'react';
import { api, type Contact } from '@/lib/api';
import { Button, Card, Empty, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

export function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.get<{ contacts: Contact[] }>('/assistant/contacts').then((r) => setContacts(r.contacts)).catch(() => undefined);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api.post('/assistant/contacts', {
        name: form.get('name'), email: form.get('email'), phone: form.get('phone'),
      });
      event.currentTarget.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
      <p className="text-sm text-muted-foreground">Private to you, like your conversations.</p>

      <Card>
        <form onSubmit={create} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-name">Name</label>
            <Input id="c-name" name="name" required />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-email">Email</label>
            <Input id="c-email" name="email" type="email" inputMode="email" />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-phone">Phone</label>
            <Input id="c-phone" name="phone" type="tel" inputMode="tel" />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add contact'}</Button>
        </form>
      </Card>

      <ContactSyncPanel onChanged={() => void load()} />

      {contacts.length === 0 ? (
        <Empty title="No contacts yet" />
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <li key={c.id}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{c.name ?? 'Unnamed'}</p>
                  {/* LB8.7. A synced contact that looks identical to one
                      somebody typed is a contact nobody can reason about when
                      it changes on its own. */}
                  {c.source && c.source !== 'josi' ? (
                    <span className="text-xs text-muted-foreground">
                      {plain('contact_source', c.source)}
                      {c.source_account ? ` · ${c.source_account}` : ''}
                    </span>
                  ) : null}
                </div>
                {c.email ? <p className="truncate text-sm text-muted-foreground">{c.email}</p> : null}
                {c.phone ? <p className="truncate text-sm text-muted-foreground">{c.phone}</p> : null}
                {c.conflict_state === 'both_changed' ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
{plainDetail('contact_conflict', 'both_changed')}
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Origin {
  id: string;
  connectionId: string;
  provider: 'google' | 'microsoft';
  sourceAccount: string;
  syncMode: 'import_only' | 'two_way';
  status: 'idle' | 'syncing' | 'error' | 'paused' | 'disconnected';
  lastSyncAt: string | null;
  lastErrorCategory: string | null;
  counts: Record<string, number>;
  intervalSeconds: number;
}

/** The choices offered. Five minutes is the floor the server enforces too —
 * anything faster is polling a provider hard for contacts that change a few
 * times a month. */
const INTERVALS: Array<[number, string]> = [
  [300, 'Every 5 minutes'],
  [900, 'Every 15 minutes'],
  [1800, 'Every 30 minutes'],
  [3600, 'Every hour'],
  [86400, 'Once a day'],
];

/** Which accounts are syncing, and what happened last time.
 *
 * Suggestions are shown, never applied: `findDuplicates` decides what is worth
 * asking about, and only the same record seen twice is ever merged unattended.
 */
function ContactSyncPanel({ onChanged }: { onChanged: () => void }) {
  const [origins, setOrigins] = useState<Origin[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<Array<{ left: string; right: string; reason: string }>>([]);

  const load = () =>
    api.get<{ origins: Origin[] }>('/contacts/sync')
      .then((r) => setOrigins(r.origins))
      .catch(() => setError('Could not load contact synchronization status. Try again.'));

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer); }, []);

  async function act(path: string, id: string) {
    setBusy(id);
    setError('');
    try {
      const result = await api.post<{ needsReview?: typeof review }>(path, {});
      if (result?.needsReview) setReview(result.needsReview);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy('');
    }
  }

  if (!origins || origins.length === 0) return <Card><p className="text-sm">Contact sync starts automatically after you enable contact read access in Connections. Imported contacts stay when you stop syncing.</p>{error ? <ErrorNote>{error}</ErrorNote> : null}</Card>;

  return (
    <Card>
      <p className="mb-2 text-sm font-medium">Synced accounts</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ul className="space-y-3">
        {origins.map((o) => (
          <li key={o.id} className="border-t border-input pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm">
                {plain('contact_source', o.provider)} · {o.sourceAccount}
              </span>
              <span className="text-xs text-muted-foreground">
                {plain('contact_sync_status', o.status)}
                {' · '}{plain('contact_sync_mode', o.syncMode).toLowerCase()}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {o.lastSyncAt ? `Last synced ${new Date(o.lastSyncAt).toLocaleString()}` : 'Not synced yet'}
              {o.status === 'error' && o.lastErrorCategory
                ? ` · ${plainDetail('connector_error', o.lastErrorCategory)
                    ?? plain('connector_error', o.lastErrorCategory)}`
                : ''}
            </p>
            {o.status !== 'disconnected' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" disabled={!!busy} onClick={() => void act(`/contacts/sync/${o.id}/run`, o.id)}>
                  {busy === o.id ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button type="button" variant="secondary" disabled={!!busy}
                        onClick={() => void act(`/contacts/sync/${o.id}/stop`, o.id)}>
                  Stop syncing
                </Button>
                <label className="sr-only" htmlFor={`iv-${o.id}`}>How often to sync</label>
                <select
                  id={`iv-${o.id}`}
                  value={o.intervalSeconds}
                  disabled={!!busy}
                  onChange={(e) => {
                    setBusy(o.id);
                    void api.put(`/contacts/sync/${o.id}/interval`, { seconds: Number(e.target.value) })
                      .then(load)
                      .catch((err) => setError(err instanceof Error ? err.message : 'That did not work'))
                      .finally(() => setBusy(''));
                  }}
                  className="min-h-11 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {INTERVALS.map(([seconds, label]) => (
                    <option key={seconds} value={seconds}>{label}</option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                {plain('contact_sync_status', 'disconnected')}. {plainDetail('contact_sync_status', 'disconnected')}
                <Button type="button" disabled={!!busy} onClick={() => { setBusy(o.id); void api.put(`/contacts/sync/${o.connectionId}`, { mode: 'import_only' }).then(load).catch((err) => setError(err instanceof Error ? err.message : 'Reconnect this account in Connections.')).finally(() => setBusy('')); }}>Restart import sync</Button>
              </p>
            )}
          </li>
        ))}
      </ul>

      {review.length ? (
        <div className="mt-3 border-t border-input pt-3">
          <p className="text-sm font-medium">Possible duplicates</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Nothing has been merged. Josi only joins records automatically when they are the same
            record from the same account.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {review.map((r) => <li key={`${r.left}:${r.right}`}>• {r.reason}</li>)}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
