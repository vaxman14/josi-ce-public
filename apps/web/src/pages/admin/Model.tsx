// The model this installation uses.
//
// Two things this page must never do: claim a model works before it has been
// tested, and offer a subscription option that has no compliant path. Both are
// server-enforced; this reflects them.
//
// Phase 13.3 changed the second one from a blanket refusal to a per-provider
// answer, because half of it stopped being true. The screen no longer decides
// which options are available — the server does, from the edition stamped into
// the build — and each one carries the actual current reason. An option that IS
// available gets a real control; one that is not gets no control at all, and
// never a disabled button that looks pressable.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Copyable } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';
import {
  ProviderForm, type ProviderCatalogEntry, type SubscriptionInfo,
} from '@/components/ProviderForm';

interface Provider {
  provider: string;
  model: string;
  active: boolean;
  probedAt: string | null;
  capabilities: { chat: boolean; structuredOutput: boolean; toolCalling: boolean; contextTokens: number | null } | null;
  probeSteps: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

interface AdminLlm {
  primary: Provider | null;
  fallback: Provider | null;
  localOnly: boolean;
  disabledFeatures: Array<{ feature: string; reason: string }>;
  subscriptionOptions: Array<{
    id: string; label: string; available: boolean; provider: string | null; reason: string;
  }>;
  edition: { edition: string; capabilities: string[] };
  /** Every provider this build will accept, sent with the page so the form
   * cannot draw one the server would then refuse. */
  providerCatalog: ProviderCatalogEntry[];
}

interface CodexStatus {
  installed: boolean;
  signedIn: boolean;
  detail: string;
}

interface DeviceLoginState {
  state: 'idle' | 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string; userCode: string } | null;
  expiresAt: string | null;
  message: string | null;
}

export function AdminModel() {
  const [data, setData] = useState<AdminLlm | null>(null);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);

  const load = () => api.get<AdminLlm>('/admin/llm').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);


  /** Runs ONLY from the button below.
   *
   * There is deliberately no effect that calls this. The model was tested
   * during setup with a real request, that result is stored on the provider
   * row, and re-running it because a page was opened would spend a real
   * request — and, on a subscription provider, the operator's own quota — to
   * re-establish something already known. */
  async function probe() {
    setProbing(true);
    setError('');
    try {
      await api.post('/admin/llm/providers/primary/probe');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run');
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Model</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose what Josi uses to respond.</p>
      </div>
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {data ? <>
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Currently using</div>
          {data.primary ? <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">
                  {data.providerCatalog?.find((p) => p.kind === data.primary?.provider)?.label
                    ?? plain('model_provider', data.primary.provider)}
                </p>
                <p className="break-words text-xl font-semibold tracking-tight">
                  {data.primary.model || (data.primary.provider === 'openai_subscription'
                    ? 'Automatic (Codex chooses)' : data.primary.provider === 'anthropic_subscription'
                      ? 'Automatic (Claude chooses)' : 'Provider default')}
                </p>
              </div>
              <Badge tone={data.primary.active ? 'ok' : 'danger'}>
                {data.primary.active ? 'Working' : 'Not tested'}
              </Badge>
            </div>
            {!data.primary.active ? <p className="text-sm text-muted-foreground">
              Josi will not use this model until it passes a real test.
            </p> : null}
          </> : <p className="text-sm text-muted-foreground">No model is configured yet.</p>}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="button" onClick={() => setChangeOpen(true)} disabled={probing || saving}>Change model</Button>
            {data.primary && !data.primary.active ? <Button type="button" variant="secondary"
              onClick={() => void probe()} disabled={probing || saving}>{probing ? 'Testing…' : 'Test this model'}</Button> : null}
          </div>
        </Card>

        {changeOpen ? <Card className="space-y-4 p-5 sm:p-6">
          <div>
            <CardTitle>Change model</CardTitle>
            <p className="text-sm text-muted-foreground">
              Models load automatically. Nothing changes until you save and test.
            </p>
          </div>
          <ChangeModelForm catalog={data.providerCatalog ?? []}
            initialProvider={data.primary?.provider ?? 'openai_compatible'}
            blocked={probing} onBusyChange={setSaving}
            onCancel={() => setChangeOpen(false)}
            onSaved={(passed) => { void load(); if (passed) setChangeOpen(false); }} />
        </Card> : null}

        <details className="rounded-lg border border-border bg-card p-5 text-sm sm:p-6">
          <summary className="min-h-11 cursor-pointer font-medium">Connection &amp; advanced</summary>
          <div className="space-y-5 border-t border-border pt-4">
            {data.subscriptionOptions.some((o) => o.available && o.provider === 'openai_subscription')
              ? <div className="space-y-2"><h2 className="font-medium">ChatGPT connection</h2><CodexConnection /></div>
              : null}
            {data.primary ? <div className="space-y-2">
              <h2 className="font-medium">Current model details</h2>
              {data.primary.model ? <Copyable label="Model identifier" value={data.primary.model} />
                : <p className="text-muted-foreground">The provider chooses the model automatically.</p>}
              {plainDetail('model_provider', data.primary.provider)
                ? <p className="text-muted-foreground">{plainDetail('model_provider', data.primary.provider)}</p> : null}
              {data.primary.active ? <Button type="button" variant="secondary"
                disabled={probing || saving} onClick={() => void probe()}>{probing ? 'Testing…' : 'Test again'}</Button> : null}
              {Array.isArray(data.primary.probeSteps) && data.primary.probeSteps.length ? <ul className="space-y-1">
                {data.primary.probeSteps.map((s) => <li key={s.id} className="break-words">
                  {s.passed ? '✓' : '✗'} {s.label} — {s.detail}
                </li>)}
              </ul> : null}
            </div> : null}
            {data.disabledFeatures.length ? <div className="space-y-2">
              <h2 className="font-medium">Unavailable features</h2>
              <ul className="space-y-1 text-muted-foreground">
                {data.disabledFeatures.map((f) => <li key={f.feature}>
                  {f.feature === 'chat_vision' ? 'Image understanding' : f.feature.replace(/_/g, ' ')} — {f.reason}
                </li>)}
              </ul>
            </div> : null}
            {data.subscriptionOptions.some((o) => !o.available) ? <div className="space-y-2">
              <h2 className="font-medium">Other subscription options</h2>
              <ul className="space-y-1 text-muted-foreground">
                {data.subscriptionOptions.filter((o) => !o.available).map((o) => <li key={o.id}>
                  {o.label} — {o.reason}
                </li>)}
              </ul>
            </div> : null}
          </div>
        </details>
      </> : null}
    </div>
  );
}

/** The wizard's provider form, pointed at the admin endpoints. */
function ChangeModelForm(
  { catalog, onSaved, initialProvider, onCancel, blocked, onBusyChange }: {
    catalog: ProviderCatalogEntry[]; onSaved: (passed: boolean) => void; initialProvider: string;
    onCancel: () => void; blocked: boolean; onBusyChange: (value: boolean) => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');


  return (
    <div className="space-y-2">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ProviderForm
        busy={busy || blocked}
        compact
        onCancel={onCancel}
        initialProvider={initialProvider}
        catalog={catalog}
        paths={{
          models: '/admin/llm/models',
          codexBase: '/admin/llm/subscription',
          claudeBase: '/admin/llm/subscription/claude',
        }}
        loadSubscriptionInfo={async () => {
          try {
            const llm = await api.get<AdminLlm>('/admin/llm');
            const cli = await api.get<{ cli: CodexStatus }>('/admin/llm/subscription/status')
              .catch(() => null);
            return {
              options: llm.subscriptionOptions,
              cli: cli?.cli ?? { installed: false, signedIn: false, detail: 'Not available on this build.' },
            } satisfies SubscriptionInfo;
          } catch {
            return null;
          }
        }}
        submitLabel={busy ? 'Saving and testing…' : 'Save & test'}
        onSubmit={async (body) => {
          setBusy(true);
          onBusyChange(true);
          setError('');
          let stored = false;
          try {
            await api.put('/admin/llm/providers/primary', body);
            stored = true;
            const test = await api.post<{ provider: Provider | null; result: { fatal: string | null } }>(
              '/admin/llm/providers/primary/probe', {},
            );
            if (!test.provider?.active) {
              onSaved(false);
              setError(`Saved, but the test did not pass. ${test.result?.fatal ?? 'The model could not respond.'}`);
              return;
            }
            onSaved(true);
          } catch (err) {
            if (stored) onSaved(false);
            const reason = err instanceof Error ? err.message : 'The request could not be completed';
            setError(stored ? `Saved, but the test could not run: ${reason}` : `Could not save: ${reason}`);
          } finally {
            setBusy(false);
            onBusyChange(false);
          }
        }}
      />
    </div>
  );
}

function CodexConnection() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [login, setLogin] = useState<DeviceLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = () => api.get<{ cli: CodexStatus }>('/admin/llm/subscription/status')
    .then((r) => setStatus(r.cli));

  useEffect(() => { void loadStatus().catch(() => undefined); }, []);
  useEffect(() => {
    if (login?.state !== 'starting' && login?.state !== 'awaiting_approval') return;
    const timer = setInterval(() => {
      void api.get<DeviceLoginState>('/admin/llm/subscription/login').then((next) => {
        setLogin(next);
        if (next.state === 'signed_in') void loadStatus();
      }).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [login?.state]);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      setLogin(await api.post<DeviceLoginState>('/admin/llm/subscription/login', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT sign-in could not be started');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api.post('/admin/llm/subscription/logout', {});
      setLogin(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT could not be disconnected');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="text-sm text-muted-foreground">Checking Codex…</p>;
  if (!status.installed) return <ErrorNote>{status.detail}</ErrorNote>;

  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      <p className="text-sm font-medium">
        {status.signedIn ? 'Connected to your ChatGPT plan' : 'Not connected to ChatGPT'}
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {login?.challenge ? (
        <>
          <p className="text-sm">
            Open <a className="underline" href={login.challenge.verificationUrl} target="_blank" rel="noreferrer">
              {login.challenge.verificationUrl}
            </a>, sign in, then enter this code:
          </p>
          <Copyable label="One-time code" value={login.challenge.userCode} />
          <p className="text-xs text-muted-foreground">Waiting for approval. This page updates automatically.</p>
        </>
      ) : status.signedIn ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void disconnect()}>
          {busy ? 'Disconnecting…' : 'Disconnect ChatGPT'}
        </Button>
      ) : (
        <Button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Starting…' : 'Connect ChatGPT'}
        </Button>
      )}
      {login?.state === 'failed' ? <ErrorNote>{login.message ?? 'Sign-in failed.'}</ErrorNote> : null}
    </div>
  );
}
