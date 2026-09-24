import { useUnsavedChanges } from '@/lib/useUnsavedChanges';
// Custom API connections — the administrator's side.
//
// This is the page where somebody grants Josi the ability to reach a service
// this product has never heard of, so it is built around the review rather than
// around the connecting. Three things it must never do:
//
//   * Present a connection as usable before the API has answered. The switch
//     that makes it available is disabled until a test succeeds, and the server
//     refuses it anyway.
//   * Present a list of imported actions as a list of granted ones. An import
//     saves nothing until the actions are chosen, and each saved one arrives
//     switched off with its own switch.
//   * Show a credential, or anything derived from one. The field is write-only:
//     what comes back is a constant mask, and leaving it blank when editing
//     keeps whatever is stored.
//
// It is deliberately NOT the Connections page (OAuth accounts with a consent
// screen), NOT the Developer services page (a personal access token acting as
// one person), and NOT the Model page. This is the only connection kind where
// the ASSISTANT chooses which request to make, and that difference is the whole
// reason the allowlist below exists.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface EndpointView {
  id: string;
  connectionId: string;
  operationId: string;
  summary: string;
  method: string;
  pathTemplate: string;
  capability: string;
  parameters: Array<{ name: string; in: string; required: boolean; description: string }>;
  acceptsBody: boolean;
  enabled: boolean;
  origin: string;
}

interface ConnectionView {
  id: string;
  name: string;
  slug: string;
  baseUrl: string;
  host: string;
  authKind: string;
  authHeader: string | null;
  credentialMask: string;
  testPath: string;
  enabled: boolean;
  connectionStatus: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastErrorCategory: string | null;
  endpoints: EndpointView[];
}

interface Proposal {
  operationId: string;
  summary: string;
  method: string;
  pathTemplate: string;
  parameters: Array<{ name: string; in: string; required: boolean; description: string }>;
  acceptsBody: boolean;
}

interface PreviewResult {
  proposals: Proposal[];
  skipped: Array<{ path: string; method: string; reason: string }>;
  declaredServers: string[];
  note?: string;
}

const HELP_URL = 'https://josi-ce-docs.netlify.app/#custom-api';

export function AdminCustomApis() {
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ connections: ConnectionView[] }>('/admin/custom-apis');
      setConnections(res.connections);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load custom API connections');
      throw err;
    }
  }, []);

  useEffect(() => { void load().catch(()=>undefined); }, [load]);

  async function run(key: string, work: () => Promise<string | void>) {
    if(busy)return;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const message = await work();
      await load();
      if (message) setNotice(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Custom API</h1>
      <p className="text-sm text-muted-foreground">
        Connect an external service Josi does not know about — a booking system, a CRM, something
        written in-house — and then say, one action at a time, exactly what Josi may ask it. Josi
        can never call anything you have not listed here, and it cannot reach any address other
        than the one you give.
      </p>
      <p className="text-sm text-muted-foreground">
        This is separate from <strong>Connections</strong> (signing in to Google or Microsoft),
        from <strong>Developer services</strong> (a token you paste for your own GitHub or Netlify
        account), and from the <strong>Model</strong> your assistant thinks with.{' '}
        <a className="underline" href={HELP_URL} target="_blank" rel="noreferrer noopener">
          Read the help page for custom APIs
        </a>
        .
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}
      {!connections ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {connections?.length === 0 && !adding ? (
        <Card>
          <CardTitle>Nothing connected</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            No external API is connected. Josi cannot reach any outside service through this page
            until you add one, test it, and switch on the actions you want.
          </p>
          <Button onClick={() => setAdding(true)}>Connect an API</Button>
        </Card>
      ) : null}

      {adding ? (
        <ConnectionForm
          busy={!!busy}
          onCancel={() => setAdding(false)}
          onSubmit={async (body) => {
            await run('new', async () => {
              await api.post('/admin/custom-apis', body);
              setAdding(false);
              return 'Added. Test it, then switch on the actions Josi may use.';
            });
          }}
        />
      ) : null}

      {connections?.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          busy={busy}
          run={run}
        />
      ))}

      {connections?.length && !adding ? (
        <Button variant="secondary" onClick={() => setAdding(true)}>Connect another API</Button>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------- one connection

function ConnectionCard({
  connection, busy, run,
}: {
  connection: ConnectionView;
  busy: string;
  run: (key: string, work: () => Promise<string | void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [addingAction, setAddingAction] = useState(false);
  const tested = connection.lastCheckOk === true;
  const liveActions = connection.endpoints.filter((e) => e.enabled).length;

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <CardTitle>{connection.name}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={connection.connectionStatus === 'active' ? 'ok' : 'danger'}>
            {plain('custom_api_status', connection.connectionStatus)}
          </Badge>
          <Badge tone={connection.enabled ? 'ok' : undefined}>
            {connection.enabled ? 'Available to Josi' : 'Not available to Josi'}
          </Badge>
        </div>
      </div>

      <dl className="mt-2 space-y-1 text-sm">
        <Row label="Address">{connection.baseUrl}</Row>
        <Row label="Josi will only ever call">{connection.host}</Row>
        <Row label="Short name the assistant uses">{connection.slug}</Row>
        <Row label="Authentication">
          {connection.authKind === 'basic'
            ? 'Username and password'
            : connection.authKind === 'bearer'
              ? 'Bearer token'
              : `API key in the ${connection.authHeader} header`}
        </Row>
        <Row label="Credential">
          {/* A constant mask. Josi keeps the credential sealed and cannot show
              it again — nor can anyone else, which is the point. */}
          <span className="font-mono">{connection.credentialMask}</span>
        </Row>
        <Row label="Last tested">
          {connection.lastCheckAt ? new Date(connection.lastCheckAt).toLocaleString() : 'not yet'}
        </Row>
      </dl>

      {plainDetail('custom_api_status', connection.connectionStatus) ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {plainDetail('custom_api_status', connection.connectionStatus)}
        </p>
      ) : null}

      {connection.lastErrorCategory ? (
        <p className="mt-1 text-sm text-destructive">
          {plain('connector_error', connection.lastErrorCategory)}
          {plainDetail('connector_error', connection.lastErrorCategory)
            ? ` — ${plainDetail('connector_error', connection.lastErrorCategory)}`
            : ''}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!!busy}
          onClick={() => void run(connection.id, async () => {
            await api.post(`/admin/custom-apis/${connection.id}/test`);
            return `${connection.name} answered.`;
          })}
        >
          {busy === connection.id ? 'Testing…' : 'Test connection'}
        </Button>

        {/* Least privilege, made visible: this cannot be pressed until the API
            has answered, and the server refuses it as well. */}
        <Button
          variant={connection.enabled ? 'danger' : 'primary'}
          disabled={!!busy || (!connection.enabled && !tested)}
          title={!connection.enabled && !tested ? 'Test the connection first' : undefined}
          onClick={() => void run(connection.id, async () => {
            await api.post(`/admin/custom-apis/${connection.id}/${connection.enabled ? 'disable' : 'enable'}`);
            return connection.enabled
              ? 'Josi can no longer use this API.'
              : 'Josi may now use the actions you have switched on.';
          })}
        >
          {connection.enabled ? 'Make unavailable to Josi' : 'Make available to Josi'}
        </Button>

        <Button variant="ghost" disabled={!!busy} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Cancel edit' : 'Edit'}
        </Button>
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() => void run(connection.id, async () => {
            await api.del(`/admin/custom-apis/${connection.id}`);
            return `${connection.name} and its actions were removed.`;
          })}
        >
          Remove
        </Button>
      </div>

      {!connection.enabled && !tested ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Josi will not offer an API to the assistant on the strength of a form somebody filled in
          — only on the strength of the API having answered. Test it first.
        </p>
      ) : null}

      {editing ? (
        <div className="mt-3">
          <ConnectionForm
            existing={connection}
            busy={!!busy}
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              await run(connection.id, async () => {
                await api.patch(`/admin/custom-apis/${connection.id}`, body);
                await api.get('/admin/custom-apis');
                setEditing(false);
                return 'Saved. Changing the address or the credential means testing it again.';
              });
            }}
          />
        </div>
      ) : null}

      {/* ------------------------------------------------------ the allowlist */}
      <div className="mt-4 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            What Josi may ask it ({liveActions} of {connection.endpoints.length} switched on)
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" disabled={!!busy} onClick={() => setAddingAction((v) => !v)}>
              {addingAction ? 'Cancel' : 'Add an action'}
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => setImporting((v) => !v)}>
              {importing ? 'Cancel import' : 'Import OpenAPI'}
            </Button>
          </div>
        </div>

        {connection.endpoints.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing is listed, so Josi can ask this API for nothing at all. Add the actions it
            should be able to use.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {connection.endpoints.map((endpoint) => (
              <EndpointRow key={endpoint.id} endpoint={endpoint} busy={busy} run={run} />
            ))}
          </ul>
        )}

        {addingAction ? (
          <div className="mt-3">
            <EndpointForm
              busy={!!busy}
              onCancel={() => setAddingAction(false)}
              onSubmit={async (body) => {
                await run(connection.id, async () => {
                  await api.post(`/admin/custom-apis/${connection.id}/endpoints`, body);
                  setAddingAction(false);
                  return 'Added, and switched off. Switch it on when you are happy with it.';
                });
              }}
            />
          </div>
        ) : null}

        {importing ? (
          <ImportPanel
            connection={connection}
            busy={!!busy}
            run={run}
            onDone={() => setImporting(false)}
          />
        ) : null}
      </div>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-medium">{children}</dd>
    </div>
  );
}

function EndpointRow({
  endpoint, busy, run,
}: {
  endpoint: EndpointView;
  busy: string;
  run: (key: string, work: () => Promise<string | void>) => Promise<void>;
}) {
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-mono text-sm">{endpoint.operationId}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={endpoint.capability === 'read' ? undefined : 'danger'}>
            {plain('custom_api_capability', endpoint.capability)}
          </Badge>
          <Badge tone={endpoint.enabled ? 'ok' : undefined}>
            {endpoint.enabled ? 'Switched on' : 'Switched off'}
          </Badge>
        </div>
      </div>
      <p className="mt-1 text-sm">{endpoint.summary}</p>
      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
        {endpoint.method} {endpoint.pathTemplate}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {plainDetail('custom_api_capability', endpoint.capability)}
        {' '}
        {plain('custom_api_endpoint_source', endpoint.origin)}.
        {endpoint.parameters.length
          ? ` Accepts: ${endpoint.parameters.map((p) => `${p.name}${p.required ? '' : ' (optional)'}`).join(', ')}.`
          : ' Takes no parameters.'}
        {endpoint.acceptsBody ? ' Sends a block of details.' : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant={endpoint.enabled ? 'secondary' : 'primary'}
          disabled={!!busy}
          onClick={() => void run(endpoint.id, async () => {
            await api.post(`/admin/custom-apis/endpoints/${endpoint.id}/${endpoint.enabled ? 'disable' : 'enable'}`);
          })}
        >
          {endpoint.enabled ? 'Switch off' : 'Switch on'}
        </Button>
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() => void run(endpoint.id, async () => {
            await api.del(`/admin/custom-apis/endpoints/${endpoint.id}`);
          })}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

// ------------------------------------------------------------------- forms

interface ConnectionBody {
  name: string;
  slug?: string;
  baseUrl: string;
  authKind: string;
  authHeader?: string;
  secret?: string;
  username?: string;
  password?: string;
  testPath: string;
}

function ConnectionForm({
  existing, busy, onCancel, onSubmit,
}: {
  existing?: ConnectionView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: ConnectionBody) => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? 'https://');
  const [authKind, setAuthKind] = useState(existing?.authKind ?? 'bearer');
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? 'X-API-Key');
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [testPath, setTestPath] = useState(existing?.testPath ?? '/');
  const dirty = name !== (existing?.name??'') || slug !== (existing?.slug??'') || baseUrl !== (existing?.baseUrl??'https://') || authKind !== (existing?.authKind??'bearer') || authHeader !== (existing?.authHeader??'X-API-Key') || testPath !== (existing?.testPath??'/') || !!(secret||username||password);
  const valid = !!name.trim() && /^https:\/\//.test(baseUrl);
  useUnsavedChanges(dirty);


  return (
    <Card>
      <CardTitle>{existing ? 'Edit this connection' : 'Connect an API'}</CardTitle>
      <form
        className="mt-2 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if(busy || !dirty || !valid)return;
          const body: ConnectionBody = { name, baseUrl, authKind, testPath };
          if (!existing) body.slug = slug;
          if (authKind === 'api_key') body.authHeader = authHeader;
          // Blank means "keep what is stored". A form that re-sent the mask
          // would store the mask as the credential.
          if (authKind === 'basic') {
            if (username || password || !existing) { body.username = username; body.password = password; }
          } else if (secret || !existing) {
            body.secret = secret;
          }
          void onSubmit(body);
        }}
      >
        <Field label="Name" hint="What people will see. For example, “Our booking system”.">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </Field>

        {!existing ? (
          <Field
            label="Short name for the assistant"
            hint="Lowercase letters, digits and underscores. Leave blank and Josi makes one from the name."
          >
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={40} placeholder="booking_system" />
          </Field>
        ) : null}

        <Field
          label="Address"
          hint="Must start with https://. Josi will only ever call this host, and refuses if it resolves to a private or internal address."
        >
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            placeholder="https://api.example.com/v1"
            autoComplete="url"
          />
        </Field>

        <Field label="How it authenticates" hint="Josi does not offer OAuth here; see the help page for why.">
          <select
            className="min-h-11 w-full rounded-md border border-border bg-card px-3 text-sm"
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value)}
          >
            <option value="bearer">Bearer token</option>
            <option value="api_key">API key in a header</option>
            <option value="basic">Username and password</option>
          </select>
        </Field>

        {authKind === 'api_key' ? (
          <Field label="Header name" hint="For example X-API-Key. Never a query string — a key in a URL is a key in every proxy log.">
            <Input value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} required maxLength={64} />
          </Field>
        ) : null}

        {authKind === 'basic' ? (
          <>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required={!existing}
                autoComplete="off"
              />
            </Field>
            <Field label="Password" hint={existing ? 'Leave blank to keep the one already stored.' : undefined}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={!existing}
                autoComplete="new-password"
              />
            </Field>
          </>
        ) : (
          <Field
            label={authKind === 'bearer' ? 'Token' : 'API key'}
            hint={existing
              ? 'Leave blank to keep the one already stored. It is encrypted and cannot be read back.'
              : 'Encrypted with this installation’s master key. Nobody, including the assistant, can read it back.'}
          >
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required={!existing}
              autoComplete="new-password"
            />
          </Field>
        )}

        <Field label="Test path" hint="A path Josi can GET to check the connection works — often /health or /me.">
          <Input value={testPath} onChange={(e) => setTestPath(e.target.value)} required maxLength={400} />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !dirty || !valid}>{existing ? 'Save' : 'Add connection'}</Button>
          <Button type="button" variant="ghost" onClick={() => { if (!dirty || window.confirm('Discard unsaved changes?')) onCancel(); }} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

interface EndpointBody {
  operationId: string;
  summary: string;
  method: string;
  pathTemplate: string;
  parameters: Array<{ name: string; in: string; required: boolean; description: string }>;
  acceptsBody: boolean;
}

function EndpointForm({
  busy, onCancel, onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: EndpointBody) => Promise<void>;
}) {
  const [operationId, setOperationId] = useState('');
  const [summary, setSummary] = useState('');
  const [method, setMethod] = useState('GET');
  const [pathTemplate, setPathTemplate] = useState('/');
  const [query, setQuery] = useState('');
  const [acceptsBody, setAcceptsBody] = useState(false);
  const read = method === 'GET' || method === 'HEAD';
  const dirty = !!(operationId || summary || query || acceptsBody || method !== 'GET' || pathTemplate !== '/');
  const valid = /^[a-z][a-z0-9_]*$/.test(operationId) && !!summary.trim() && pathTemplate.startsWith('/') && !pathTemplate.startsWith('//');
  useUnsavedChanges(dirty);

  return (
    <Card>
      <CardTitle>Add an action</CardTitle>
      <p className="mb-2 text-sm text-muted-foreground">
        Whether Josi has to ask before doing this is decided by the method, not by a setting:
        anything other than GET or HEAD waits for the person to approve it.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !valid) return;
          // Path placeholders become required path parameters; the named query
          // parameters are the ONLY ones the assistant may ever set.
          const placeholders = [...pathTemplate.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]);
          const parameters = [
            ...placeholders.map((name) => ({ name, in: 'path', required: true, description: '' })),
            ...query.split(',').map((s) => s.trim()).filter(Boolean)
              .map((name) => ({ name, in: 'query', required: false, description: '' })),
          ];
          void onSubmit({ operationId, summary, method, pathTemplate, parameters, acceptsBody: !read && acceptsBody });
        }}
      >
        <Field label="Action id" hint="What the assistant names. Lowercase letters, digits and underscores.">
          <Input value={operationId} onChange={(e) => setOperationId(e.target.value)} required placeholder="list_customers" />
        </Field>
        <Field label="What it does" hint="In the words the assistant will read, and the words you will review later.">
          <Input value={summary} onChange={(e) => setSummary(e.target.value)} required maxLength={400} />
        </Field>
        <Field label="Method">
          <select
            className="min-h-11 w-full rounded-md border border-border bg-card px-3 text-sm"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            {['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Path" hint="A path under the address above, with {placeholders}. Never a full web address.">
          <Input value={pathTemplate} onChange={(e) => setPathTemplate(e.target.value)} required placeholder="/customers/{id}" />
        </Field>
        <Field label="Query parameters" hint="Comma separated. Anything not listed here is dropped, whatever the assistant sends.">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search, limit" />
        </Field>
        {!read ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={acceptsBody} onChange={(e) => setAcceptsBody(e.target.checked)} />
            This action sends a block of details (a JSON body)
          </label>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !valid}>Add, switched off</Button>
          <Button type="button" variant="ghost" onClick={() => { if (!dirty || window.confirm('Discard unsaved changes?')) onCancel(); }} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ import

function ImportPanel({
  connection, busy, run, onDone,
}: {
  connection: ConnectionView;
  busy: boolean;
  run: (key: string, work: () => Promise<string | void>) => Promise<void>;
  onDone: () => void;
}) {
  const [specText, setSpecText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [localError, setLocalError] = useState('');

  async function loadPreview() {
    setLocalError('');
    try {
      const res = await api.post<PreviewResult>(
        `/admin/custom-apis/${connection.id}/endpoints/import`, { document: specText },
      );
      setPreview(res);
      setChosen(new Set());
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.message : 'That document could not be read');
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border p-3">
      <h4 className="text-sm font-semibold">Import from an OpenAPI document</h4>
      <p className="text-sm text-muted-foreground">
        Paste the JSON form of an OpenAPI 3 document. Nothing is saved until you choose from the
        list it produces, and everything you choose arrives switched off. Josi ignores the
        addresses inside the document — it will only ever call {connection.host}.
      </p>
      {localError ? <ErrorNote>{localError}</ErrorNote> : null}
      <textarea
        className="h-40 w-full rounded-md border border-border bg-card p-2 font-mono text-xs"
        value={specText}
        onChange={(e) => setSpecText(e.target.value)}
        placeholder='{"openapi": "3.0.0", "paths": { ... }}'
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy || !specText.trim()} onClick={() => void loadPreview()}>
          Read the document
        </Button>
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>Close</Button>
      </div>

      {preview ? (
        <div className="space-y-2">
          {preview.declaredServers.length ? (
            <p className="text-xs text-muted-foreground">
              That document names {preview.declaredServers.join(', ')} as its address. Josi ignored
              it and will use {connection.baseUrl}. If those disagree, check the address above
              before importing anything.
            </p>
          ) : null}
          <p className="text-sm">
            {preview.proposals.length} action(s) found. Choose the ones Josi may use.
          </p>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {preview.proposals.map((p) => (
              <li key={p.operationId} className="text-sm">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={chosen.has(p.operationId)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(p.operationId); else next.delete(p.operationId);
                      setChosen(next);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="break-all font-mono">{p.operationId}</span>
                    {' — '}
                    {p.summary}
                    <span className="block break-all font-mono text-xs text-muted-foreground">
                      {p.method} {p.pathTemplate}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {preview.skipped.length ? (
            <details className="text-xs text-muted-foreground">
              <summary>{preview.skipped.length} operation(s) could not be used</summary>
              <ul className="mt-1 space-y-1">
                {preview.skipped.map((s, i) => (
                  <li key={`${s.method}-${s.path}-${i}`}>{s.method} {s.path} — {s.reason}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <Button
            type="button"
            disabled={busy || chosen.size === 0}
            onClick={() => void run(connection.id, async () => {
              await api.post(`/admin/custom-apis/${connection.id}/endpoints/import`, {
                document: specText, operations: [...chosen],
              });
              setPreview(null);
              onDone();
              return `${chosen.size} action(s) imported, all switched off.`;
            })}
          >
            Import {chosen.size} action(s), switched off
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
