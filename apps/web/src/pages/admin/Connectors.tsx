// The installation's own OAuth applications, and the capability ceiling.
//
// Two things this page must not imply. It must not suggest the admin can grant
// a capability — the policy control says "allowed", and turning it on returns
// the choice to each person rather than switching anything on. And it must not
// show anything from inside a connected account: the health table is whose it
// is and whether it works.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useUnsavedChanges } from '@/lib/useUnsavedChanges';
import { Badge, Button, Card, CardTitle, Copyable, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

type OAuthProvider = 'google' | 'microsoft' | 'dropbox' | 'box';

interface ClientStatus {
  provider: OAuthProvider;
  configured: boolean;
  clientId: string | null;
  redirectUri: string | null;
}

interface PolicyRow {
  key: string;
  provider: string;
  label: string;
  kind: 'read' | 'write';
  allowed: boolean;
  note: string | null;
}

interface RegistrationState {
  available: boolean;
  publicHttpsBase: string | null;
  detectedOrigin: string;
  reason: string | null;
}

interface AdminView {
  clients: ClientStatus[];
  /** Whether an OAuth application can be registered from this address yet.
   * Setup used to ask for these applications as its sixth step, on
   * installations that had no public domain and so could never finish it. */
  registration: RegistrationState;
  policy: PolicyRow[];
  suggestedRedirectUris: Array<{ provider: string; uri: string; additionalUris?: string[] }>;
}

interface HealthRow {
  id: string;
  username: string;
  provider: string;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: string | null;
}

const LABEL: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  dropbox: 'Dropbox',
  box: 'Box',
  nextcloud: 'Nextcloud',
};

const APPLICATION_HELP: Record<OAuthProvider, string> = {
  google: 'Used for Google Mail, Calendar, Contacts, and Drive.',
  microsoft: 'Used for Outlook Mail, Calendar, Contacts, and OneDrive.',
  dropbox: 'Used for read-only access to Dropbox folders people choose.',
  box: 'Used for read-only access to Box folders people choose.',
};

function OAuthClientForm({
  client, suggested, onSave,
}: {
  client: ClientStatus;
  suggested: string;
  onSave: (provider: string, values: { clientId: string; clientSecret: string; redirectUri: string }) => Promise<boolean>;
}) {
  const initialId = client.clientId ?? '';
  const initialUri = client.redirectUri ?? suggested;
  const [clientId, setClientId] = useState(initialId);
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(initialUri);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = clientId !== initialId || redirectUri !== initialUri || clientSecret.length > 0;
  const valid = clientId.trim().length > 0 && clientSecret.length > 0 && /^https?:\/\//.test(redirectUri.trim());
  const canSave = dirty && valid && !saving;

  useUnsavedChanges(dirty);

  return (
    <form
      data-dirty={dirty ? 'true' : 'false'}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        setSaving(true);
        setSaved(false);
        void onSave(client.provider, {
          clientId: clientId.trim(), clientSecret, redirectUri: redirectUri.trim(),
        }).then((ok) => {
          if (ok) {
            setClientSecret('');
            setSaved(true);
          }
        }).finally(() => setSaving(false));
      }}
      className="space-y-3"
    >
      <div>
        <label className="mb-1 block text-sm" htmlFor={`cid-${client.provider}`}>Client ID</label>
        <Input disabled={saving} id={`cid-${client.provider}`} name="clientId" value={clientId}
               onChange={(event) => { setClientId(event.target.value); setSaved(false); }} required />
      </div>
      <div>
        <label className="mb-1 block text-sm" htmlFor={`csec-${client.provider}`}>Client secret</label>
        <Input disabled={saving} id={`csec-${client.provider}`} name="clientSecret" type="password" value={clientSecret}
               onChange={(event) => { setClientSecret(event.target.value); setSaved(false); }}
               autoComplete="new-password" required
               placeholder={client.configured ? 'stored — enter a new one to replace it' : ''} />
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Advanced — override the redirect URL</summary>
        <div className="mt-2">
          <label className="mb-1 block text-sm" htmlFor={`uri-${client.provider}`}>Redirect URL</label>
          <Input disabled={saving} id={`uri-${client.provider}`} name="redirectUri" value={redirectUri}
                 onChange={(event) => { setRedirectUri(event.target.value); setSaved(false); }} required />
          <p className="mt-1 text-xs text-muted-foreground">
            Only change this if a proxy in front of Josi rewrites the path. It must match what
            you registered with the provider exactly.
          </p>
        </div>
      </details>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</Button>
        {saved ? <p className="text-sm text-emerald-400" role="status">{LABEL[client.provider]} application saved.</p> : null}
      </div>
    </form>
  );
}

export function AdminConnectors() {
  const [view, setView] = useState<AdminView | null>(null);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [error, setError] = useState('');
  const [policyBusy, setPolicyBusy] = useState<string | null>(null);
  const [policySaved, setPolicySaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.get<AdminView>('/admin/connectors'));
      setHealth((await api.get<{ connections: HealthRow[] }>('/admin/connectors/connections')).connections);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load connector settings');
      throw err;
    }
  }, []);

  useEffect(() => { void load().catch(() => undefined); }, [load]);

  async function saveClient(provider: string, values: { clientId: string; clientSecret: string; redirectUri: string }) {
    setError('');
    try {
      await api.put(`/admin/connectors/clients/${provider}`, {
        ...values,
      });
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
      return false;
    }
  }

  async function setPolicy(capability: string, allowed: boolean) {
    if (policyBusy) return;
    setPolicyBusy(capability);
    setPolicySaved(null);
    setError('');
    try {
      await api.put(`/admin/connectors/policy/${capability}`, { allowed });
      await load();
      setPolicySaved(capability);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    } finally {
      setPolicyBusy(null);
    }
  }

  async function revoke(id: string) {
    setError('');
    try {
      await api.del(`/admin/connectors/connections/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect that');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
      <p className="text-sm text-muted-foreground">
        Register this installation's provider applications here. People connect their own accounts from
        Workspace → Connections; administrators can configure access and see health, but never account contents.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!view ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {/* A LAN-only installation is told the requirement and where to fix it,
          rather than being shown credential fields whose result Google and
          Microsoft would both reject. This is the same answer the wizard used
          to give at step 6 — moved to the one screen that can act on it. */}
      {view && !view.registration.available ? (
        <Card>
          <CardTitle>A public address is needed first</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">{view.registration.reason}</p>
          <p className="mt-2 break-all text-sm text-muted-foreground">Currently detected address: <strong>{view.registration.detectedOrigin}</strong></p>
          <p className="mt-2 text-sm text-muted-foreground">
            Set one in <a className="underline" href="/admin/workspace">Workspace</a>, then come back
            here. Nothing else about this installation depends on it, and no data is affected.
          </p>
        </Card>
      ) : null}

      {view?.registration.available ? <p className="text-sm text-muted-foreground">Public origin: <strong>{view.registration.publicHttpsBase}</strong></p> : null}

      {view?.registration.available ? view.clients.map((client) => {
        const suggestion = view.suggestedRedirectUris.find((u) => u.provider === client.provider);
        const suggested = suggestion?.uri ?? '';
        return (
          <Card key={client.provider}>
            <details onToggle={(event) => {
              const details = event.currentTarget;
              if (!details.open && details.querySelector('[data-dirty="true"]')
                && !window.confirm('Discard unsaved connector changes?')) details.open = true;
            }}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                <CardTitle>{LABEL[client.provider]} application</CardTitle>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={client.configured ? 'ok' : 'muted'}>
                    {client.configured ? 'configured' : 'not set up'}
                  </Badge>
                  <span aria-hidden="true" className="text-muted-foreground">⌄</span>
                </span>
              </summary>
              <div className="mt-3 border-t border-border pt-3">
                <p className="mb-3 text-sm text-muted-foreground">
                  {APPLICATION_HELP[client.provider]} Josi ships with no application credentials of its own —
                  register this installation with {LABEL[client.provider]} and paste the credentials here. The
                  secret is encrypted with this installation's master key and is never shown again.
                </p>
                {/* LB12.2: the one value that has to be pasted somewhere else,
                    with a way to take it. A callback typed by hand and a callback
                    the server honours must be the same string, and a mismatch
                    produces the provider's error page rather than ours. */}
                {/* LB12.4. Least privilege is only meaningful if the person is
                    told what they are granting, so the scopes are named rather
                    than summarised as "access". This disclosure used to live in
                    the setup wizard's connector step; it moved here with the
                    registration itself, because the consent it explains is the
                    same one either way. */}
                {(() => {
                  const asks = view.policy.filter(
                    (c) => c.provider === client.provider && c.kind === 'read',
                  );
                  if (!asks.length) return null;
                  return (
                    <div className="mb-3">
                      <p className="text-sm font-medium">Permissions this will ask each person for</p>
                      <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                        {asks.map((c) => (
                          <li key={c.key}>{c.label} — Read-only</li>
                        ))}
                      </ul>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Registering the application does not connect anyone's account or grant
                        anything. Each person is asked separately, and anything that writes is a
                        further consent of its own.
                      </p>
                    </div>
                  );
                })()}
                <Copyable label={`Paste this into ${LABEL[client.provider]} as the redirect URL`} value={suggested} />
                {suggestion?.additionalUris?.map((uri) => (
                  <Copyable key={uri} label="Also register this URL for Sign in with Google" value={uri} />
                ))}
                <OAuthClientForm client={client} suggested={suggested} onSave={saveClient} />
              </div>
            </details>
          </Card>
        );
      }) : null}

      <Card>
        <details>
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <CardTitle>Nextcloud</CardTitle>
            <span className="flex shrink-0 items-center gap-2">
              <Badge tone="ok">no application needed</Badge>
              <span aria-hidden="true" className="text-muted-foreground">⌄</span>
            </span>
          </summary>
          <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
            Nextcloud is configured by each person from Workspace → Connections using their server address,
            username, and a dedicated app password. There is no central OAuth application for an administrator
            to register here.
          </p>
        </details>
      </Card>

      <Card>
        <details>
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <CardTitle>Member permissions</CardTitle>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground">⌄</span>
          </summary>
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-3 text-sm text-muted-foreground">
              This can only take permissions away. Marking something allowed does not switch it on for anyone —
              it returns the choice to each person, and someone who never enabled it still has not.
            </p>
            <ul className="space-y-3">
              {view?.policy.map((row) => (
                <li key={row.key} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 text-sm">
                    {row.label}
                    {row.kind === 'write' ? <span className="ml-2 text-xs text-muted-foreground">writes</span> : null}
                  </span>
                  <Button
                    variant={row.allowed ? 'secondary' : 'danger'}
                    onClick={() => void setPolicy(row.key, !row.allowed)}
                    disabled={policyBusy !== null}
                    aria-pressed={!row.allowed}
                  >
                    {policyBusy === row.key ? 'Saving…' : row.allowed ? 'Allowed' : 'Switched off'}
                  </Button>
                  {policySaved === row.key ? <span className="sr-only" role="status">Member permission saved.</span> : null}
                </li>
              ))}
            </ul>
          </div>
        </details>
      </Card>

      <Card>
        <CardTitle>Connection health</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Whose connection it is and whether it works. Not the account address, not what is inside it.
        </p>
        {health.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has connected an account yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[24rem] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Person</th>
                  <th className="py-1 font-medium">Provider</th>
                  <th className="py-1 font-medium">State</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {health.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2">{row.username}</td>
                    <td className="py-2">{LABEL[row.provider] ?? row.provider}</td>
                    <td className="py-2">
                      <Badge tone={row.status === 'active' ? 'ok' : 'danger'}>
                        {plain('connection_status', row.status)}
                      </Badge>
                      {row.last_error_category ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {plainDetail('connector_error', row.last_error_category)
                            ?? plain('connector_error', row.last_error_category)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" onClick={() => void revoke(row.id)}>Disconnect</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
