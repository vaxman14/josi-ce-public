// Parental controls, and the licence that unlocks them.
//
// What this screen replaces said the installation was unlicensed and that the
// build had no publisher verification key, and then stopped. Two sentences of
// explanation with nothing to do next is a dead end: the operator has bought a
// licence and has nowhere to put it.
//
// So there is exactly one of two things here at any time. Either the build can
// verify a licence, and there is a form to enter one; or it cannot, and there
// are the steps to install the build that can. Never a refusal on its own.
//
// Nobody is ever asked to paste a publisher secret or edit a file inside the
// container. The key the operator types is their own licence; the key that
// verifies it belongs to the publisher, is public, and is already in the image.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, Copyable, ErrorNote, Input } from '@/components/ui';

type LicenceState =
  | 'unverifiable_build' | 'none' | 'active' | 'expired' | 'wrong_installation' | 'invalid';

interface LicenceDetails {
  subject: string;
  installationId: string | null;
  features: string[];
  issuedAt: string;
  expiresAt: string | null;
}

interface SupportedBuild {
  publisher: string;
  image: string;
  docs: string;
  steps: string[];
}

interface LicenceView {
  state: LicenceState;
  detail: string;
  activatedAt: string | null;
  licence: LicenceDetails | null;
  canActivate: boolean;
  supportedBuild: SupportedBuild | null;
  installationId: string;
}

/** What each state means to the operator, and whether it is their problem to
 * fix. "Invalid" and "issued to a different installation" are different
 * situations with different next steps. */
const STATE_LABEL: Record<LicenceState, string> = {
  active: 'Licensed',
  none: 'Not licensed',
  expired: 'Expired',
  wrong_installation: 'Issued to another installation',
  invalid: 'Not recognised',
  unverifiable_build: 'This build cannot check licences',
};

export function AdminParentalControls() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4" aria-disabled="true">
      <h1 className="text-xl font-semibold tracking-tight">Parental controls <Badge tone="muted">Coming Soon</Badge></h1>
      <Card className="opacity-75">
        <CardTitle>Disabled while we redesign it</CardTitle>
        <p className="text-sm text-muted-foreground">No supervision, schedules, limits, monitoring, or child-safety enforcement are available or active in this build.</p>
        <p className="mt-2 text-sm text-muted-foreground">The planned feature will let parents or guardians create and manage child profiles, set age-appropriate access rules and schedules, review relevant Josi activity, and receive useful usage and safety information. Parental authority will remain separate from ordinary administration.</p>
        <p className="mt-2 text-sm text-muted-foreground">Tell us what you need at <a className="underline" href="mailto:roman@socalreceptionist.com">roman@socalreceptionist.com</a>.</p>
      </Card>
    </div>
  );
}

function AdminParentalControlsImplementation() {
  const [view, setView] = useState<LicenceView | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.get<LicenceView>('/admin/licence'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the licence');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Activating and replacing are one action. Replacing is activating over the
   * top, and a separate control would be the same request under another name. */
  async function activate() {
    setBusy(true);
    setError('');
    try {
      await api.put('/admin/licence', { token: token.trim() });
      setToken('');
      setReplacing(false);
      await load();
    } catch (err) {
      // The server's sentence, which names which of the failures this was.
      setError(err instanceof Error ? err.message : 'That licence could not be activated');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    setBusy(true);
    setError('');
    try {
      await api.del('/admin/licence');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That licence could not be removed');
    } finally {
      setBusy(false);
    }
  }

  const licensed = view?.state === 'active';

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Parental controls <Badge tone="danger">BETA</Badge></h1>
      <div role="alert" className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
        <p className="font-semibold text-amber-200">BETA — experimental and not suitable as a safety control.</p>
        <p className="mt-1 text-amber-100/90">
          Do not trust or rely on this feature to protect a child. It may fail, be delayed, or behave unexpectedly and it controls
          only Josi—not the device, other apps, websites, location, or emergencies. Use active adult supervision and proven
          device-level controls, and verify restrictions independently.
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Parental controls are a licensed feature. This page is where the licence is activated and
        managed.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!view ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {view ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Licence</CardTitle>
            <Badge tone={licensed ? 'ok' : view.state === 'none' ? 'muted' : 'danger'}>
              {STATE_LABEL[view.state]}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{view.detail}</p>

          {view.licence ? (
            <dl className="mt-3 space-y-1 text-sm text-muted-foreground">
              <div>
                <dt className="inline font-medium">Issued to: </dt>
                <dd className="inline">{view.licence.subject}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Covers: </dt>
                <dd className="inline">{view.licence.features.join(', ') || 'nothing'}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Expires: </dt>
                <dd className="inline">
                  {view.licence.expiresAt
                    ? new Date(view.licence.expiresAt).toLocaleDateString()
                    : 'does not expire'}
                </dd>
              </div>
              {view.activatedAt ? (
                <div>
                  <dt className="inline font-medium">Activated: </dt>
                  <dd className="inline">{new Date(view.activatedAt).toLocaleString()}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}

          {/* The form appears whenever entering a key could work: with no
              licence, with a rejected one, and when replacing a valid one.
              Retrying IS entering it again, so there is no separate retry. */}
          {view.canActivate && (!licensed || replacing) ? (
            <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void activate(); }}>
              <label className="block text-sm" htmlFor="licence">Licence key</label>
              <textarea
                id="licence"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                autoCapitalize="none"
                spellCheck={false}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                placeholder="Paste the licence key you were sent"
              />
              <p className="text-xs text-muted-foreground">
                This is the key SOCAL RECEPTIONIST LLC sent you. It is checked against the
                publisher's signature before it is stored, so a key that is not genuine is never
                accepted.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || !token.trim()}>
                  {busy ? 'Checking…' : licensed ? 'Replace licence' : 'Activate licence'}
                </Button>
                {replacing ? (
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => { setReplacing(false); setToken(''); }}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}

          {licensed && !replacing ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={busy}
                      onClick={() => setReplacing(true)}>
                Replace licence
              </Button>
              <Button type="button" variant="secondary" disabled={busy}
                      onClick={() => void deactivate()}>
                Deactivate
              </Button>
            </div>
          ) : null}

          {/* A licence bound to an installation is refused on the wrong one, so
              the operator needs this id to get the right licence issued. */}
          {view.state === 'wrong_installation' || view.state === 'none' ? (
            <div className="mt-3">
              <Copyable label="This installation's ID" value={view.installationId} />
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* The unsupported-build case: steps, not a dead end. */}
      {view?.supportedBuild ? (
        <CollapsibleCard title="Install the supported build" summary="Publisher verification is required" defaultOpen>
          <p className="mt-2 text-sm text-muted-foreground">
            Licences are verified against a key that {view.supportedBuild.publisher} stamps into the
            image it publishes. This build has none, so it cannot check any licence — entering one
            here would not help. Your data is not affected by switching.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {view.supportedBuild.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="mt-2">
            <Copyable label="Image to use" value={view.supportedBuild.image} />
          </div>
          <p className="mt-2 text-sm">
            <a className="underline" href={view.supportedBuild.docs} target="_blank" rel="noreferrer noopener">
              Installation guide
            </a>
          </p>
        </CollapsibleCard>
      ) : null}

      {licensed ? (
        <CollapsibleCard title="Manage parental controls" summary="Add children, schedules, limits, and review activity" defaultOpen>
          <p className="mt-2 text-sm text-muted-foreground">
            The licence is active. Child accounts, schedules, daily limits, usage, and conversation
            access are managed from the Family page in your workspace.
          </p>
          <Link
            to="/app/family"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Family controls
          </Link>
        </CollapsibleCard>
      ) : null}
    </div>
  );
}
