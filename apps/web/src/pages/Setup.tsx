// The first-run wizard.
//
// Phase 3 built the state machine and deliberately left the screens to this
// phase. The important property carried over: **the client never chooses which
// step it is on.** This reads `nextStep` from the server and renders that one.
// Submitting an out-of-order step is refused with 409 whatever this page does,
// so the wizard cannot be walked around by editing a URL or a variable in a
// console.
//
// Secrets typed here — the model API key, the SMTP password — go straight to
// the server and are sealed with the installation master key before they touch
// PostgreSQL. Nothing is kept in component state after the step is submitted.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, clearSetupHandoff, primeCsrf } from '@/lib/api';
import {
  ProviderForm, type ProviderCatalogEntry, type SubscriptionInfo,
} from '@/components/ProviderForm';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { LegalLinks } from '@/components/LegalLinks';

/** The outcome of a real attempt to use something that was configured. */
interface Verification {
  status: 'passed' | 'failed' | 'skipped';
  category?: string | null;
  detail?: string | null;
  target?: string | null;
}

type ReviewStatus =
  | 'configured_and_tested' | 'configured_but_failed' | 'skipped' | 'unavailable' | 'required';

interface ReviewItem {
  key: string;
  label: string;
  required: boolean;
  status: ReviewStatus;
  statusLabel: string;
  blocking: boolean;
  verification: Verification | null;
  unavailableReason?: string | null;
}

interface Review {
  items: ReviewItem[];
  canComplete: boolean;
  headline: string;
  summary?: {
    llm?: { probeSteps?: Array<{ id: string; label: string; passed: boolean; detail: string }> };
    smtp?: Array<{
      kind: string; host: string | null; port: number | null; security: string | null;
      username: string | null; passwordSet: boolean | null; fromName: string | null;
      fromAddress: string | null;
    }>;
  };
}

/** Which setup step an item is fixed on, so "Edit" can go somewhere. */
const ITEM_STEP: Record<string, string> = {
  llm: 'llm',
  smtp: 'smtp',
};

const STATUS_TONE: Record<ReviewStatus, string> = {
  configured_and_tested: 'text-emerald-600 dark:text-emerald-400',
  configured_but_failed: 'text-red-600 dark:text-red-400',
  skipped: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
  required: 'text-amber-600 dark:text-amber-400',
};

interface StepDescriptor {
  id: string;
  title: string;
  summary: string;
  skippable: boolean;
  done: boolean;
}

interface SetupState {
  completed: boolean;
  completedSteps: string[];
  nextStep: string | null;
  steps: StepDescriptor[];
  /** Sent with the state rather than fetched by the model step, so the wizard
   * cannot offer a provider this build would refuse to save. */
  providerCatalog: ProviderCatalogEntry[];
}

interface HostCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  label: string;
  mandatory: boolean;
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [review, setReview] = useState<Review | null>(null);
  /** A completed step the operator has chosen to redo from the review screen. */
  const [revising, setRevising] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.get<SetupState>('/setup/state');
    setState(next);
    if (next.completed) { clearSetupHandoff(); onDone(); return; }
    // Only once there is something to summarise. Before the model step there
    // is nothing to say, and an empty summary reads like a broken one.
    if (next.completedSteps.includes('llm')) {
      setReview(await api.get<Review>('/setup/review').catch(() => null as never));
    }
  }, [onDone]);

  async function retest(item: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/setup/verify/${item}`, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That test could not be run');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void primeCsrf().then(load).catch(() => setError('Could not reach the server')); }, [load]);

  async function submit(step: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const result=await api.post<{vaultRecovery?:{key:string;fingerprint:string}}>(`/setup/steps/${step}`, body);
      if(result.vaultRecovery)setVaultRecovery(result.vaultRecovery);
      if (step === 'llm') {
        await api.post('/setup/verify/llm', {});
      }
      setRevising(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That step could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const [vaultRecovery, setVaultRecovery] = useState<{key:string;fingerprint:string}|null>(null);
  async function finish() {
    setBusy(true);
    setError('');
    try {
      await api.post('/setup/complete');
      clearSetupHandoff();
      onDone();
    } catch (err) {
      // The server refuses while anything required is failing and says which.
      // Reloading brings the summary into line with that answer, so the reason
      // is on screen rather than only in the error line.
      setError(err instanceof ApiError ? err.message : 'Setup could not be completed');
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <div className="p-6 text-sm text-muted-foreground">{error || 'Loading…'}</div>;
  }
  if(vaultRecovery)return <RecoveryKeyStep recovery={vaultRecovery} onConfirmed={()=>setVaultRecovery(null)} onError={setError}/>;

  const current = state.steps.find((s) => s.id === state.nextStep);
  const revisingStep = revising ? state.steps.find((s) => s.id === revising) : undefined;
  const position = state.completedSteps.length + 1;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl p-5 text-[1.02rem] sm:p-8">
      <div className="mb-6 flex flex-col items-center text-center">
        <img src="/brand/josi-wordmark.png" alt="Josi" width={200} height={93}
             className="mb-2 h-auto w-40 max-w-full" />
        <p className="text-sm text-muted-foreground">Setting up this installation</p>
      </div>

      {/* Progress, from the server's view of what is done — not from a counter
          this page keeps. */}
      <ol className="mb-4 flex flex-wrap gap-1" aria-label="Setup progress">
        {state.steps.map((s) => (
          <li
            key={s.id}
            className={`h-1.5 min-w-6 flex-1 rounded-full ${s.done ? 'bg-primary' : 'bg-secondary'}`}
            title={s.title}
          />
        ))}
      </ol>

      {error ? <div className="mb-3"><ErrorNote>{error}</ErrorNote></div> : null}

      {revisingStep ? (
        <Card>
          <CardTitle>{revisingStep.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            {revisingStep.summary} Saving this replaces what is stored and tests it again.
          </p>
          <StepForm step={revisingStep.id} busy={busy} catalog={state.providerCatalog ?? []}
                    smtpInitial={review?.summary?.smtp?.find((profile) => profile.kind === 'system')}
                    onSubmit={submit} />
          <div className="mt-3">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRevising(null)}>
              Leave it as it is
            </Button>
          </div>
        </Card>
      ) : current ? (
        <Card>
          <p className="mb-1 text-xs text-muted-foreground">Step {position} of {state.steps.length}</p>
          <CardTitle>{current.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">{current.summary}</p>
          <StepForm step={current.id} busy={busy} catalog={state.providerCatalog ?? []} onSubmit={submit} />
        </Card>
      ) : (
        <Card>
          <CardTitle>{review?.canComplete === false ? 'Not ready yet' : 'Ready'}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            {review
              ? review.canComplete
                ? 'Finishing setup is one-way: these screens disappear and the installation starts refusing them.'
                : review.headline
              : 'Finishing setup is one-way: these screens disappear and the installation starts refusing them.'}
          </p>
          {/* Disabled rather than hidden, so the reason stays visible. The
              server refuses it in any case — this is the courtesy, not the
              control. */}
          <Button onClick={() => void finish()} disabled={busy || review?.canComplete === false}>
            {busy ? 'Finishing…' : 'Finish setup'}
          </Button>
        </Card>
      )}

      {review && (!current || current.id === 'review') ? (
        <div className="mt-4">
          <ReviewPanel
            review={review}
            busy={busy}
            onRetest={(item, body) => void retest(item, body)}
            onEdit={(step) => void reopen(step)}
          />
        </div>
      ) : null}
      <p className="mt-5 text-center text-xs text-muted-foreground">
        By finishing setup and using Josi, you agree to the Terms and acknowledge the Privacy and Cookie Notices.
      </p>
      <LegalLinks className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-2 text-xs text-primary [&_a]:underline" />
    </div>
  );

  /** Send the operator back to a step they have already done.
   *
   * Only the three steps that hold configuration for an external service can be
   * revised; the server decides that, not this. Nothing is cleared here — the
   * step's own form is shown again, and submitting it overwrites and re-tests.
   */
  async function reopen(step: string) {
    setError('');
    setRevising(step);
  }
}

function StepForm({
  step, busy, catalog, smtpInitial, onSubmit,
}: {
  step: string; busy: boolean; catalog: ProviderCatalogEntry[];
  smtpInitial?: {
    host: string | null; port: number | null; security: string | null; username: string | null;
    passwordSet: boolean | null; fromName: string | null; fromAddress: string | null;
  };
  onSubmit: (step: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [checks, setChecks] = useState<HostCheck[] | null>(null);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [smtpUsername, setSmtpUsername] = useState(smtpInitial?.username ?? '');
  const [smtpFromAddress, setSmtpFromAddress] = useState(smtpInitial?.fromAddress ?? '');
  const [smtpFromOverridden, setSmtpFromOverridden] = useState(
    !!smtpInitial?.fromAddress && smtpInitial.fromAddress !== smtpInitial.username,
  );

  useEffect(() => {
    setSmtpUsername(smtpInitial?.username ?? '');
    setSmtpFromAddress(smtpInitial?.fromAddress ?? smtpInitial?.username ?? '');
    setSmtpFromOverridden(!!smtpInitial?.fromAddress && smtpInitial.fromAddress !== smtpInitial.username);
  }, [smtpInitial]);

  useEffect(() => {
    if (step !== 'host_checks') return;
    void api.get<{ checks: HostCheck[] }>('/setup/host-checks').then((r) => setChecks(r.checks)).catch(() => undefined);
  }, [step]);

  function handle(event: React.FormEvent<HTMLFormElement>, build: (f: FormData) => Record<string, unknown>) {
    event.preventDefault();
    void onSubmit(step, build(new FormData(event.currentTarget)));
  }

  switch (step) {
    case 'host_checks':
      return (
        <form onSubmit={(e) => handle(e, () => ({}))} className="space-y-3">
          {checks ? (
            <ul className="space-y-1 text-sm">
              {checks.map((c) => (
                <li key={c.id} className="flex min-w-0 gap-2">
                  <span aria-hidden>{c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'}</span>
                  <span className="min-w-0 break-words">{c.label}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">Checking…</p>}
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'owner':
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            email: f.get('email'), username: f.get('username'),
            displayName: f.get('displayName'), password: f.get('password'),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }))}
          className="space-y-3"
        >
          <Field id="email" label="Email" type="email" required />
          <Field id="username" label="Username" required autoCapitalize="none" />
          <Field id="displayName" label="Your name" />
          <Field id="password" label="Password" type="password" required
                 autoComplete="new-password" minLength={12} />
          <p className="text-xs text-muted-foreground">At least 12 characters. This is the one administrator account.</p>
          <Button type="submit" disabled={busy}>Create account</Button>
        </form>
      );

    case 'domain':
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            domain: f.get('domain'), tlsMode: f.get('tlsMode'), acmeEmail: f.get('acmeEmail'),
          }))}
          className="space-y-3"
        >
          <Field id="domain" name="domain" label="Address" placeholder="josi.example.com or 192.168.1.20" required autoCapitalize="none" autoComplete="url" inputMode="url" />
          <div>
            <label className="mb-1 block text-sm" htmlFor="tlsMode">HTTPS</label>
            <select id="tlsMode" name="tlsMode" defaultValue="bundled_caddy"
                    className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
              <option value="bundled_caddy">Bundled Caddy (HTTPS for a public domain, HTTP on LAN)</option>
              <option value="external_proxy">I run my own reverse proxy</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Public certificates require a domain pointing to this server. A LAN IP works over HTTP and needs no certificate email.
          </p>
          <Field id="acmeEmail" name="acmeEmail" label="Email for certificate notices" type="email" autoComplete="email" />
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'llm':
      return <LlmStep busy={busy} catalog={catalog} onSubmit={onSubmit} />;

    case 'smtp':
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            system: {
              host: f.get('host'), port: Number(f.get('port') || 587), security: f.get('security'),
              username: f.get('username'), password: f.get('password'),
              fromName: f.get('fromName'), fromAddress: f.get('fromAddress'),
            },
            communications: { copyFromSystem: true, fromName: 'Josi', fromAddress: f.get('fromAddress') },
            testTo: f.get('testTo'),
          }))}
          className="space-y-3"
        >
          <Field id="host" label="SMTP server" defaultValue={smtpInitial?.host ?? ''} required autoCapitalize="none" />
          <Field id="port" label="Port" type="number" defaultValue={smtpInitial?.port ?? 587} required />
          <div>
            <label className="mb-1 block text-sm" htmlFor="security">Security</label>
            <select id="security" name="security" defaultValue={smtpInitial?.security ?? 'starttls'}
                    className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </div>
          <Field id="username" label="Username" value={smtpUsername} autoCapitalize="none" autoComplete="username"
                 onChange={(event) => {
                   const next = event.currentTarget.value;
                   if (!smtpFromOverridden) setSmtpFromAddress(next);
                   setSmtpUsername(next);
                 }} />
          <div>
            <label className="mb-1 block text-sm" htmlFor="password">Password</label>
            <Input id="password" name="password" type={showSmtpPassword ? 'text' : 'password'}
                   autoComplete="new-password" required={!smtpInitial?.passwordSet}
                   placeholder={smtpInitial?.passwordSet ? 'Leave blank to keep saved password' : undefined} />
            <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={showSmtpPassword}
                     onChange={(event) => setShowSmtpPassword(event.target.checked)} />
              Show password
            </label>
          </div>
          <Field id="fromName" label="From name" defaultValue={smtpInitial?.fromName ?? 'Josi'} required />
          <Field id="fromAddress" label="From address" type="email" value={smtpFromAddress} required autoComplete="email"
                 onChange={(event) => {
                   setSmtpFromAddress(event.currentTarget.value);
                   setSmtpFromOverridden(event.currentTarget.value !== smtpUsername);
                 }} />
          <p className="text-xs text-muted-foreground">
            Defaults to the Username. Change it only for an approved alias or shared mailbox.
          </p>
          <Field id="testTo" label="Send a test message to" type="email" required
                 placeholder="you@example.com" />
          <p className="text-xs text-muted-foreground">
            Josi will send one message to that address now. Configuring mail without sending one would
            mean reporting it as working on the strength of the fields being filled in. Your password is
            encrypted with this installation's master key before it is stored, and is kept even if the
            send fails, so fixing a setting does not mean typing it again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Testing…' : 'Save and test'}</Button>
            <Button type="button" variant="secondary" disabled={busy}
                    onClick={() => void onSubmit('smtp', { skip: true })}>
              Skip for now
            </Button>
          </div>
        </form>
      );

    case 'security':
      return (
        <form onSubmit={(e) => handle(e, (f) => ({ folderMappingEnabled: f.get('folders') === 'on' }))} className="space-y-3">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="folders" defaultChecked className="h-5 w-5" />
            Let people map folders for Josi to read
          </label>
          <p className="text-xs text-muted-foreground">
            You can turn this off later. Folder access is deny-by-default and each person still has to
            consent to their own folders.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'telemetry':
      return (
        <form onSubmit={(e) => handle(e, (f) => ({ enabled: f.get('telemetry') === 'on' }))} className="space-y-3">
          {/* Unchecked. Telemetry is off unless someone affirmatively turns it
              on — a pre-ticked box is not consent. */}
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" name="telemetry" className="mt-3 h-5 w-5" />
            <span>Send anonymous usage counts to help improve Josi</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Version, which features are switched on, and error counts. Never prompts, messages, email,
            contacts, calendar entries, credentials, or anything identifying your business. Off unless you
            tick it.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'review':
      return (
        <form onSubmit={(e) => handle(e, () => ({}))} className="space-y-3">
          {/* The summary itself is rendered by ReviewPanel, below the wizard
              card, because it is also what the Finish screen shows. This step
              is just the acknowledgement that you have read it. */}
          <p className="text-sm text-muted-foreground">
            Check the summary below, then continue.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    default:
      return <p className="text-sm text-muted-foreground">Unknown step.</p>;
  }
}

/** The model step: the shared provider form, pointed at the wizard's
 * endpoints. The form itself lives in components/ProviderForm.tsx so the admin
 * Model page offers exactly the same choices after installation. */
function LlmStep({
  busy, catalog, onSubmit,
}: {
  busy: boolean; catalog: ProviderCatalogEntry[];
  onSubmit: (step: string, body: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <ProviderForm
      busy={busy}
      catalog={catalog}
      paths={{
        models: '/setup/models',
        codexBase: '/setup/subscription',
        claudeBase: '/setup/subscription/claude',
      }}
      loadSubscriptionInfo={() => api.get<SubscriptionInfo>('/setup/subscription').catch(() => null)}
      onSubmit={(body) => onSubmit('llm', body)}
      submitLabel="Save and run the five-part test"
    />
  );
}

function RecoveryKeyStep({
  recovery, onConfirmed, onError,
}: {
  recovery: { key: string; fingerprint: string };
  onConfirmed: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const suffix = recovery.key.slice(-4);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recovery.key);
      setCopied(true);
    } catch {
      onError('The browser could not copy the recovery key. Use Download instead.');
    }
  }

  function download() {
    const blob = new Blob([
      `Josi Vault recovery key\n\n${recovery.key}\n\nFingerprint: ${recovery.fingerprint}\n`,
    ], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `josi-vault-recovery-${recovery.fingerprint}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="mx-auto max-w-3xl p-5 sm:p-8"><Card>
    <CardTitle>Save your Vault recovery key</CardTitle>
    <p className="mt-2 text-sm text-muted-foreground">This is the only copy Josi will provide. Store it offline. Losing both this key and the server&rsquo;s Master Vault key makes encrypted credentials permanently unrecoverable.</p>
    <div className="my-5 rounded-md border border-border bg-background p-4 font-mono text-base" aria-label={`Recovery key ending in ${suffix}`}>
      <span aria-hidden>•••• •••• •••• •••• •••• •••• •••• {suffix}</span>
    </div>
    <p className="text-xs text-muted-foreground">Fingerprint: {recovery.fingerprint}</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <Button type="button" variant="secondary" onClick={()=>void copy()}>{copied ? 'Copied' : 'Copy key'}</Button>
      <Button type="button" variant="secondary" onClick={download}>Download key</Button>
    </div>
    <Button className="mt-4" onClick={()=>void api.post('/setup/vault-recovery-confirmed').then(onConfirmed).catch(e=>onError(e instanceof Error?e.message:'Could not confirm the recovery key'))}>I saved it — continue setup</Button>
  </Card></div>;
}

/** Everything setup decided, and what was actually established about each.
 *
 * The screen this replaces said "Everything is configured. Nothing here has
 * been tested against a live service yet" — two sentences that cannot both be
 * a summary of the same installation. Both the headline and the rows come from
 * one server response now, so they cannot disagree.
 */
function ReviewPanel({
  review, busy, onRetest, onEdit,
}: {
  review: Review;
  busy: boolean;
  onRetest: (item: string, body?: Record<string, unknown>) => void;
  onEdit: (step: string) => void;
}) {
  const [smtpTestTo, setSmtpTestTo] = useState<string | null>(null);

  return (
    <Card>
      <CardTitle>What is set up</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">{review.headline}</p>
      <ul className="space-y-3">
        {review.items.map((item) => (
          <li key={item.key} className="border-t border-input pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              <span className={`text-xs font-medium ${STATUS_TONE[item.status]}`}>
                {item.statusLabel}
              </span>
            </div>

            {item.verification?.detail ? (
              <p className="mt-1 text-xs text-muted-foreground">{item.verification.detail}</p>
            ) : null}
            {item.unavailableReason ? (
              <p className="mt-1 text-xs text-muted-foreground">{item.unavailableReason}</p>
            ) : null}
            {item.key === 'llm' && review.summary?.llm?.probeSteps?.length ? (
              <ul className="mt-2 space-y-1 text-xs" aria-label="Model capability test results">
                {review.summary.llm.probeSteps.map((step) => (
                  <li key={step.id} className="flex gap-2">
                    <span className={step.passed ? 'text-emerald-500' : 'text-amber-500'} aria-hidden>
                      {step.passed ? '✓' : '—'}
                    </span>
                    <span><strong>{step.label}:</strong> {step.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {item.key === 'smtp' && (
              item.status === 'configured_but_failed'
              || item.status === 'configured_and_tested'
              || (item.status === 'required' && !item.verification)
            ) ? (
              <div className="mt-2 max-w-sm">
                <Field
                  id="smtpRetestTo"
                  label="Send test message to"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={smtpTestTo ?? item.verification?.target ?? ''}
                  onChange={(event) => setSmtpTestTo(event.currentTarget.value)}
                />
              </div>
            ) : null}
            {item.status === 'required' && !item.verification ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {item.blocking
                  ? 'This has to be working before setup can finish.'
                  : 'Nothing has been tested for this yet.'}
              </p>
            ) : null}

            {item.status !== 'unavailable' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {ITEM_STEP[item.key] ? (
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => onEdit(ITEM_STEP[item.key])}>
                    Change
                  </Button>
                ) : null}
                {item.status === 'configured_but_failed' || item.status === 'configured_and_tested' ? (
                  <Button type="button" variant="secondary"
                          disabled={busy || (item.key === 'smtp'
                            && !(smtpTestTo ?? item.verification?.target ?? '').includes('@'))}
                          onClick={() => onRetest(item.key, item.key === 'smtp'
                            ? { to: smtpTestTo ?? item.verification?.target ?? '' }
                            : {})}>
                    Test again
                  </Button>
                ) : null}
                {/* A required item that has never been tested needs a way to BE
                    tested. Offering only "Change" here was a dead end: the
                    server refuses to finish until a test passes, and the screen
                    provided no way to run one. */}
                {item.status === 'required' && !item.verification && ITEM_STEP[item.key] ? (
                  <Button type="button" disabled={busy || (item.key === 'smtp' && !(smtpTestTo ?? '').includes('@'))}
                          onClick={() => onRetest(item.key, item.key === 'smtp' ? { to: smtpTestTo ?? '' } : {})}>
                    Test
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Field({
  id, label, ...props
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="mb-1 block text-sm" htmlFor={id}>{label}</label>
      <Input id={id} name={id} {...props} />
    </div>
  );
}
