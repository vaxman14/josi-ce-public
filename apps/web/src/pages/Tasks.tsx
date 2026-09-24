// Work Josi has taken on — and everything she has scheduled.
//
// Reminders live here too (round-2 item 13): anything the assistant schedules
// must be visible and cancellable in the product, not trapped in chat.
import { useEffect, useState } from 'react';
import { api, type Reminder, type Task, type TaskType } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [types, setTypes] = useState<TaskType[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [upcoming, setUpcoming] = useState<Reminder[]>([]);
  const [recent, setRecent] = useState<Reminder[]>([]);
  const [reminderError, setReminderError] = useState('');
  const [approvalPassword, setApprovalPassword] = useState('');

  const load = () =>
    api.get<{ tasks: Task[] }>('/assistant/tasks').then((r) => setTasks(r.tasks)).catch(() => undefined);

  const loadReminders = () =>
    api.get<{ upcoming: Reminder[]; recent: Reminder[] }>('/assistant/reminders')
      .then((r) => { setUpcoming(r.upcoming); setRecent(r.recent); })
      .catch(() => undefined);

  useEffect(() => {
    void load();
    void loadReminders();
    void api.get<{ types: TaskType[] }>('/assistant/task-types').then((r) => {
      setTypes(r.types);
      setTemplateKey(r.types[0]?.key ?? '');
    }).catch(() => undefined);
  }, []);

  async function cancelReminder(id: string) {
    setReminderError('');
    try {
      await api.post(`/assistant/reminders/${id}/cancel`);
      await loadReminders();
    } catch (err) {
      setReminderError(err instanceof Error ? err.message : 'Could not cancel that reminder');
    }
  }

  async function approveTask(id: string) {
    setError(''); try {
      await api.post('/assistant/step-up', { password: approvalPassword });
      await api.patch(`/assistant/tasks/${id}`, { state: 'ready' }); setApprovalPassword(''); await load();
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not approve that task'); }
  }

  const selected = types.find((t) => t.key === templateKey);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const slots: Record<string, string> = {};
    for (const key of selected.contract.slots.required) slots[key] = String(form.get(key) ?? '');
    try {
      await api.post('/assistant/tasks', { templateKey, slots });
      await load();
      event.currentTarget.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>

      <Card>
        <form onSubmit={create} className="space-y-3">
          <label className="block text-sm font-medium" htmlFor="template">New task</label>
          <select
            id="template"
            value={templateKey}
            onChange={(e) => setTemplateKey(e.target.value)}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          >
            {types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>

          {/* What this kind of work is still waiting on, stated before it is
              created rather than discovered afterwards. */}
          {selected?.requiresCapability ? (
            <p className="text-sm text-muted-foreground">
              Josi can prepare this, but nothing is connected to carry it out yet
              ({selected.requiresCapability.replace(/_/g, ' ')}), so it will wait.
            </p>
          ) : null}

          {selected?.contract.slots.required.map((slot) => (
            <div key={slot}>
              <label className="mb-1 block text-sm" htmlFor={`slot-${slot}`}>{slot.replace(/_/g, ' ')}</label>
              <Input id={`slot-${slot}`} name={slot} required />
            </div>
          ))}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit" disabled={busy || !selected}>{busy ? 'Creating…' : 'Create task'}</Button>
        </form>
      </Card>

      <Card>
        <CardTitle>Reminders</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          What Josi will nudge you about, and what recently fired. Ask her on the Talk page to set one.
        </p>
        {reminderError ? <ErrorNote>{reminderError}</ErrorNote> : null}
        {upcoming.length === 0 && recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reminders yet.</p>
        ) : (
          <div className="space-y-3">
            {upcoming.length ? (
              <ul className="space-y-2">
                {upcoming.map((r) => (
                  <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-input p-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{r.body}</p>
                      <p className="text-sm text-muted-foreground">{when(r.due_at)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone="primary">{plain('reminder_status', r.status)}</Badge>
                      <Button type="button" variant="secondary" onClick={() => void cancelReminder(r.id)}>Cancel</Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing coming up.</p>
            )}
            {recent.length ? (
              <div>
                <p className="mb-1 text-sm font-medium text-muted-foreground">Last 7 days</p>
                <ul className="space-y-2">
                  {recent.map((r) => (
                    <li key={r.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-input p-3">
                      <div className="min-w-0">
                        <p className="break-words text-sm">{r.body}</p>
                        <p className="text-sm text-muted-foreground">{when(r.delivered_at ?? r.due_at)}</p>
                      </div>
                      <Badge tone="muted">{plain('reminder_status', r.status)}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      {tasks.length === 0 ? (
        <Empty title="No tasks yet">Ask Josi for something on the Talk page, or create one above.</Empty>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <Card>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{task.template_key.replace(/_/g, ' ')}</span>
                  <Badge tone={task.state === 'ready' ? 'primary' : 'muted'}>{plain('task_state', task.state)}</Badge>
                </div>
                {Object.entries(task.slots).length ? (
                  <dl className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {Object.entries(task.slots).map(([k, v]) => (
                      <div key={k} className="flex min-w-0 gap-2">
                        <dt className="shrink-0">{k.replace(/_/g, ' ')}:</dt>
                        <dd className="min-w-0 break-words">{String(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {task.state === 'awaiting_approval' ? (
                  <div className="mt-3 space-y-2"><Input type="password" autoComplete="current-password" placeholder="Confirm your password" value={approvalPassword} onChange={(e) => setApprovalPassword(e.target.value)} />
                    <Button disabled={!approvalPassword} onClick={() => void approveTask(task.id)}>Approve and carry out</Button></div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
