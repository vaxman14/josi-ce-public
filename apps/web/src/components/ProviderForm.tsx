// Choosing a model provider — the ONE form, wherever it is shown.
//
// This is the setup wizard's model step, extracted so the admin Model page can
// offer exactly the same choices after installation. It used to exist only in
// the wizard, which made the first choice a trap: once a subscription (CLI)
// provider was active, the admin page offered no way back to a self-hosted
// endpoint or an API-key provider. Every provider type is switchable in every
// direction, any time — the same component, pointed at different endpoints.
//
// There is no catalogue of model names here. The credential is entered first
// and the provider is asked what it will honour; see the wizard's history for
// why (`gpt-5.6-luna` was once offered to accounts that had no such model).
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ClaudeSignIn } from '@/components/ClaudeSignIn';
import { Button, Copyable, ErrorNote, Input } from '@/components/ui';

/** A model the provider said this account may use. Never a list of ours. */
export interface DiscoveredModel {
  id: string;
  label: string;
  recommended: boolean;
  likelyNonChat: boolean;
}

export interface SubscriptionOption {
  id: string;
  label: string;
  available: boolean;
  provider: string | null;
  reason: string;
}

export interface SubscriptionInfo {
  options: SubscriptionOption[];
  cli: { installed: boolean; signedIn: boolean; detail: string };
}

export interface DeviceLoginState {
  state: 'idle' | 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string; userCode: string } | null;
  expiresAt: string | null;
  message: string | null;
}

export interface ProviderFormPaths {
  /** POST — model discovery for a credential that has not been stored yet. */
  models: string;
  /** Codex device-flow base: `${codexBase}/login` etc. */
  codexBase: string;
  /** Claude sign-in base, handed to ClaudeSignIn. */
  claudeBase: string;
}

/** One provider as the server describes it.
 *
 * The form renders from this and knows nothing else about any provider: which
 * exist, what each is called, which fields it takes and whether it has an
 * endpoint of its own are all the catalogue's answers. That is the point — a
 * provider added to the server appears here without this file changing, and a
 * provider the build gates away never appears at all. */
export interface ProviderCatalogEntry {
  kind: string;
  label: string;
  external: boolean;
  baseUrlMode: 'none' | 'optional' | 'required';
  defaultBaseUrl: string | null;
  fields: Array<{
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    placeholder: string | null;
    help: string | null;
  }>;
  discovery: string;
  modelNoun: string;
  residency: string;
  docsUrl: string;
}

export interface ProviderFormProps {
  busy: boolean;
  compact?: boolean;
  initialProvider?: string;
  /** Every provider this build will actually accept, in the order it sent
   * them. Empty until the page's own fetch resolves. */
  catalog: ProviderCatalogEntry[];
  paths: ProviderFormPaths;
  /** What subscriptions are on offer here, and the CLI's state. Null when the
   * build has none (hosted) or the endpoint is unavailable. */
  loadSubscriptionInfo: () => Promise<SubscriptionInfo | null>;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
}

export function ProviderForm({
  busy, compact = false, catalog, paths, loadSubscriptionInfo, onSubmit, submitLabel, initialProvider, onCancel,
}: ProviderFormProps) {
  const [provider, setProvider] = useState(initialProvider ?? 'openai_compatible');
  /** Every credential field the chosen provider takes, keyed by the catalogue's
   * own field key. One bag rather than a variable per field: which fields exist
   * is the server's answer, so this component cannot enumerate them. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [discovery, setDiscovery] = useState<
    { message: string; unsupported: boolean; fromCatalog: boolean; catalogVersion: string | null } | null
  >(null);
  const [looking, setLooking] = useState(false);
  const [chosen, setChosen] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const discoveryScope = JSON.stringify([provider, baseUrl, values]);
  const currentScope = useRef(discoveryScope);
  currentScope.current = discoveryScope;
  const discoveryRequest = useRef(0);

  const entry = catalog.find((c) => c.kind === provider) ?? null;
  const external = entry ? entry.external : provider !== 'openai_compatible';
  const isSubscription = provider === 'openai_subscription' || provider === 'anthropic_subscription';
  const modelNoun = entry?.modelNoun ?? 'model';
  const fields = entry?.fields ?? [];

  // Only a build whose edition permits it answers this at all. A hosted build
  // 404s and the option never appears — the outermost of four layers, not the
  // control.
  useEffect(() => {
    let cancelled = false;
    void loadSubscriptionInfo().then((info) => { if (!cancelled) setSubscription(info); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching provider clears the credential rather than carrying it across. An
  // AWS secret access key is not a Cohere key, and a field left populated from
  // the previous choice would be sent to the new provider.
  useEffect(() => {
    setValues({});
    setBaseUrl('');
  }, [provider]);

  // Anything that changes which account we are asking invalidates the answer.
  useEffect(() => {
    discoveryRequest.current += 1;
    setModels(null); setDiscovery(null); setChosen(''); setManualModel(''); setLooking(false);
  }, [provider, values, baseUrl]);
  useEffect(() => { if (initialProvider) setProvider(initialProvider); }, [initialProvider]);

  const setField = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  /** Everything the provider needs before it is worth asking it anything. */
  const missingRequired = fields.filter((f) => f.required && !(values[f.key] ?? '').trim());
  const needsBaseUrl = entry?.baseUrlMode === 'required' && !baseUrl.trim();
  const canDiscover = provider === 'openai_subscription'
    || (!isSubscription && !missingRequired.length && !needsBaseUrl);

  /** The credential and settings as the routes read them: every catalogue field
   * by its own key, alongside the provider and endpoint. */
  const credentialBody = () => {
    const out: Record<string, unknown> = { provider, baseUrl };
    for (const f of fields) {
      const value = (values[f.key] ?? '').trim();
      if (value) out[f.key] = value;
    }
    return out;
  };

  async function findModels() {
    const request = ++discoveryRequest.current;
    const scope = discoveryScope;
    const stale = () => discoveryRequest.current !== request || currentScope.current !== scope;
    setLooking(true);
    setDiscovery(null);
    try {
      const r = await api.post<{
        ok: boolean; unsupported: boolean; models: DiscoveredModel[]; message: string | null;
        fromCatalog?: boolean; catalogVersion?: string | null;
      }>(paths.models, credentialBody());
      if (stale()) return;
      setModels(r.models);
      if (provider === 'openai_subscription') {
        // Listing candidates must never silently replace Automatic with one.
        setChosen(current => r.models.some(m => m.id === current) ? current : '');
      } else {
        setChosen(r.models.find((m) => m.recommended)?.id ?? r.models.find((m) => !m.likelyNonChat)?.id ?? '');
      }
      if (r.message) {
        setDiscovery({
          message: r.message,
          unsupported: r.unsupported,
          fromCatalog: !!r.fromCatalog,
          catalogVersion: r.catalogVersion ?? null,
        });
      }
    } catch (err) {
      if (stale()) return;
      setModels([]);
      setDiscovery({
        message: err instanceof ApiError ? err.message : 'The provider could not be reached.',
        unsupported: false,
        fromCatalog: false,
        catalogVersion: null,
      });
    } finally {
      if (!stale()) setLooking(false);
    }
  }

  // The CLI is already signed in on most returning installs. Populate its
  // choices as soon as ChatGPT is selected; keep Automatic selected until the
  // operator explicitly chooses a model. The button remains a retry control.
  useEffect(() => {
    if (provider === 'openai_subscription' && subscription?.cli.signedIn) void findModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, subscription?.cli.signedIn]);

  const usable = (models ?? []).filter((m) => showAll || !m.likelyNonChat);
  // A provider whose list Josi ships rather than reads can always be given a
  // name the catalogue does not carry — a model released after this build.
  const allowsTypedModel = provider !== 'openai_subscription'
    && !!models && (discovery?.fromCatalog || (discovery?.unsupported && !external));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        void onSubmit({
          ...credentialBody(),
          model: manualModel.trim() || chosen || '',
          externalAcknowledged: f.get('ack') === 'on',
        });
      }}
      className="space-y-3"
    >
      <div>
        <label className="mb-1 block text-sm" htmlFor="provider">Provider</label>
        <select
          id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
        >
          {/* Drawn from the catalogue the server sent. A hardcoded list here is
              how the installer came to offer five providers while the server
              accepted twenty — and how a provider gated behind an edition
              capability could be selected on a build that would refuse it. */}
          {catalog.map((c) => (
            <option key={c.kind} value={c.kind}>{c.label}</option>
          ))}
        </select>
        {!compact && entry?.residency ? (
          <p className="mt-1 text-xs text-muted-foreground">{entry.residency}</p>
        ) : null}
      </div>

      {/* Every subscription option, including the ones that are not on offer,
          with the actual reason. "Coming soon" would be a guess; these are
          policies, and they are current. */}
      {!compact && subscription?.options.some((o) => !o.available) ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Can I use a subscription I already pay for?</summary>
          <ul className="mt-1 space-y-2">
            {subscription.options.map((o) => (
              <li key={o.id}>
                <span className="font-medium">{o.label}</span>
                {o.available ? ' — available' : ' — not available'}
                <p className="mt-0.5">{o.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Two different flows, and the component matches the CLI rather than
          the other way round: ChatGPT's polls itself, Claude's needs a code
          pasted back. */}
      {provider === 'openai_subscription'
        ? <SubscriptionSignIn compact={compact} info={subscription} loginPath={`${paths.codexBase}/login`}
            onSignedIn={() => setSubscription((info) => info ? { ...info, cli: { ...info.cli, signedIn: true } } : info)} /> : null}
      {provider === 'anthropic_subscription' ? <ClaudeSignIn basePath={paths.claudeBase} /> : null}

      {!isSubscription && entry && entry.baseUrlMode !== 'none' ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="baseUrl">
            {entry.external ? 'Endpoint address' : 'Address of your model server'}
            {entry.baseUrlMode === 'optional' ? ' (optional)' : ''}
          </label>
          <Input
            id="baseUrl" name="baseUrl" value={baseUrl} autoCapitalize="none"
            required={entry.baseUrlMode === 'required'}
            placeholder={entry.defaultBaseUrl ?? 'http://ollama:11434/v1'}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          {entry.baseUrlMode === 'optional' && entry.defaultBaseUrl ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Leave empty to use {entry.defaultBaseUrl}.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* No credential on the subscription path, and not merely hidden: the
          server refuses one. A key there would bill an API account while the
          product called it a subscription. */}
      {!isSubscription ? fields.map((f) => (
        <div key={f.key}>
          <label className="mb-1 block text-sm" htmlFor={`field-${f.key}`}>
            {f.label}{f.required ? '' : ' (optional)'}
          </label>
          <Input
            id={`field-${f.key}`}
            name={f.key}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            autoCapitalize="none"
            required={f.required}
            placeholder={f.placeholder ?? undefined}
            value={values[f.key] ?? ''}
            onChange={(e) => setField(f.key, e.target.value)}
          />
          {f.help ? <p className="mt-1 text-xs text-muted-foreground">{f.help}</p> : null}
        </div>
      )) : null}

      {provider !== 'anthropic_subscription' && provider !== 'openai_subscription' ? <div>
        <Button type="button" variant="secondary" disabled={busy || looking || !canDiscover}
                onClick={() => void findModels()}>
          {looking ? 'Asking…' : models ? 'Look again' : `Show me my ${modelNoun}s`}
        </Button>
        {!canDiscover ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {needsBaseUrl
              ? 'Enter your endpoint address first.'
              : `Enter your ${missingRequired.map((f) => f.label.toLowerCase()).join(' and ')} first.`}
          </p>
        ) : null}
      </div> : null}

      {provider === 'openai_subscription' && models && !models.length && !looking ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void findModels()}>
          Retry model list
        </Button>
      ) : null}

      {discovery && (provider !== 'openai_subscription' || !models?.length) ? (
        <p className="text-sm text-muted-foreground">{discovery.message}</p>
      ) : null}

      {provider === 'openai_subscription' ? (
        <div className="space-y-2">
          <fieldset role="radiogroup" aria-label="ChatGPT model">
            <legend className="mb-2 text-sm font-medium">Model</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {[{ id: '', label: 'Automatic (Codex chooses)' }, ...usable].map((m) => (
                <label key={m.id || 'automatic'} className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-sm ${
                  chosen === m.id && !manualModel ? 'border-primary bg-primary/10' : 'border-input hover:bg-muted/50'
                }`}>
                  <input type="radio" name="chatgptChoice" value={m.id} checked={chosen === m.id && !manualModel}
                         onChange={() => { setChosen(m.id); setManualModel(''); }} />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {looking ? <p className="text-sm text-muted-foreground">Loading models…</p> : null}
          {models?.length ? <p className="text-xs text-muted-foreground">
            Codex lists these models; Save &amp; test confirms the one you choose works with your plan.
          </p> : null}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Enter an exact ChatGPT model ID (advanced)</summary>
            <label className="mt-2 block text-sm" htmlFor="manualModel">Exact ChatGPT model ID (optional)</label>
            <Input id="manualModel" name="manualModel" autoCapitalize="none" value={manualModel}
                   onChange={(e) => { setManualModel(e.target.value); if (e.target.value) setChosen(''); }} />
          </details>
        </div>
      ) : null}

      {provider !== 'openai_subscription' && models && usable.length ? (
        <div>
          <label className="mb-1 block text-sm capitalize" htmlFor="model">{modelNoun}</label>
          <select
            id="model" value={chosen} onChange={(e) => { setChosen(e.target.value); setManualModel(''); }}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          >
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}{m.recommended ? ' — suggested' : ''}{m.likelyNonChat ? ' (not a chat model)' : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            {discovery?.fromCatalog
              ? `These are the ${modelNoun}s Josi ships knowing about${
                discovery.catalogVersion ? ` (list of ${discovery.catalogVersion})` : ''
              }. Josi will send one real message to the one you pick before it counts as working.`
              : `These are the ${modelNoun}s your account can use. Josi will send one real message to the one you pick before it counts as working.`}
          </p>

          {/* LB12.2: the exact identifier is what a support conversation needs
              and what nobody should have to read to get through setup. */}
          <div className="mt-2 space-y-1">
            <button type="button" className="text-xs underline" onClick={() => setShowIds((v) => !v)}>
              {showIds ? 'Hide technical details' : 'Show technical details'}
            </button>
            {showIds ? (
              <p className="break-all text-xs text-muted-foreground">
                {modelNoun === 'model' ? 'Model identifier' : 'Deployment name'}: <code>{chosen}</code>
                {entry?.docsUrl ? (
                  <>
                    {' · '}
                    <a className="underline" href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
                      Provider documentation
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {(models ?? []).some((m) => m.likelyNonChat) ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                Also show {modelNoun}s that are probably not for chat
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      {allowsTypedModel ? (
        // Either the endpoint publishes no list, or the list came from Josi's
        // own catalogue — in both cases a name it does not carry may still be
        // right, and in neither case has it been checked yet.
        <div>
          <label className="mb-1 block text-sm" htmlFor="manualModel">
            {usable.length ? `Or type a ${modelNoun} name` : `${modelNoun} name on your server`}
          </label>
          <Input id="manualModel" name="manualModel" required={!usable.length} autoCapitalize="none"
                 value={manualModel} onChange={(e) => setManualModel(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">
            This cannot be checked against a list before it is saved. Josi will still send a real
            message to it before treating it as working.
          </p>
        </div>
      ) : null}

      {/* M89. Not pre-ticked, and the server refuses the step without it. */}
      {external ? (
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" name="ack" required className="mt-3 h-5 w-5" />
          <span>
            I understand that the data needed for each request leaves this server and is processed under
            this provider's terms.
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          A model on your own hardware. Nothing leaves this server for it.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel ? <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" disabled={busy || (!models && !isSubscription)}>
          {submitLabel ?? 'Continue'}
        </Button>
      </div>
    </form>
  );
}

/** Signing the container's Codex CLI in, using the CLI's own device flow.
 *
 * The operator never types a credential here and Josi never receives one. The
 * CLI prints a link and a one-time code, they approve it in their own browser,
 * and the CLI stores its own login in its own home directory — a dedicated
 * volume, so replacing the container does not sign them out.
 */
function SubscriptionSignIn({ info, loginPath, compact, onSignedIn }: {
  info: SubscriptionInfo | null; loginPath: string; compact: boolean; onSignedIn: () => void;
}) {
  const [login, setLogin] = useState<DeviceLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signedIn, setSignedIn] = useState(info?.cli.signedIn ?? false);

  useEffect(() => { setSignedIn(info?.cli.signedIn ?? false); }, [info?.cli.signedIn]);

  // Poll while the operator is off approving it. Stops as soon as the CLI has
  // decided either way, so a finished login does not keep asking.
  useEffect(() => {
    if (login?.state !== 'awaiting_approval' && login?.state !== 'starting') return;
    const timer = setInterval(() => {
      void api.get<DeviceLoginState>(loginPath)
        .then((next) => {
          setLogin(next);
          if (next.state === 'signed_in') { setSignedIn(true); onSignedIn(); }
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [login?.state, loginPath, onSignedIn]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setLogin(await api.post<DeviceLoginState>(loginPath, {}));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in could not be started');
    } finally {
      setBusy(false);
    }
  }

  if (!info?.cli.installed) {
    return (
      <ErrorNote>
        {info?.cli.detail ?? 'The Codex CLI is not available in this installation.'}
      </ErrorNote>
    );
  }

  if (signedIn) {
    if (compact) return <p className="text-sm text-emerald-400">✓ Connected to ChatGPT</p>;
    return (
      <div className="rounded-md border border-input p-3">
        <p className="text-sm">Signed in to your ChatGPT plan.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Josi will send one real message before treating this as working. Everyone on this
          installation shares your plan and its limits, no cost is reported, and tools work once the
          model test confirms them.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {login?.challenge ? (
        <>
          <p className="text-sm">
            1. Open <a href={login.challenge.verificationUrl} target="_blank" rel="noreferrer"
                       className="underline">{login.challenge.verificationUrl}</a> and sign in.
          </p>
          <p className="text-sm">2. Enter this code:</p>
          <Copyable label="One-time code" value={login.challenge.userCode} />
          <p className="text-xs text-muted-foreground">
            Waiting for you to approve it. This page notices by itself.
            {login.expiresAt ? ' The code expires shortly; start again for a fresh one.' : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Only continue if you started this here. If somebody sent you this code, stop.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            You will get a link and a one-time code to approve in your own browser. Josi never sees
            your password and never stores your login — OpenAI's own CLI keeps it, on this server.
          </p>
          <Button type="button" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Sign in with ChatGPT'}
          </Button>
        </>
      )}

      {login?.state === 'failed' ? <ErrorNote>{login.message}</ErrorNote> : null}
    </div>
  );
}
