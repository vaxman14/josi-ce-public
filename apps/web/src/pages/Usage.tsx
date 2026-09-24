// What Josi has cost, said honestly.
//
// Three numbers, never blended into one. M88: a provider-reported charge and a
// figure we worked out from a local price list are different kinds of claim,
// and a self-hosted model has no provider charge at all.
import { type LlmStatus } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { ResourceFallback } from '@/components/ResourceFallback';
import { Badge, Card, CardTitle, CollapsibleCard } from '@/components/ui';

export function Usage() {
  // Every outcome named — same fix as Overview.   // undefined)` made any failed fetch an infinite spinner.
  const resource = useResource<LlmStatus>('/llm/status');

  if (resource.state !== 'ready' || !resource.data) {
    // The heading renders even while the numbers are still coming.
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
        <ResourceFallback resource={resource} />
      </div>
    );
  }
  const { usage, cap } = resource.data;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
      <p className="text-sm text-muted-foreground">Your own usage this month ({usage.month}).</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardTitle>Tokens</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">{usage.totalTokens.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{usage.calls} request{usage.calls === 1 ? '' : 's'}</p>
        </Card>
        <Card>
          <CardTitle>Provider charges</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">${usage.reportedCostUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">As reported by the provider</p>
        </Card>
        <Card>
          <CardTitle>Estimated</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">${usage.estimatedCostUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Worked out locally, not a bill</p>
        </Card>
      </div>

      {usage.selfHostedCalls > 0 ? (
        <CollapsibleCard title="Self-hosted" summary={`${usage.selfHostedCalls} local ${usage.selfHostedCalls === 1 ? 'request' : 'requests'} · $0 provider charge`}>
          <p className="text-sm text-muted-foreground">
            {usage.selfHostedCalls} request{usage.selfHostedCalls === 1 ? '' : 's'} to a model on your own
            hardware — $0 provider charge. Hardware and electricity are not counted here.
          </p>
        </CollapsibleCard>
      ) : null}

      <CollapsibleCard title="Budget" summary={cap.message} status={<Badge tone={cap.allowed ? (cap.status === 'ok' ? 'ok' : 'primary') : 'danger'}>{cap.status.replace('_', ' ')}</Badge>}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cap.allowed ? (cap.status === 'ok' ? 'ok' : 'primary') : 'danger'}>
            {cap.status.replace('_', ' ')}
          </Badge>
          <p className="min-w-0 break-words text-sm text-muted-foreground">{cap.message}</p>
        </div>
      </CollapsibleCard>

      {usage.notes.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {usage.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
