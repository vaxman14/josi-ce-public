// The deny-only approval ceiling.
//
// Two rules, and the page states both because a person setting this needs to
// know what they are and what they are not doing:
//
//   1. The ceiling can only TIGHTEN what someone chose. An administrator who
//      sets "each person decides" has not switched anyone to automatic; they
//      have returned the choice, and somebody who asked to be consulted every
//      time still will be.
//   2. A fresh user's own preference asks about everything. No administrator
//      ceiling exists until an administrator deliberately creates one.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CollapsibleCard, ErrorNote } from '@/components/ui';

interface PolicyClass {
  key: string;
  label: string;
  description: string;
  impact: 'routine' | 'high';
  maxLevel: string | null;
  explicit: boolean;
}

interface MigrationRow {
  action_class: string;
  previous_max_level: string | null;
  new_max_level: string;
  reason: string;
}

interface PolicyPayload {
  defaultCeiling: string | null;
  classes: PolicyClass[];
  migration: MigrationRow[];
}

const LEVELS = [
  { value: 'always_ask', label: 'Ask me every time', rank: 0 },
  { value: 'risky_only', label: 'Ask only for risky actions', rank: 1 },
  // Deliberately not called "no ceiling". It IS the absence of a ceiling, and
  // naming it that made it read like the neutral option rather than the loosest
  // one — which is how it came to be the factory default.
  { value: 'automatic', label: 'Let each person decide for themselves', rank: 2 },
];

const rankOf = (value: string) => LEVELS.find((l) => l.value === value)?.rank ?? 0;

export function AdminPolicy() {
  const [data, setData] = useState<PolicyPayload | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    setError('');
    try {
      setData(await api.get<PolicyPayload>('/admin/assistant/approval-policy'));
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the approval policy');
      setState('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function set(cls: PolicyClass, maxLevel: string) {
    const current = cls.maxLevel ?? 'automatic';
    if (maxLevel === current) return;
    setError('');

    // Loosening is confirmed here AND refused by the server without the flag,
    // so a client that forgets to ask cannot quietly relax a ceiling.
    const relaxing = rankOf(maxLevel) > rankOf(current);
    if (relaxing) {
      const to = LEVELS.find((l) => l.value === maxLevel)?.label ?? maxLevel;
      const extra = cls.impact === 'high'
        ? '\n\nThis is a high-impact action. Josi will still ask before each individual one, '
          + 'but this widens what the rest of the class permits.'
        : '';
      const ok = window.confirm(
        `Loosen “${cls.label}” to “${to}”?\n\n`
        + 'This lets Josi act without asking first, for anyone who chooses that for themselves. '
        + `It is recorded against your account.${extra}`,
      );
      if (!ok) { await load(); return; }
    }

    setBusy(cls.key);
    try {
      await api.put(`/admin/assistant/approval-policy/${cls.key}`, {
        maxLevel,
        confirmRelaxation: relaxing,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
      await load();
    } finally {
      setBusy('');
    }
  }

  async function acknowledge() {
    try {
      await api.post('/admin/assistant/approval-policy/acknowledge-migration', {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not acknowledge that');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Approval policy</h1>

      {state === 'loading' ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {state === 'error' ? (
        <Card>
          <ErrorNote>{error || 'The approval policy could not be loaded.'}</ErrorNote>
          <Button className="mt-3" onClick={() => void load()}>Try again</Button>
        </Card>
      ) : null}

      {state === 'ready' && data ? (
        <>
          {data.migration.length ? (
            <CollapsibleCard title="What changed when this installation was updated" summary={`${data.migration.length} ${data.migration.length === 1 ? 'policy change needs' : 'policy changes need'} review`} defaultOpen>
              <p className="mb-3 text-sm text-muted-foreground">
                These actions previously had no administrator ceiling, which meant no ceiling at all.
                They now ask for approval. Nothing you had explicitly set was changed.
              </p>
              <ul className="mb-3 space-y-1 text-sm">
                {data.migration.map((m) => (
                  <li key={m.action_class}>
                    <span className="font-medium">
                      {data.classes.find((c) => c.key === m.action_class)?.label ?? m.action_class}
                    </span>
                    {' — now '}
                    {LEVELS.find((l) => l.value === m.new_max_level)?.label ?? m.new_max_level}
                  </li>
                ))}
              </ul>
              <Button onClick={() => void acknowledge()}>I have read this</Button>
            </CollapsibleCard>
          ) : null}

          <CollapsibleCard title="What is the loosest anyone may choose?"
            summary="Administrator ceilings for every action class"
            status={<Badge tone={data.classes.some((cls) => cls.explicit) ? 'primary' : 'muted'}>
              {data.classes.some((cls) => cls.explicit) ? 'Managed limits active' : 'No managed limits'}
            </Badge>}
            defaultOpen>
            <p className="mb-1 text-sm text-muted-foreground">
              This can only tighten. Returning the choice to each person does not switch anyone to
              automatic — somebody who asked to be consulted every time still will be.
            </p>
            <p className="mb-4 text-sm text-muted-foreground">
              A new user asks about everything by default. A managed limit exists only after you set
              one here, and every change is recorded against your account.
            </p>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="space-y-5">
              {data.classes.map((cls) => (
                <div key={cls.key}>
                  <label className="mb-0.5 block text-sm font-medium" htmlFor={`pol-${cls.key}`}>
                    {cls.label}
                    {cls.impact === 'high' ? (
                      <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                        High impact
                      </span>
                    ) : null}
                  </label>
                  <p className="mb-1.5 text-xs text-muted-foreground">{cls.description}</p>
                  <select
                    id={`pol-${cls.key}`}
                    value={cls.maxLevel ?? 'automatic'}
                    disabled={busy === cls.key}
                    onChange={(e) => void set(cls, e.target.value)}
                    className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                  >
                    {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select>
                  {cls.impact === 'high' ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Josi asks before each individual action in this class whatever this is set to.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </CollapsibleCard>
        </>
      ) : null}
    </div>
  );
}
