// Connecting a Claude subscription, in the wizard and in Admin → Model.
//
// One component, two mounts, because the flow is identical in both places and
// two copies would drift. `basePath` is the only difference: the wizard's routes
// disappear when setup completes, the admin ones do not.
//
// THE SHAPE OF THIS SCREEN IS DICTATED BY THE CLI, not by preference. Anthropic's
// `claude auth login` prints a link and then BLOCKS waiting for a code on its
// standard input. So there are two steps here and the second one is an input
// box — unlike the ChatGPT flow next to it, where the CLI polls by itself and
// the operator never types anything back. A single "connect" button that spun
// forever would be the honest-looking version of a broken screen.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorNote } from '@/components/ui';

export interface ClaudeCliStatus {
  installed: boolean;
  signedIn: boolean;
  authMethod: string;
  detail: string;
}

interface ClaudeLoginState {
  state: 'idle' | 'starting' | 'awaiting_code' | 'verifying' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string } | null;
  message: string | null;
}

export function ClaudeSignIn({ basePath }: { basePath: string }) {
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
  const [login, setLogin] = useState<ClaudeLoginState | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = () =>
    api.get<{ cli: ClaudeCliStatus }>(`${basePath}/status`).then((r) => setStatus(r.cli));

  useEffect(() => { void loadStatus().catch(() => undefined); }, [basePath]);

  // Polled only while the CLI is still deciding. `awaiting_code` is NOT polled:
  // nothing changes until the operator pastes something, and a spinner during a
  // step that is waiting on the person would be telling them to wait for
  // themselves.
  useEffect(() => {
    if (login?.state !== 'verifying' && login?.state !== 'starting') return;
    const timer = setInterval(() => {
      void api.get<ClaudeLoginState>(`${basePath}/login`)
        .then((next) => {
          setLogin(next);
          if (next.state === 'signed_in') void loadStatus();
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [login?.state, basePath]);

  async function start() {
    setBusy(true);
    setError('');
    setCode('');
    try {
      setLogin(await api.post<ClaudeLoginState>(`${basePath}/login`, {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claude sign-in could not be started');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const next = await api.post<ClaudeLoginState>(`${basePath}/login/code`, { code });
      setLogin(next);
      setCode('');
      if (next.state === 'signed_in') await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api.post(`${basePath}/logout`, {});
      setLogin(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claude could not be disconnected');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="text-sm text-muted-foreground">Checking Claude Code…</p>;
  if (!status.installed) return <ErrorNote>{status.detail}</ErrorNote>;

  if (status.signedIn) {
    return (
      <div className="space-y-2 rounded-md border border-input p-3">
        <p className="text-sm font-medium">
          {/* Which account, not merely "connected". Signing in to a Console
              account bills API usage — that is a different arrangement from a
              subscription and the operator has to be able to tell. */}
          {status.authMethod === 'console'
            ? 'Connected to an Anthropic Console account'
            : 'Connected to your Claude subscription'}
        </p>
        <p className="text-xs text-muted-foreground">{status.detail}</p>
        <p className="text-xs text-muted-foreground">
          Josi will send one real message before treating this as working. Everyone on this
          installation shares your plan and its limits, no cost is reported, and tools work once the
          model test confirms them.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void disconnect()}>
          {busy ? 'Disconnecting…' : 'Disconnect Claude'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {login?.challenge ? (
        <>
          <p className="text-sm">
            1. Open{' '}
            <a href={login.challenge.verificationUrl} target="_blank" rel="noreferrer" className="underline">
              this Anthropic sign-in link
            </a>{' '}
            and approve it.
          </p>
          <p className="text-sm">2. Anthropic shows you a code. Paste it here:</p>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code from Anthropic"
              autoComplete="off"
              spellCheck={false}
              className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
            />
            <Button type="button" disabled={busy || !code.trim()} onClick={() => void submit()}>
              {busy ? 'Checking…' : 'Finish'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Only continue if you started this here. If somebody sent you this link, stop.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            You will get a link to approve in your own browser, and Anthropic will show you a code
            to paste back. Josi never sees your password and never stores your login — Anthropic's
            own CLI keeps it, on this server.
          </p>
          <Button type="button" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Connect Claude'}
          </Button>
        </>
      )}

      {login?.state === 'failed' ? <ErrorNote>{login.message ?? 'Sign-in failed.'}</ErrorNote> : null}
      {login?.state === 'verifying' ? (
        <p className="text-xs text-muted-foreground">Checking that code with Anthropic…</p>
      ) : null}
    </div>
  );
}
