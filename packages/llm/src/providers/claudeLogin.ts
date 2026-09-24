// Signing Claude Code in, from inside a container nobody has a shell into.
//
// This is the Codex story again with one real difference, and the difference is
// not cosmetic.
//
//   Codex  — `codex login --device-auth` prints a URL AND a one-time code, then
//            polls by itself. The operator approves in a browser and the CLI
//            exits on its own.
//
//   Claude — `claude auth login --claudeai` prints a URL and then WAITS ON
//            STDIN for a code the operator brings back from the browser. It
//            cannot finish without that paste.
//
// So this driver has a step the Codex one does not: `submitCode`. Pretending
// the two flows were identical would produce a screen that spins forever while
// a child process sits blocked on a read.
//
// WHAT THIS DOES NOT DO, and the list is the point:
//
//   * It does not implement Claude.ai OAuth. There is no client id here, no
//     redirect handler, no callback route, no PKCE verifier. The URL is the one
//     Anthropic's own binary printed, and it is shown, not followed.
//   * It does not read, parse, copy, store, forward or refresh any credential.
//     The CLI writes its own login into its own configuration directory and
//     Josi never opens it. The repository-wide guard in
//     `packages/llm/test/subscription.test.ts` fails the build on any reference
//     to a credential store.
//   * It does not authenticate on anybody's behalf. The one-time code is
//     carried by the operator from their own browser session; Josi is the pipe
//     between their paste and the vendor's process, and nothing else.
//   * It makes no HTTP request. CE speaks to no Anthropic endpoint on this
//     path.
//
// The code is not a credential. It is a pairing code — single use, short lived,
// worthless without somebody completing the flow with their own Anthropic
// account — which is why it is safe to display and why it is never stored.
//
// LEGAL STATUS IS NOT SETTLED IN THIS FILE. `docs/SUBSCRIPTION_AUTH.md` records
// what Anthropic's current terms say, the date they were read, and the fact
// that counsel review is outstanding before this is represented as permitted in
// a public release. See FI-006 in `docs/FIRST_INSTALL_FINDINGS.md`. This file
// implements the mechanism Anthropic documents; it does not assert a verdict.
import { spawn, type ChildProcess } from 'node:child_process';
import { assertCapability } from '@josi-ce/core';
import { DEFAULT_CLAUDE_COMMAND } from './claudeCli.js';

/**
 * Terminal decoration, removed before anything is matched.
 *
 * OSC-8 hyperlinks matter here and a plain CSI stripper is not enough. The CLI
 * prints `ESC]8;;<url>BEL<visible url>ESC]8;;BEL`, so the URL appears TWICE
 * with no whitespace between the two copies. A naive `https://[^\s]*` match
 * against that returns both concatenated into one unusable string. Removing the
 * hyperlink target first leaves exactly one URL to find.
 */
export function stripTerminalDecoration(raw: string): string {
  return raw
    // OSC-8 hyperlink target: ESC ] 8 ; ; <url> terminated by BEL or ST.
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Any other OSC sequence.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI / SGR colour and cursor codes.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export interface ClaudeChallenge {
  /** Where the operator has to go and sign in. */
  verificationUrl: string;
}

/**
 * Find the authorize URL the CLI printed.
 *
 * Shape-based rather than line-based on purpose: the wording around it ("Opening
 * browser to sign in…", "If the browser didn't open, visit:") is presentation
 * and may be reworded in any release. An `authorize` URL on an Anthropic host is
 * the thing that has to be there for the flow to be followable at all.
 */
export function parseAuthorizeUrl(raw: string): ClaudeChallenge | null {
  const text = stripTerminalDecoration(raw);
  const url = /https:\/\/[a-z0-9.-]*(?:claude\.com|claude\.ai|anthropic\.com)\/[^\s"'<>]*/i.exec(text)?.[0];
  if (!url) return null;
  return { verificationUrl: url };
}

/** Has the CLI reached the point where it wants the code? */
export function isAwaitingCode(raw: string): boolean {
  return /paste code here|enter the code|authorization code/i.test(stripTerminalDecoration(raw));
}

export type ClaudeLoginState =
  | 'starting'
  /** URL shown; the operator is in their browser and has not pasted yet. */
  | 'awaiting_code'
  /** Code handed to the CLI; the CLI is exchanging it. */
  | 'verifying'
  | 'signed_in'
  | 'failed'
  | 'cancelled';

export interface ClaudeLoginSnapshot {
  state: ClaudeLoginState;
  challenge: ClaudeChallenge | null;
  /** Operator-facing. Never the CLI's raw output, which is not ours to relay. */
  message: string | null;
}

export interface ClaudeEnvironment {
  command?: string | null;
  /** The CLI's own configuration directory. A dedicated per-installation
   * volume, so replacing the container — which is what an update does — does
   * not sign the operator out. */
  configDir?: string | null;
}

function childEnv(env: ClaudeEnvironment): NodeJS.ProcessEnv {
  // Deliberately narrow: PATH, HOME, the CLI's own config directory, and
  // nothing else. In particular no ANTHROPIC_API_KEY — the CLI prefers a key
  // when it finds one, and "sign in with my subscription" that quietly attached
  // an API account would be the exact misrepresentation this path exists not to
  // commit.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NO_COLOR: '1',
    ...(env.configDir ? { CLAUDE_CONFIG_DIR: env.configDir } : {}),
  };
}

export interface ClaudeAuthStatus {
  installed: boolean;
  signedIn: boolean;
  /** `claudeai` for a subscription, `console` for API billing, `none` when out. */
  authMethod: string;
  detail: string;
}

/**
 * Is the CLI present, and signed in with what?
 *
 * `claude auth status --json` EXITS ZERO WHETHER OR NOT IT IS SIGNED IN, and
 * reports the answer in the payload. Checking the exit code — the obvious thing,
 * and what the Codex equivalent legitimately does — would report every signed-out
 * installation as signed in.
 */
export async function claudeAuthStatus(
  env: ClaudeEnvironment = {},
  runner = defaultRunner,
): Promise<ClaudeAuthStatus> {
  const command = env.command || DEFAULT_CLAUDE_COMMAND;
  const absent: ClaudeAuthStatus = {
    installed: false, signedIn: false, authMethod: 'none',
    detail:
      'The Claude Code CLI is not present in this installation. A published Josi image includes '
      + 'it; a source build only has it if the build supplied a version to pin.',
  };
  try {
    const result = await runner({
      command, args: ['auth', 'status', '--json'], env: childEnv(env), timeoutMs: 20_000,
    });
    if (result.spawnError) return absent;

    const text = stripTerminalDecoration(result.stdout);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      return {
        installed: true, signedIn: false, authMethod: 'unknown',
        detail: 'The Claude Code CLI did not report its status in a form Josi could read.',
      };
    }
    let payload: { loggedIn?: unknown; authMethod?: unknown };
    try {
      payload = JSON.parse(text.slice(start, end + 1)) as typeof payload;
    } catch {
      return {
        installed: true, signedIn: false, authMethod: 'unknown',
        detail: 'The Claude Code CLI did not report its status in a form Josi could read.',
      };
    }

    const signedIn = payload.loggedIn === true;
    const authMethod = typeof payload.authMethod === 'string' ? payload.authMethod : 'unknown';
    return {
      installed: true,
      signedIn,
      authMethod,
      detail: signedIn
        ? authMethod === 'console'
          ? 'Signed in to an Anthropic Console account, which bills API usage rather than using a '
            + 'Claude subscription.'
          : 'Signed in with a Claude subscription.'
        : 'The Claude Code CLI is installed but not signed in.',
    };
  } catch {
    return { ...absent, detail: 'The Claude Code CLI could not be run.' };
  }
}

/**
 * One login attempt, in flight.
 *
 * Held in memory rather than in the database, exactly as the Codex login is:
 * it IS a running process, and a row describing a child that died with the
 * container would be a row that lies. A restart mid-login costs one fresh code.
 */
export class ClaudeLogin {
  private child: ChildProcess | null = null;
  private buffer = '';
  private snapshot: ClaudeLoginSnapshot = { state: 'starting', challenge: null, message: null };
  private startedAt = 0;

  constructor(private readonly env: ClaudeEnvironment = {}) {}

  get status(): ClaudeLoginSnapshot {
    return this.snapshot;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  get ageMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  /** Begin, and resolve once the CLI has printed a URL worth showing.
   *
   * The process keeps running after this resolves. It is blocked on stdin,
   * waiting for `submitCode`. */
  async start(timeoutMs = 60_000): Promise<ClaudeLoginSnapshot> {
    assertCapability('subscription_auth');
    if (this.running) return this.snapshot;

    const command = this.env.command || DEFAULT_CLAUDE_COMMAND;
    this.buffer = '';
    this.startedAt = Date.now();
    this.snapshot = { state: 'starting', challenge: null, message: null };

    try {
      // stdin is a PIPE, unlike the Codex login which ignores it. That is the
      // whole difference between the two flows.
      this.child = spawn(command, ['auth', 'login', '--claudeai'], {
        env: childEnv(this.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      this.snapshot = {
        state: 'failed', challenge: null,
        message: 'The Claude Code CLI could not be started.',
      };
      return this.snapshot;
    }

    const absorb = (chunk: Buffer | string) => {
      // Bounded: a CLI printing megabytes would be a memory leak in a
      // long-running process.
      this.buffer = (this.buffer + String(chunk)).slice(-16_384);
      if (this.snapshot.state !== 'starting') return;
      const challenge = parseAuthorizeUrl(this.buffer);
      if (!challenge) return;
      this.snapshot = { state: 'awaiting_code', challenge, message: null };
    };

    this.child.stdout?.on('data', absorb);
    this.child.stderr?.on('data', absorb);

    this.child.on('error', () => {
      this.snapshot = {
        state: 'failed', challenge: null,
        message:
          'The Claude Code CLI is not available in this installation, so Claude sign-in cannot be '
          + 'started here.',
      };
    });

    this.child.on('exit', (code) => {
      if (this.snapshot.state === 'cancelled') return;
      this.snapshot = code === 0
        ? { state: 'signed_in', challenge: null, message: 'Signed in.' }
        : {
            state: 'failed',
            challenge: null,
            // The CLI's own output is not relayed: it is not ours to interpret
            // and it may quote whatever it was given.
            message:
              'The sign-in did not complete. This usually means the code was mistyped or had '
              + 'expired. Starting again gives a fresh link.',
          };
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.snapshot.state !== 'starting') return this.snapshot;
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.snapshot.state === 'starting') {
      this.cancel();
      this.snapshot = {
        state: 'failed', challenge: null,
        message:
          'The Claude Code CLI did not produce a sign-in link. Check that this server can reach '
          + 'the internet.',
      };
    }
    return this.snapshot;
  }

  /**
   * Hand the CLI the code the operator brought back.
   *
   * Written to the child's stdin and referenced nowhere else: not logged, not
   * stored, not returned. It is single-use and belongs to Anthropic's exchange,
   * not to Josi.
   */
  submitCode(code: string): ClaudeLoginSnapshot {
    if (!this.running || !this.child?.stdin) {
      this.snapshot = {
        state: 'failed', challenge: null,
        message: 'That sign-in is no longer running. Start it again to get a fresh link.',
      };
      return this.snapshot;
    }
    // A newline is what the prompt is waiting for. Trimmed because a paste from
    // a browser routinely carries surrounding whitespace.
    const trimmed = code.trim();
    if (!trimmed) {
      this.snapshot = { ...this.snapshot, message: 'Enter the code shown after you approve the sign-in.' };
      return this.snapshot;
    }
    this.child.stdin.write(`${trimmed}\n`);
    this.snapshot = { state: 'verifying', challenge: this.snapshot.challenge, message: null };
    return this.snapshot;
  }

  cancel(): void {
    if (this.child && this.child.exitCode === null) {
      this.snapshot = { state: 'cancelled', challenge: null, message: 'Cancelled.' };
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }
}

/** Remove the stored login. The CLI owns the file; this asks it to delete it. */
export async function claudeLogout(
  env: ClaudeEnvironment = {},
  runner = defaultRunner,
): Promise<{ ok: boolean; detail: string }> {
  assertCapability('subscription_auth');
  const command = env.command || DEFAULT_CLAUDE_COMMAND;
  const result = await runner({
    command, args: ['auth', 'logout'], env: childEnv(env), timeoutMs: 20_000,
  });
  if (result.spawnError) {
    return { ok: false, detail: 'The Claude Code CLI is not available in this installation.' };
  }
  return result.code === 0
    ? { ok: true, detail: 'Signed out. The stored login was removed by the CLI.' }
    : { ok: false, detail: 'The CLI did not confirm that it signed out.' };
}

// ------------------------------------------------------------------- runner

export interface ClaudeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary could not be executed at all. */
  spawnError: boolean;
}

export type ClaudeRunner = (args: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<ClaudeRunResult>;

const defaultRunner: ClaudeRunner = ({ command, args, env, timeoutMs }) =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', spawnError: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ClaudeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, spawnError: false });
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout = (stdout + String(c)).slice(-65_536); });
    child.stderr?.on('data', (c) => { stderr = (stderr + String(c)).slice(-16_384); });
    child.on('error', () => finish({ code: null, stdout, stderr, spawnError: true }));
    child.on('exit', (code) => finish({ code, stdout, stderr, spawnError: false }));
  });
