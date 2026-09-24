import { useUnsavedChanges } from '@/lib/useUnsavedChanges';
// Connected accounts.
//
// Phase 6 shipped this page saying plainly that connecting was not available.
// Phase 7 makes it real, and the honesty rule still applies: nothing here is
// pressable unless it works. If an administrator has not registered the
// installation's own OAuth application, the page says so instead of offering a
// Connect button that would fail at the provider.
//
// Every write capability shows what it permits before it can be switched on.
// A toggle labelled only "Send email" is not consent.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote, Input, NotYet } from '@/components/ui';
import { CloudFolders } from '@/components/CloudFolders';
import { plain } from '@/lib/plainLanguage';

interface Capability {
  key: string;
  label: string;
  kind: 'read' | 'write';
  consequence?: string;
  state: 'needs_consent' | 'blocked_by_admin' | 'off' | 'on';
  needsConsent: boolean;
  adminNote: string | null;
}

type Provider = 'google' | 'microsoft' | 'dropbox' | 'box' | 'nextcloud';
const OAUTH_PROVIDERS: Provider[] = ['google', 'microsoft', 'dropbox', 'box'];

interface ProviderView {
  provider: Provider;
  available: boolean;
  connection: {
    id: string;
    account: string | null;
    status: string;
    lastCheckAt: string | null;
    lastCheckOk: boolean | null;
    errorCategory: string | null;
    /** Nextcloud only: the server address its owner typed. Null for every
     * OAuth provider. */
    serverUrl?: string | null;
    capabilities?: Capability[];
    needsPermissionUpgrade?: boolean;
  } | null;
  connections?: Array<NonNullable<ProviderView['connection']>>;
  capabilities: Capability[];
}

const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google', microsoft: 'Microsoft 365', dropbox: 'Dropbox', box: 'Box', nextcloud: 'Nextcloud',
};

const STORAGE_CAPABILITY_KEY: Record<Provider, string> = {
  google: 'google.drive.read',
  microsoft: 'microsoft.files.read',
  dropbox: 'dropbox.files.read',
  box: 'box.files.read',
  nextcloud: 'nextcloud.files.read',
};

/** What each failure means to the person who has to fix it. A raw category is
 * not an explanation. */
const ERROR_TEXT: Record<string, string> = {
  revoked: 'Access was withdrawn at the provider. Reconnect to restore it.',
  expired: 'The stored access expired and could not be renewed. Reconnect.',
  insufficient_scope: 'A permission Josi needs was not granted. Reconnect and approve it.',
  rate_limited: 'The provider is rate limiting us. This usually clears on its own.',
  provider_error: 'The provider returned an error. If it persists, reconnect.',
  network: 'Josi could not reach the provider.',
};

export function Connections() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ providers: ProviderView[] }>('/connections');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your connections');
    }
  }, []);

  useEffect(() => {
    void load();
    // The callback comes back with ?error=… when a handshake was refused.
    const reason = new URLSearchParams(window.location.search).get('error');
    if (reason) setError(handshakeError(reason));
  }, [load]);

  async function connect(provider: string, connectionId?: string) {
    setBusy(provider);
    setError('');
    try {
      const res = await api.post<{ url: string }>(`/connections/${provider}/start`, {
        connectionId, returnPath: '/app/connections',
      });
      // Leaving the app is the point: consent happens at the provider.
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the connection');
      setBusy(null);
    }
  }

  // Nextcloud has no OAuth handshake to leave the page for — the server
  // address, username and app password are submitted directly, verified
  // against the server, and the connection either exists or the form shows
  // why not. No redirect, no callback, no ?error= query string to parse.
  async function connectNextcloud(args: { serverUrl: string; username: string; appPassword: string }) {
    setBusy('nextcloud');
    setError('');
    try {
      await api.post('/connections/nextcloud/connect', args);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect to that Nextcloud server');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(view: ProviderView, capability: Capability) {
    if (!view.connection) return;
    // Provider permissions are upgraded once at account level. A capability
    // with a missing scope cannot be toggled until that upgrade completes.
    if (capability.needsConsent) return;
    setBusy(capability.key);
    setError('');
    try {
      await api.put(`/connections/${view.connection.id}/capabilities/${capability.key}`, {
        enabled: capability.state !== 'on',
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(view: ProviderView) {
    if (!view.connection) return;
    setBusy(view.provider);
    setError('');
    try {
      const res = await api.del<{ note?: string }>(`/connections/${view.connection.id}`);
      if (res?.note) setError(res.note);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  const cards = useMemo(() => providers?.flatMap((view) => {
    const accounts = view.connections?.filter(Boolean) ?? [];
    return accounts.length
      ? accounts.map((connection) => ({ ...view, connection, capabilities: connection.capabilities ?? view.capabilities }))
      : [view];
  }) ?? null, [providers]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Connections</h1>
      <p className="text-sm text-muted-foreground">
        Your own account, connected by you. An administrator can see whether a connection is working and
        can disconnect it, but cannot read what is inside it.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!cards ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {cards?.map((view) => (
        <CollapsibleCard
          key={`${view.provider}-${view.connection?.id ?? 'new'}`}
          title={PROVIDER_LABEL[view.provider]}
          summary={view.connection?.account ?? view.connection?.serverUrl ?? (view.available ? 'Not connected' : 'Not set up')}
          status={view.connection ? (
            <Badge tone={view.connection.status === 'active' ? 'ok' : 'danger'}>
              {view.connection.status === 'active' ? 'connected' : 'needs reconnecting'}
            </Badge>
          ) : null}
          defaultOpen={Boolean(view.connection && view.connection.status !== 'active')}
        >

          {/* No application registered: say so, and offer nothing to press.
              Nextcloud is never "unavailable" this way — it has no application
              to register, so its own branch below handles both states. */}
          {!view.available && view.provider !== 'nextcloud' ? (
            <NotYet title="Not set up on this installation">
              An administrator has to register {PROVIDER_LABEL[view.provider]} application credentials before
              anyone can connect an account. Until then there is nothing to press here.
            </NotYet>
          ) : !view.connection && view.provider === 'nextcloud' ? (
            <NextcloudConnectForm busy={busy === 'nextcloud'} onConnect={connectNextcloud} />
          ) : !view.connection ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {PROVIDER_LABEL[view.provider]} asks once for Josi's supported permission bundle. Every
                capability stays off in Josi until you choose to turn it on here.
              </p>
              <Button onClick={() => void connect(view.provider)} disabled={busy === view.provider}>
                {busy === view.provider ? 'Starting…' : `Connect ${PROVIDER_LABEL[view.provider]}`}
              </Button>
            </>
          ) : (
            <>
              {view.connection.account ? (
                <p className="truncate text-sm text-muted-foreground">{view.connection.account}</p>
              ) : null}
              {view.connection.serverUrl ? (
                <p className="truncate text-sm text-muted-foreground">{view.connection.serverUrl}</p>
              ) : null}
              {view.connection.errorCategory ? (
                <p className="mt-1 text-sm text-destructive">
                  {ERROR_TEXT[view.connection.errorCategory] ?? 'Something went wrong with this connection.'}
                </p>
              ) : null}

              {view.connection.needsPermissionUpgrade ? (
                <div className="mt-3 rounded-md border border-border p-3">
                  <p className="mb-2 text-sm text-muted-foreground">
                    This account was connected before Josi requested its current permission bundle. Upgrade once;
                    afterwards every available capability is controlled locally with the On/Off buttons below.
                  </p>
                  <Button variant="secondary" onClick={() => void connect(view.provider, view.connection!.id)} disabled={busy === view.provider}>
                    {busy === view.provider ? 'Starting…' : `Upgrade permissions / Reconnect ${PROVIDER_LABEL[view.provider]}`}
                  </Button>
                </div>
              ) : null}

              <ul className="mt-3 space-y-3">
                {view.capabilities.map((capability) => (
                  <li key={capability.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium">{capability.label}</span>
                      <CapabilityControl
                        capability={capability}
                        busy={busy === capability.key}
                        onToggle={() => void toggle(view, capability)}
                      />
                    </div>
                    {/* What a write permission actually permits, before it can
                        be switched on. */}
                    {capability.kind === 'write' && capability.consequence ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.consequence}</p>
                    ) : null}
                    {capability.adminNote ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.adminNote}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* Files. Real now — this replaces the "planned" placeholder.
                  Shown only under a live connection, because a folder is
                  mapped through a connection and read-only by scope. */}
              <CloudFolders
                provider={view.provider}
                connectionId={view.connection.id}
                capabilityOn={view.capabilities.some(
                  (c) => c.key === STORAGE_CAPABILITY_KEY[view.provider] && c.state === 'on',
                )}
              />

              <div className="mt-4">
                <Button variant="secondary" onClick={() => void disconnect(view)} disabled={busy === view.provider}>
                  Disconnect
                </Button>
                {OAUTH_PROVIDERS.includes(view.provider) ? (
                  <Button className="ml-2" variant="secondary" onClick={() => void connect(view.provider)} disabled={busy === view.provider}>
                    Add another {PROVIDER_LABEL[view.provider]} account
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </CollapsibleCard>
      ))}

      <DeveloperServices />

      <DocumentInventory />
    </div>
  );
}

interface DeveloperServiceRow {
  service: string;
  label: string;
  tokenLabel: string;
  tokenHelp: string;
  tokenUrl: string;
  capability: string;
  usernameLabel: string | null;
  emailLabel: string | null;
  baseUrlLabel: string | null;
  /** Whether an administrator permits ME to connect this. Separate from
   * whether I have. */
  allowed: boolean;
  note: string | null;
  connection: {
    accountLabel: string | null;
    status: string;
    lastCheckAt: string | null;
    lastCheckOk: boolean | null;
    lastError: string | null;
    lastUsedAt: string | null;
  } | null;
}

/** My own GitHub, Netlify, Vercel and Supabase.
 *
 * These are mine: my token, my account, and I can disconnect at any time. An
 * administrator decides whether I am permitted to connect one at all, and their
 * reason is shown here rather than leaving a control that fails — but the
 * refusal is enforced by the server, not by this component hiding a button.
 */
function DeveloperServices() {
  const [rows, setRows] = useState<DeveloperServiceRow[] | null>(null);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, {username?:string;email?:string;baseUrl?:string}>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved,setSaved]=useState('');
  useUnsavedChanges(Object.values(tokens).some(Boolean));

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ services: DeveloperServiceRow[] }>('/connections/developer');
      setRows(res.services);
    } catch(e) {
      setError('Could not read saved provider state. Retry without discarding your edits.');throw e;
    }
  }, []);
  useEffect(() => { void load().catch(()=>undefined); }, [load]);

  async function connect(service: string) {
    if(busy)return;
    setSaved('');
    setBusy(service);
    setError('');
    try {
      await api.put(`/connections/developer/${service}`, { token: tokens[service] ?? '', ...(details[service] ?? {}) });
      await load();
      setTokens((t) => ({ ...t, [service]: '' }));
      setSaved(`${service} connection saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be connected');
    } finally {
      setBusy('');
    }
  }

  async function check(service: string) {
    if(busy)return;
    setSaved('');
    setBusy(service);
    setError('');
    try {
      await api.post(`/connections/developer/${service}/check`, {});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That check could not run');
    } finally {
      setBusy('');
    }
  }

  async function disconnect(service: string) {
    if(busy)return;
    setSaved('');
    setBusy(service);
    setError('');
    try {
      await api.del(`/connections/developer/${service}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be disconnected');
    } finally {
      setBusy('');
    }
  }

  if (!rows?.length) return null;

  return (
    <>
      <h2 className="pt-2 text-lg font-semibold tracking-tight">Developer services</h2>
      <p className="text-sm text-muted-foreground">
        Your own accounts, connected with a token you create. Nobody else here can see the token,
        and disconnecting removes it.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {saved ? <p role="status">{saved}</p> : null}
      {rows.map((row) => (
        <Card key={row.service}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{row.label}</CardTitle>
            {row.connection ? (
              <Badge tone={row.connection.lastCheckOk === false ? 'danger' : 'ok'}>
                {row.connection.lastCheckOk === false ? 'needs attention' : 'connected'}
              </Badge>
            ) : (
              <Badge tone="muted">{row.allowed ? 'not connected' : 'not available'}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{row.capability}</p>

          {/* Not permitted: the administrator's reason, and no control. A
              disabled button that looks pressable is worse than none. */}
          {!row.allowed && !row.connection ? (
            <NotYet title="An administrator has not made this available">
              {row.note ?? 'Ask your administrator if you need it.'}
            </NotYet>
          ) : null}

          {row.connection ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-muted-foreground">
                Connected as {row.connection.accountLabel ?? 'your account'}
                {row.connection.lastCheckAt
                  ? ` · checked ${new Date(row.connection.lastCheckAt).toLocaleString()}`
                  : ''}
                {row.connection.lastUsedAt
                  ? ` · last used ${new Date(row.connection.lastUsedAt).toLocaleString()}`
                  : ''}
              </p>
              {row.connection.lastCheckOk === false && row.connection.lastError ? (
                <ErrorNote>{row.connection.lastError}</ErrorNote>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy === row.service}
                        onClick={() => void check(row.service)}>
                  {busy === row.service ? 'Checking…' : 'Check it still works'}
                </Button>
                <Button type="button" variant="secondary" disabled={busy === row.service}
                        onClick={() => void disconnect(row.service)}>
                  Disconnect
                </Button>
              </div>
            </div>
          ) : row.allowed ? (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => { e.preventDefault(); void connect(row.service); }}
            >
              <label className="block text-sm" htmlFor={`tok-${row.service}`}>{row.tokenLabel}</label>
              {row.usernameLabel ? <><label className="block text-sm" htmlFor={`username-${row.service}`}>{row.usernameLabel}</label><Input id={`username-${row.service}`} autoComplete="username" value={details[row.service]?.username??''} onChange={(e)=>setDetails((d)=>({...d,[row.service]:{...d[row.service],username:e.target.value}}))}/></> : null}
              {row.emailLabel ? <><label className="block text-sm" htmlFor={`email-${row.service}`}>{row.emailLabel}</label><Input id={`email-${row.service}`} type="email" autoComplete="email" value={details[row.service]?.email??''} onChange={(e)=>setDetails((d)=>({...d,[row.service]:{...d[row.service],email:e.target.value}}))}/></> : null}
              {row.baseUrlLabel ? <><label className="block text-sm" htmlFor={`url-${row.service}`}>{row.baseUrlLabel}</label><Input id={`url-${row.service}`} type="url" inputMode="url" placeholder="https://your-site.atlassian.net" value={details[row.service]?.baseUrl??''} onChange={(e)=>setDetails((d)=>({...d,[row.service]:{...d[row.service],baseUrl:e.target.value}}))}/></> : null}
              <Input
                id={`tok-${row.service}`}
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                value={tokens[row.service] ?? ''}
                onChange={(e) => setTokens((t) => ({ ...t, [row.service]: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {row.tokenHelp}{' '}
                <a className="underline" href={row.tokenUrl} target="_blank" rel="noreferrer noopener">
                  Open {row.label}
                </a>
              </p>
              <Button type="submit" disabled={busy === row.service || !(tokens[row.service] ?? '').trim() || (row.usernameLabel ? !(details[row.service]?.username??'').trim() : false) || (row.emailLabel ? !(details[row.service]?.email??'').trim() : false) || (row.baseUrlLabel ? !(details[row.service]?.baseUrl??'').trim() : false)}>
                {busy === row.service ? 'Connecting…' : 'Connect'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Josi checks the token with {row.label} before saving it, so a token that does not
                work is never stored as though it did.
              </p>
            </form>
          ) : null}
        </Card>
      ))}
    </>
  );
}

function DocumentInventory() {
  const [documents, setDocuments] = useState<Array<{ id: string; filename: string; state: string; skipReason: string | null; folder: string }>>([]);
  useEffect(() => { void api.get<{ documents: typeof documents }>('/storage/documents?limit=100').then((r) => setDocuments(r.documents)).catch(() => undefined); }, []);
  if (!documents.length) return null;
  return <Card><CardTitle>Files Josi can see</CardTitle><ul className="max-h-80 space-y-2 overflow-y-auto">
    {documents.map((document) => <li key={document.id} className="flex min-w-0 items-start justify-between gap-3 border-t border-border pt-2 first:border-0">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{document.filename}</p><p className="truncate text-xs text-muted-foreground">{document.folder}</p>
      {document.skipReason ? <p className="text-xs text-destructive">Skipped: {document.skipReason.replace(/_/g, ' ')}</p> : null}</div>
      <Badge tone={document.state === 'indexed' ? 'ok' : 'muted'}>{plain('document_state', document.state)}</Badge>
    </li>)}
  </ul></Card>;
}

/** The server address, username and app password Nextcloud's own
 * integration pattern asks for — generated in the person's OWN Nextcloud
 * account under Settings → Security → Devices & sessions, not something Josi
 * ever asks a Nextcloud server for on their behalf. Verified against the
 * server by the API route before it is stored; a wrong password shows up
 * here as a plain refusal, not a silently-broken connection discovered later. */
function NextcloudConnectForm({
  busy, onConnect,
}: {
  busy: boolean;
  onConnect: (args: { serverUrl: string; username: string; appPassword: string }) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');

  useUnsavedChanges(!!(serverUrl || username || appPassword));
  const canSubmit = serverUrl.trim() && username.trim() && appPassword.trim() && !busy;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void onConnect({ serverUrl: serverUrl.trim(), username: username.trim(), appPassword });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Connecting starts read-only. In your Nextcloud account, go to Settings → Security → Devices &amp;
        sessions and create a new app password for Josi — do not use your regular Nextcloud password here.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Server address</span>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="cloud.example.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          autoComplete="url"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Username</span>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">App password</span>
        <input
          type="password"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <Button type="submit" disabled={!canSubmit}>
        {busy ? 'Connecting…' : 'Connect Nextcloud'}
      </Button>
    </form>
  );
}

function CapabilityControl({
  capability, busy, onToggle,
}: { capability: Capability; busy: boolean; onToggle: () => void }) {
  // An administrator has switched this off installation-wide. Nothing to press:
  // a disabled control would imply the person could change it.
  if (capability.state === 'blocked_by_admin') {
    return <Badge>switched off by an administrator</Badge>;
  }
  if (capability.needsConsent) {
    return <Badge>available after account permission upgrade</Badge>;
  }
  return (
    <Button
      variant={capability.state === 'on' ? 'primary' : 'secondary'}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={capability.state === 'on'}
    >
      {capability.state === 'on' ? 'On' : 'Off'}
    </Button>
  );
}

function handshakeError(reason: string): string {
  switch (reason) {
    case 'declined':
      return 'You cancelled at the provider, so nothing was connected.';
    case 'consumed':
    case 'unknown':
    case 'expired':
      return 'That sign-in link had already been used or had expired. Start again.';
    case 'session_mismatch':
      return 'That sign-in was started in a different browser session. Start again here.';
    case 'wrong_provider':
      return 'That sign-in did not match the provider it was started for.';
    case 'revoked':
      return 'The provider refused the connection. Check the application credentials with your administrator.';
    default:
      return 'The connection could not be completed. Please try again.';
  }
}
