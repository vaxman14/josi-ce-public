// Signing the Codex CLI in, from inside a container nobody has a shell into.
//
// Phase 13.3 built the provider and told the operator to run `codex login` in
// their own terminal. On a Docker installation that instruction cannot be
// followed: the binary that matters is inside the container, the operator is
// outside it, and a login performed on the host signs in a CLI the application
// will never run. That is the launch blocker the N150 install found.
//
// So the wizard drives the official device-code flow instead. It:
//
//   * runs `codex login --device-auth`, which is the CLI's own documented
//     headless sign-in;
//   * reads the verification URL and one-time code the CLI PRINTS, and shows
//     them to the operator;
//   * waits for the CLI to finish, which it does when the operator has
//     approved the login in their browser.
//
// WHAT IT STILL REFUSES TO DO, unchanged from the provider:
//
//   * No credential is read, parsed, copied, stored or forwarded. The CLI
//     writes its own login into its own home directory and Josi never opens it.
//     A repository-wide guard fails the build on any reference to a credential
//     store.
//   * No HTTP request is made by CE. The device flow is entirely between the
//     operator's browser, the CLI, and OpenAI.
//   * The one-time code is not a credential. It is a pairing code, designed to
//     be read aloud, useless without somebody completing the flow with their
//     own ChatGPT account, and expired in fifteen minutes.
//
// The parsing below is written against the REAL output of a pinned CLI version
// and tested against a byte-for-byte capture of it. When the pin moves, that
// test is what fails.
import { spawn, type ChildProcess } from 'node:child_process';
import { assertCapability } from '@josi-ce/core';
import { LlmError } from '../types.js';
import { DEFAULT_CODEX_COMMAND } from './codexCli.js';

/** Terminal colour codes. The CLI writes them even when stdout is a pipe. */
const ANSI = /\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export interface DeviceChallenge {
  verificationUrl: string;
  userCode: string;
}

/** Pull the URL and the code out of what the CLI printed.
 *
 * Deliberately shape-based rather than line-number based: the CLI prints a
 * banner, a version, two numbered steps and a warning, and any of that may be
 * reworded between releases. A URL on `auth.openai.com` and a grouped
 * upper-case code are the two things that have to be there for the flow to be
 * followable at all.
 *
 * Returns null until BOTH have appeared — output arrives in chunks, and half a
 * challenge shown to an operator is worse than a spinner. */
export function parseDeviceChallenge(raw: string): DeviceChallenge | null {
  const text = stripAnsi(raw);

  const url = /https:\/\/[a-z0-9.-]*openai\.com\/[^\s]*/i.exec(text)?.[0];
  // Groups of 4+ upper-case alphanumerics joined by hyphens. Anchored to line
  // boundaries so a hyphenated word in prose cannot match.
  const code = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/m.exec(text)?.[1];

  if (!url || !code) return null;
  return { verificationUrl: url, userCode: code };
}

/** How long the CLI says the code lasts, in seconds, or null if it did not say. */
export function parseExpiry(raw: string): number | null {
  const match = /expires in (\d+)\s*(minute|second|hour)s?/i.exec(stripAnsi(raw));
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === 'hour' ? n * 3600 : unit === 'minute' ? n * 60 : n;
}

export type LoginState = 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';

export interface LoginSnapshot {
  state: LoginState;
  challenge: DeviceChallenge | null;
  expiresAt: string | null;
  /** Operator-facing. Never the CLI's raw output, which is not ours to relay. */
  message: string | null;
}

export interface CodexEnvironment {
  command?: string | null;
  /** The CLI's home. A dedicated per-installation volume, so a container
   * replacement does not sign the operator out. */
  codexHome?: string | null;
}

function childEnv(env: CodexEnvironment): NodeJS.ProcessEnv {
  // A deliberately narrow environment. The child gets PATH and its own home and
  // nothing else from this process — in particular no API key, which would make
  // a subscription login silently bill an API account instead.
  const out: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(env.codexHome ? { CODEX_HOME: env.codexHome } : {}),
  };
  return out;
}

/** Is the CLI present, and is it signed in?
 *
 * `codex login status` exits non-zero and prints "Not logged in" when it is
 * not, which is the whole check. */
export async function codexLoginStatus(
  env: CodexEnvironment = {},
  runner = defaultRunner,
): Promise<{ installed: boolean; signedIn: boolean; detail: string }> {
  const command = env.command || DEFAULT_CODEX_COMMAND;
  try {
    const result = await runner({
      command, args: ['login', 'status'], env: childEnv(env), timeoutMs: 20_000,
    });
    if (result.spawnError) {
      return {
        installed: false,
        signedIn: false,
        detail:
          'The Codex CLI is not present in this installation. A published Josi image includes it; '
          + 'a source build only has it if the build supplied a version to pin.',
      };
    }
    const text = stripAnsi(`${result.stdout}\n${result.stderr}`);
    if (result.code === 0 && !/not logged in/i.test(text)) {
      return { installed: true, signedIn: true, detail: 'Signed in.' };
    }
    return { installed: true, signedIn: false, detail: 'The Codex CLI is installed but not signed in.' };
  } catch {
    return { installed: false, signedIn: false, detail: 'The Codex CLI could not be run.' };
  }
}

/** One login attempt, in flight.
 *
 * Held in memory rather than in the database because it IS a running process:
 * a row describing a child that died with the container would be a row that
 * lies. A restart mid-login means starting the login again, which costs the
 * operator one click and is the honest behaviour.
 */
export class DeviceLogin {
  private child: ChildProcess | null = null;
  private buffer = '';
  private snapshot: LoginSnapshot = { state: 'starting', challenge: null, expiresAt: null, message: null };
  private startedAt = 0;

  constructor(private readonly env: CodexEnvironment = {}) {}

  get status(): LoginSnapshot {
    return this.snapshot;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Begin, and resolve once the CLI has printed something followable.
   *
   * The process keeps running after this resolves: the operator now has to go
   * and approve it, and the CLI exits when they have. */
  async start(timeoutMs = 60_000): Promise<LoginSnapshot> {
    assertCapability('subscription_auth');
    if (this.running) return this.snapshot;

    const command = this.env.command || DEFAULT_CODEX_COMMAND;
    this.buffer = '';
    this.startedAt = Date.now();
    this.snapshot = { state: 'starting', challenge: null, expiresAt: null, message: null };

    try {
      this.child = spawn(command, ['login', '--device-auth'], {
        env: childEnv(this.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      this.snapshot = {
        state: 'failed', challenge: null, expiresAt: null,
        message: 'The Codex CLI could not be started.',
      };
      return this.snapshot;
    }

    const absorb = (chunk: Buffer | string) => {
      // Bounded: a CLI that printed megabytes would otherwise be a memory leak
      // in a long-running process.
      this.buffer = (this.buffer + String(chunk)).slice(-16_384);
      if (this.snapshot.challenge) return;
      const challenge = parseDeviceChallenge(this.buffer);
      if (!challenge) return;
      const expiry = parseExpiry(this.buffer);
      this.snapshot = {
        state: 'awaiting_approval',
        challenge,
        expiresAt: expiry ? new Date(Date.now() + expiry * 1000).toISOString() : null,
        message: null,
      };
    };

    this.child.stdout?.on('data', absorb);
    this.child.stderr?.on('data', absorb);

    this.child.on('error', () => {
      this.snapshot = {
        state: 'failed', challenge: null, expiresAt: null,
        message:
          'The Codex CLI is not available in this installation, so ChatGPT sign-in cannot be '
          + 'started here.',
      };
    });

    this.child.on('exit', (code) => {
      if (this.snapshot.state === 'cancelled') return;
      this.snapshot = code === 0
        ? { state: 'signed_in', challenge: null, expiresAt: null, message: 'Signed in.' }
        : {
            state: 'failed',
            challenge: null,
            expiresAt: null,
            // The CLI's own output is not relayed: it is not ours to interpret
            // and it may quote whatever it was given.
            message:
              'The sign-in did not complete. This usually means the code expired or the browser '
              + 'step was not finished. Starting again gives a fresh code.',
          };
    });

    // Wait for something followable, or give up on the CLI ever printing it.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.snapshot.state !== 'starting') return this.snapshot;
      if (!this.running && this.snapshot.state === 'starting') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.snapshot.state === 'starting') {
      this.cancel();
      this.snapshot = {
        state: 'failed', challenge: null, expiresAt: null,
        message: 'The Codex CLI did not produce a sign-in code. Check that this server can reach the internet.',
      };
    }
    return this.snapshot;
  }

  cancel(): void {
    if (this.child && this.child.exitCode === null) {
      this.snapshot = { state: 'cancelled', challenge: null, expiresAt: null, message: 'Cancelled.' };
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }

  /** Elapsed time, for a caller that wants to age out a stalled attempt. */
  get ageMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }
}

/** Remove the stored login. The CLI owns the file; this asks it to delete it. */
export async function codexLogout(
  env: CodexEnvironment = {},
  runner = defaultRunner,
): Promise<{ ok: boolean; detail: string }> {
  assertCapability('subscription_auth');
  const command = env.command || DEFAULT_CODEX_COMMAND;
  const result = await runner({
    command, args: ['logout'], env: childEnv(env), timeoutMs: 20_000,
  });
  if (result.spawnError) return { ok: false, detail: 'The Codex CLI is not available in this installation.' };
  return result.code === 0
    ? { ok: true, detail: 'Signed out. The stored login was removed by the CLI.' }
    : { ok: false, detail: 'The CLI did not confirm that it signed out.' };
}

// ------------------------------------------------------------------- runner

export interface SimpleRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the binary could not be executed at all. */
  spawnError: boolean;
}

export type SimpleRunner = (args: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<SimpleRunResult>;

const defaultRunner: SimpleRunner = ({ command, args, env, timeoutMs }) =>
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
    const finish = (result: SimpleRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr, spawnError: false });
    }, timeoutMs);

    child.stdout?.on('data', (c) => { stdout = (stdout + String(c)).slice(-16_384); });
    child.stderr?.on('data', (c) => { stderr = (stderr + String(c)).slice(-16_384); });
    child.on('error', () => finish({ code: null, stdout, stderr, spawnError: true }));
    child.on('exit', (code) => finish({ code, stdout, stderr, spawnError: false }));
  });

export class SubscriptionLoginError extends LlmError {}
