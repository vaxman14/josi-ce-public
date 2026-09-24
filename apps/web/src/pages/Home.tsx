// What is waiting for me.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Approval, type LlmStatus, type Task } from '@/lib/api';
import { Badge, Card, CardTitle, Empty } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';
import { watchApprovals, type ApprovalSnapshot } from '@/lib/approvalRefresh';
import { useAuth } from '@/lib/auth';

export function Home() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);
  const [status, setStatus] = useState<LlmStatus | null>(null);

  useEffect(() => {
    void api.get<{ tasks: Task[] }>('/assistant/tasks').then((r) => setTasks(r.tasks)).catch(() => undefined);
    void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => undefined);
  }, []);

  useEffect(() => watchApprovals(
    () => api.get<ApprovalSnapshot<Approval>>('/assistant/approvals'),
    snapshot => { setApprovals(snapshot.approvals); setApprovalCount(snapshot.count); },
  ), []);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">
        Hello{user?.display_name ? `, ${user.display_name}` : ''}
      </h1>

      {/* Honest about whether Josi can do anything at all right now. */}
      {status && !status.ready ? (
        <Card className="border-primary/40">
          <CardTitle>Josi is not ready yet</CardTitle>
          <p className="text-sm text-muted-foreground">
            {status.disabledFeatures[0]?.reason ?? 'No model has been set up on this installation.'}
          </p>
        </Card>
      ) : null}

      <Link className="flex min-h-11 items-center rounded-md px-2 text-sm underline" to="/app/email/templates">Email / Templates</Link>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardTitle>Waiting on you</CardTitle>
          {approvalCount === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs your approval.</p>
          ) : (
            <ul className="space-y-1">
              {approvals.slice(0, 4).map((a) => (
                <li key={a.id}>
                  {/* A block link with a real height, not a phrase in a
                      sentence. The suite measures every link on the page and an
                      underlined run of 16px text is a target nobody can hit. */}
                  <Link
                    className="flex min-h-11 items-center rounded-md px-2 text-sm underline underline-offset-2 hover:bg-secondary"
                    to="/app/approvals"
                  >
                    <span className="min-w-0 truncate">{a.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Open tasks</CardTitle>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in progress.</p>
          ) : (
            <ul className="space-y-2">
              {tasks.slice(0, 4).map((t) => (
                <li key={t.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                  <span className="truncate">{t.template_key.replace(/_/g, ' ')}</span>
                  <Badge>{plain('task_state', t.state)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {tasks.length === 0 && approvalCount === 0 ? (
        <Empty title="Nothing is waiting">
          <span className="block">Start by telling Josi what you need.</span>
          <Link
            to="/app/talk"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          >
            Talk to Josi
          </Link>
        </Empty>
      ) : null}
    </div>
  );
}
