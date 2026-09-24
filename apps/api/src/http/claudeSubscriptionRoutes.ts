// The Claude subscription sign-in, as HTTP.
//
// One router, mounted twice: under the setup wizard while an installation is
// being built, and under Admin → Model forever afterwards. The wizard's copy
// disappears when setup completes; an administrator still needs to connect,
// reconnect, inspect and disconnect, and the Model page is where they do it.
//
// WHY THIS IS NOT THE CODEX ROUTER WITH A PARAMETER. The two flows differ in a
// way that reaches the HTTP surface: Codex prints a URL and a code and then
// polls by itself, so its client only ever reads. Claude prints a URL and then
// BLOCKS ON STDIN until the operator pastes back a code from their browser, so
// its client must also write — `POST .../login/code` exists here and has no
// Codex equivalent. Collapsing them would mean a route that is meaningless for
// half its callers.
//
// Josi never sees a credential on this path. It shows the link Anthropic's own
// binary printed, carries one single-use pairing code to that binary's stdin,
// and asks the binary what its own status is. The login itself is written by
// the CLI into CLAUDE_CONFIG_DIR, which is a durable volume so that replacing
// the container does not sign the operator out.
import { Router, type Request, type Response } from 'express';
import { ClaudeLogin, claudeAuthStatus, claudeLogout } from '@josi-ce/llm';
import { asyncRoute } from './async.js';

/** Where the CLI keeps its own login, from how this container was run. */
export function claudeEnv(): { configDir: string | null } {
  return { configDir: process.env.CLAUDE_CONFIG_DIR ?? null };
}

export interface ClaudeSubscriptionOptions {
  /** Returns false to refuse — the wizard uses it to 404 after setup completes.
   * Absent means always available, which is what the admin mount wants. */
  available?: (req: Request, res: Response) => Promise<boolean>;
}

export function claudeSubscriptionRouter(opts: ClaudeSubscriptionOptions = {}): Router {
  const r = Router();

  /** One administrator-driven login at a time, per mount.
   *
   * In memory rather than in the database because it IS a live child process:
   * a row describing a child that died with the container would be a row that
   * lies. A restart during sign-in costs one fresh link. */
  let login: ClaudeLogin | null = null;

  const guard = async (req: Request, res: Response): Promise<boolean> => {
    if (!opts.available) return true;
    if (await opts.available(req, res)) return true;
    if (!res.headersSent) res.status(404).json({ error: 'not found' });
    return false;
  };

  /** Is the CLI there, and signed in as what?
   *
   * Asked of the CLI every time rather than cached. A cached "signed in" that
   * outlived the credential is exactly the lie this page exists to avoid. */
  r.get('/status', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    return res.json({ cli: await claudeAuthStatus(claudeEnv()) });
  }));

  /** Start Anthropic's own sign-in and return the link it printed. */
  r.post('/login', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    // A second attempt supersedes the first rather than leaving two children
    // contending for one configuration directory.
    if (login?.running) login.cancel();
    login = new ClaudeLogin(claudeEnv());
    return res.json(await login.start());
  }));

  /** Poll it. */
  r.get('/login', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!login) return res.json({ state: 'idle', challenge: null, message: null });

    const snapshot = login.status;
    // Confirmed against the CLI rather than inferred from an exit code. The
    // CLI exiting zero is necessary and not sufficient.
    if (snapshot.state === 'signed_in') {
      const status = await claudeAuthStatus(claudeEnv());
      if (!status.signedIn) {
        return res.json({
          state: 'failed', challenge: null,
          message: 'The sign-in reported success but Claude Code is still not signed in. Try again.',
        });
      }
    }
    return res.json(snapshot);
  }));

  /** Hand the CLI the code the operator brought back from their browser.
   *
   * The code is written to the child's stdin and referenced nowhere else — not
   * logged, not stored, not echoed back. It is single use, short lived, and
   * belongs to Anthropic's exchange rather than to Josi. */
  r.post('/login/code', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    if (!login) {
      return res.status(409).json({
        state: 'failed', challenge: null,
        message: 'There is no sign-in in progress. Start one to get a fresh link.',
      });
    }
    const code = (req.body ?? {}) as { code?: unknown };
    if (typeof code.code !== 'string' || !code.code.trim()) {
      return res.status(400).json({ error: 'Enter the code shown after you approve the sign-in.' });
    }
    // Length-bounded before it reaches a pipe. A megabyte pasted into a child's
    // stdin is a denial of service, not a code.
    if (code.code.length > 512) {
      return res.status(400).json({ error: 'That does not look like a sign-in code.' });
    }
    return res.json(login.submitCode(code.code));
  }));

  r.post('/login/cancel', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    login?.cancel();
    login = null;
    return res.json({ ok: true });
  }));

  /** Undo it. The CLI owns the stored login; this asks it to delete it. */
  r.post('/logout', asyncRoute(async (req, res) => {
    if (!(await guard(req, res))) return;
    login?.cancel();
    login = null;
    return res.json(await claudeLogout(claudeEnv()));
  }));

  return r;
}
