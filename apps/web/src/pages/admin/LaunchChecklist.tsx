// What the administrator still has to do.
//
// Setup finishing used to drop the person who ran it onto the ordinary user
// dashboard — the same page every member sees — with no sign that nobody had
// been invited, no backup existed, the master key had never left the server,
// and two setup steps had been skipped. This is the page they land on instead,
// once, until they have looked at it.
//
// Nothing here can be ticked by hand. Every item is derived from what the
// installation contains, except the master-key backup, which Josi cannot
// observe because the copy leaves the server.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote } from '@/components/ui';

type State = 'done' | 'outstanding' | 'failed' | 'dismissed' | 'unavailable';
type Severity = 'critical' | 'important' | 'optional';

interface Item {
  key: string;
  label: string;
  why: string;
  severity: Severity;
  href: string | null;
  insteadOfScreen?: string;
  state: State;
  detail: string | null;
  dismissible: boolean;
}

interface Checklist {
  seen: boolean;
  items: Item[];
  progress: { done: number; total: number };
  reminders: Item[];
  complete: boolean;
}

const STATE_LABEL: Record<State, string> = {
  done: 'Done',
  outstanding: 'To do',
  failed: 'Not working',
  dismissed: 'Put aside',
  unavailable: 'Not available here',
};

const STATE_TONE: Record<State, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  outstanding: 'text-amber-600 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400',
  dismissed: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
};

export function AdminLaunchChecklist() {
  const navigate = useNavigate();
  const [data, setData] = useState<Checklist | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Checklist>('/admin/launch-checklist'));
      setFailedToLoad(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The checklist could not be loaded');
      setFailedToLoad(true);
    }
  }, []);

  useEffect(() => {
    // Marking it seen is what stops sign-in sending them back here. It is a
    // POST rather than a side effect of the read, so a probe cannot do it.
    void api.post('/admin/launch-checklist/seen', {}).catch(() => undefined).then(load);
  }, [load]);

  async function act(path: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(path, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That could not be saved');
    } finally {
      setBusy(false);
    }
  }

  if (failedToLoad) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Getting started</h1>
        <Card>
          <ErrorNote>{error}</ErrorNote>
          <Button className="mt-3" onClick={() => void load()}>Try again</Button>
        </Card>
      </div>
    );
  }

  if (!data) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;

  const { done, total } = data.progress;
  const groups = [
    { severity: 'critical' as const, title: 'Protect this installation', summary: 'Backups and required security safeguards' },
    { severity: 'important' as const, title: 'Finish essential setup', summary: 'Checks required for dependable day-to-day use' },
    { severity: 'optional' as const, title: 'Optional capabilities', summary: 'Useful additions that may not apply here' },
  ].map((group) => ({ ...group, items: data.items.filter((item) => item.severity === group.severity) }));

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <div>
        {/* An explicit exit, at the top. This page had no completion action at
            all — a person read it and then… nothing. Reading it already marks
            it seen (the POST above), so "Done" is honest: it will not come
            back uninvited, and it stays reachable from the admin menu. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Getting started</h1>
          <Button type="button" onClick={() => navigate('/app')}>Done — go to my dashboard</Button>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Josi is installed. These are the things only you can do — {done} of {total} settled.
        </p>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full bg-primary transition-all"
               style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {/* Material risks keep saying so. These are the ones that cannot be put
          aside, and repeating them is the whole point. */}
      {data.reminders.length ? (
        <Card>
          <CardTitle>Do these before you rely on this installation</CardTitle>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {data.reminders.map((r) => <li key={r.key}>• {r.label}</li>)}
          </ul>
        </Card>
      ) : null}

      {groups.filter((group) => group.items.length).map((group) => {
        const settled = group.items.filter((item) => ['done', 'dismissed', 'unavailable'].includes(item.state)).length;
        const needsAttention = group.items.some((item) => item.state === 'failed'
          || (group.severity === 'critical' && item.state === 'outstanding'));
        return <CollapsibleCard key={group.severity} title={group.title}
          summary={`${group.summary} · ${settled} of ${group.items.length} settled`}
          status={<Badge tone={needsAttention ? 'danger' : settled === group.items.length ? 'ok' : 'primary'}>
            {needsAttention ? 'Needs attention' : `${settled}/${group.items.length}`}
          </Badge>}
          defaultOpen={needsAttention}>
        <ul className="space-y-4">
          {group.items.map((item) => (
            <li key={item.key} className="border-t border-input pt-4 first:border-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{item.label}</span>
                <span className={`text-xs font-medium ${STATE_TONE[item.state]}`}>
                  {STATE_LABEL[item.state]}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{item.why}</p>
              {/* No screen for it. Saying where the work happens beats a
                  button that goes nowhere — which is what the first version
                  of this did, silently. */}
              {!item.href && (item.state === 'outstanding' || item.state === 'failed') ? (
                <p className="mt-1 text-xs text-muted-foreground">{item.insteadOfScreen}</p>
              ) : null}
              {item.detail ? (
                <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
              ) : null}

              <div className="mt-2 flex flex-wrap gap-2">
                {item.state === 'outstanding' || item.state === 'failed' ? (
                  item.key === 'master_key_backup' ? (
                    <Button type="button" disabled={busy}
                            onClick={() => void act('/admin/launch-checklist/master-key-backed-up')}>
                      I have copied it somewhere safe
                    </Button>
                  ) : item.href ? (
                    <Button type="button" disabled={busy} onClick={() => navigate(item.href!)}>
                      Do this
                    </Button>
                  ) : null
                ) : null}

                {item.dismissible && item.state === 'outstanding' ? (
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => void act(`/admin/launch-checklist/dismiss/${item.key}`)}>
                    Skip
                  </Button>
                ) : null}

                {item.state === 'dismissed' ? (
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => void act(`/admin/launch-checklist/restore/${item.key}`)}>
                    Put it back on the list
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CollapsibleCard>;
      })}

      <Card>
        <p className="text-sm text-muted-foreground">
          You can come back to this from the admin section at any time. Nothing here expires.
        </p>
        <Button className="mt-3" onClick={() => navigate('/app')}>
          Done — go to my dashboard
        </Button>
      </Card>
    </div>
  );
}
