// Claude subscription inference, by delegation to Anthropic's own binary.
//
// The Codex story, told again for Claude, and the same refusals apply.
//
// It runs `claude --print` — Anthropic's own first-party CLI, in the
// non-interactive mode Anthropic documents — as a subprocess, using whatever
// login the operator established through the CLI's own `auth login` flow.
//
// It does NOT:
//
//   * implement "Sign in with Claude". There is no OAuth client here, no
//     redirect, no callback, no token.
//   * read the CLI's own credential file, a keychain, a browser profile or a
//     cookie jar. Nothing in this file opens a credential store.
//   * store, copy, forward, refresh or expire anything.
//   * make an HTTP request. CE speaks to no Anthropic endpoint on this path.
//
// Scraping a session is impersonation; running the vendor's own signed-in
// binary on the machine its owner signed in on is delegation. The second is
// what the CLI is for.
//
// WHY IT IS CE-ONLY — the same reason as Codex. A personal Claude plan is for
// an individual, not for powering a commercial service, so the gate is the
// edition stamped into the build rather than a setting. `assertCapability`
// consults it and a hosted artefact cannot reach this code at all.
//
// LEGAL STATUS IS NOT SETTLED HERE. `docs/SUBSCRIPTION_AUTH.md` records the
// terms, the date they were read, and that counsel review is outstanding before
// this is represented as permitted in a public release (FI-006). This file
// implements the mechanism; it does not assert a verdict.
//
// WHAT IT COSTS THE PRODUCT, stated as plainly as the Codex path states it:
//
//   * It is PER INSTALLATION, not per user. Everyone on the installation shares
//     the operator's plan and the operator's rolling limits.
//   * It reports REAL TOKEN COUNTS — unlike Codex, which reports none — but no
//     per-call cost, because a flat monthly fee has none. Usage rows record
//     `subscription` as the charge basis and zero as the amount.
//   * Tool calling exists ONLY through the MCP harness (see `harness.ts`): the
//     CLI's built-in tools stay denied by name, and the one thing allowed is
//     Josi's own MCP server, whose tools enforce Josi's own step-up policy.
//     Without the harness in the image, every tool is denied and Josi can talk
//     but cannot act on this path — and the probe says so.
import { spawn } from 'node:child_process';
import { assertCapability } from '@josi-ce/core';
import {
  MCP_SERVER_NAME, openHarnessSession, readExecutedCalls, resolveMcpServerPath, writeClaudeMcpConfig,
  type HarnessSession,
} from '../harness.js';
import {
  LlmError,
  type ChatRequest, type ChatResponse, type LlmProvider, type ProviderKind,
} from '../types.js';
import type { SpawnRunner } from './codexCli.js';

export const DEFAULT_CLAUDE_COMMAND = 'claude';

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Every tool the CLI ships, denied by name.
 *
 * `--print` alone does not make the session inert: Claude Code is an agent, and
 * an agent with a Bash tool running inside Josi's container would sit entirely
 * outside Josi's own permission model, which is enforced by routes reading
 * database rows. This is the counterpart of `--sandbox read-only` on the Codex
 * path.
 *
 * Denied by explicit name rather than by a single "no tools" switch because the
 * CLI has no such switch. A tool added in a future release would not be on this
 * list, which is exactly why `claudeArgs` is asserted in the test suite and why
 * the pin is exact.
 */
export const DENIED_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'SlashCommand', 'KillShell', 'BashOutput',
] as const;

export interface ClaudeCliOptions {
  model: string;
  /** Path or name of the binary. Defaults to `claude` on PATH. */
  command?: string | null;
  /** The CLI's own configuration directory — where its login lives. */
  configDir?: string | null;
  timeoutMs?: number;
  runner?: SpawnRunner;
  /** The MCP tool server entry, for the harness. `undefined` means "look in
   * the environment and the image's known location"; explicit `null` disables
   * the harness (tests use this to assert the refusal path). */
  mcpServerPath?: string | null;
}

/**
 * The environment handed to the child.
 *
 * `ANTHROPIC_API_KEY` and its relatives are REMOVED, not merely left unset.
 *
 * This is the most important function in the file, for the same reason it is on
 * the Codex path. Claude Code prefers an API key when it finds one, and this
 * server stores provider keys. If one leaked into the environment, "use my
 * subscription" would quietly bill an API account — the precise
 * misrepresentation this feature exists not to commit. Deleting the variables
 * means the child has no key to prefer and either uses the operator's login or
 * fails visibly.
 *
 * `CLAUDE_CONFIG_DIR` is the one thing deliberately KEPT: it is where the CLI's
 * own login lives, and removing it would sign the operator out on every call.
 */
export function claudeChildEnvironment(
  configDir: string | null,
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const key of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
    // An out-of-band subscription token would work, and would mean the
    // connection Josi shows in its UI is not the one it is using. Predictability
    // is worth more here than one extra way to authenticate.
    'CLAUDE_CODE_OAUTH_TOKEN',
    // Nothing in the child needs the installation's own secrets, and a
    // subprocess is the classic way an environment leaks into a log.
    'PGPASSWORD', 'PGPASSWORD_FILE', 'DATABASE_URL', 'MASTER_KEY_FILE',
    'JOSI_DISABLED_CAPABILITIES',
  ]) {
    delete env[key];
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

/**
 * The exact command line.
 *
 * Kept as its own function so a test can assert it is the documented
 * non-interactive form and nothing else. Notably absent: `--bare`, which the
 * CLI documents as making authentication "strictly ANTHROPIC_API_KEY" and
 * never reading OAuth — on a subscription path that flag would defeat the
 * entire feature.
 *
 * With a harness, the Josi MCP server is loaded from a private config file and
 * `--strict-mcp-config` refuses every other MCP server the operator's own
 * Claude setup might declare — the CLI is Josi's model transport here, not the
 * operator's dev environment. `--allowed-tools mcp__josi` scopes the allowance
 * to that one server (Claude namespaces MCP tools as `mcp__<server>__<tool>`),
 * which is safe precisely because the approval that matters — Josi's step-up
 * policy — is enforced inside the server, where the CLI cannot reach. The
 * built-in tools stay denied by name, harness or not.
 */
export function claudeArgs(model: string, mcpConfigPath?: string | null): string[] {
  return [
    '--print',
    '--output-format', 'json',
    // An empty model means 'the plan's own default': the CLI chooses, exactly
    // as it does for its interactive users. Passing --model '' would instead
    // ask for a model literally named nothing.
    ...(model ? ['--model', model] : []),
    '--permission-mode', 'manual',
    ...(mcpConfigPath
      ? ['--mcp-config', mcpConfigPath, '--strict-mcp-config', '--allowed-tools', `mcp__${MCP_SERVER_NAME}`]
      : []),
    '--disallowed-tools', ...DENIED_TOOLS,
    // The prompt goes on stdin, which keeps it out of the process table. An
    // argv is world-readable on most systems and the prompt is somebody's
    // private conversation.
  ];
}

/** Flattens a chat request into one prompt, exactly as the Codex path does. */
export function renderClaudePrompt(request: ChatRequest): string {
  const parts: string[] = [];
  if (request.system) parts.push(request.system);
  for (const message of request.messages) {
    if (!message.content) continue;
    parts.push(`${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`);
  }
  parts.push('Assistant:');
  return parts.join('\n\n');
}

export interface ClaudeResult {
  text: string;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Pull the answer out of `claude --print --output-format json`.
 *
 * THE CLI EXITS ZERO WHEN IT IS NOT SIGNED IN. It prints a normal-looking
 * result envelope with `is_error: true` and `result: "Not logged in · Please
 * run /login"`. A caller that trusted the exit code would hand that sentence to
 * a user as though the model had said it, and every mock-based test would agree
 * that it worked. `is_error` is therefore load-bearing and is checked before
 * the text is used for anything.
 */
export function parseClaudeResult(stdout: string): ClaudeResult | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  return {
    text: typeof payload.result === 'string' ? payload.result.trim() : '',
    isError: payload.is_error === true,
    // Real figures, not estimates. Cache reads and writes are input tokens the
    // plan actually accounted for, so they are counted rather than dropped.
    inputTokens:
      num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

/** Turn a refusal into something the operator can act on.
 *
 * Matched, never echoed: the CLI's output can quote the prompt it was given,
 * and the prompt is somebody's private conversation. */
export function classifyClaudeFailure(text: string, command: string): LlmError {
  const lower = text.toLowerCase();
  if (/not logged in|please run \/login|unauthorized|401|no credentials|authentication/.test(lower)) {
    return new LlmError(
      'Claude Code on this installation is not signed in. Connect your Claude subscription from '
      + 'Admin → Model, then test the model again.',
      { needsReconfiguration: true },
    );
  }
  if (/rate limit|too many requests|429|usage limit|quota|out of credit/.test(lower)) {
    return new LlmError(
      'Your Claude plan has hit its usage limit. This shares the same allowance as your own Claude '
      + 'Code sessions.',
      { retryable: true },
    );
  }
  if (/unknown option|unrecognized|not a valid|usage:/.test(lower)) {
    return new LlmError(
      `The "${command}" on this machine does not understand the options Josi uses. Update the `
      + 'Claude Code CLI, or use an Anthropic API key instead.',
      { needsReconfiguration: true },
    );
  }
  if (/network|dns|getaddrinfo|econn|timed? ?out|fetch failed/.test(lower)) {
    return new LlmError('Claude Code could not reach Anthropic.', { retryable: true });
  }
  return new LlmError(
    'Claude Code refused the request. Run it once by hand to see why.',
    { needsReconfiguration: true },
  );
}

/** The default runner. Mirrors the Codex one, including its output bound. */
const defaultRunner: SpawnRunner = ({ command, args, input, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Bounded: a runaway child streaming forever is a memory exhaustion
    // primitive exactly as a lying Content-Length is.
    const LIMIT = 4 * 1024 * 1024;
    child.stdout.on('data', (d: string) => { if (stdout.length < LIMIT) stdout += d; });
    child.stderr.on('data', (d: string) => { if (stderr.length < LIMIT) stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });

    child.stdin.on('error', () => { /* the child may exit before we finish writing */ });
    child.stdin.end(input);
  });

/**
 * Builds the provider.
 *
 * Both capabilities are asserted here as well as at the route:
 * `local_command_execution` because this spawns a process, and
 * `subscription_auth` because of what it spawns.
 */
export function claudeCliProvider(opts: ClaudeCliOptions): LlmProvider {
  assertCapability('local_command_execution');
  assertCapability('subscription_auth');

  const command = opts.command?.trim() || DEFAULT_CLAUDE_COMMAND;
  const runner = opts.runner ?? defaultRunner;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configDir = opts.configDir?.trim() || null;

  return {
    kind: 'anthropic_subscription' as ProviderKind,
    model: opts.model,
    // It reaches Anthropic, by way of Anthropic's own binary. Everything built
    // around `external` — the acknowledgement, the Local-only refusal —
    // therefore applies unchanged.
    external: true,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      // The harness path, exactly as on Codex: tools are offered to the CLI's
      // own agent loop over MCP, or — when the server is not present — refused
      // rather than silently dropped. An agent that asked for tools and got
      // prose back would report success having done nothing.
      const serverPath = opts.mcpServerPath === undefined ? resolveMcpServerPath() : opts.mcpServerPath;
      let harness: HarnessSession | null = null;
      let mcpConfigPath: string | null = null;
      if (request.tools?.length) {
        if (!serverPath) {
          throw new LlmError(
            'The Claude Code path cannot call tools on this installation — the Josi tool server is '
            + 'not available to it. Configure an API key provider for anything that acts.',
            { needsReconfiguration: true },
          );
        }
        harness = openHarnessSession({
          serverPath,
          tools: request.tools,
          toolContext: request.toolContext,
        });
        mcpConfigPath = writeClaudeMcpConfig(harness);
      }

      const started = Date.now();
      let result: Awaited<ReturnType<SpawnRunner>>;
      let executedToolCalls: ChatResponse['executedToolCalls'];
      try {
        result = await runner({
          command,
          args: claudeArgs(opts.model, mcpConfigPath),
          input: renderClaudePrompt(request),
          env: claudeChildEnvironment(configDir),
          timeoutMs,
        });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new LlmError(
            `The Claude Code CLI was not found (looked for "${command}"). A published Josi image `
            + 'includes it; otherwise use an Anthropic API key instead.',
            { needsReconfiguration: true },
          );
        }
        if (code === 'EACCES') {
          throw new LlmError(
            `"${command}" is not executable by the account Josi runs as.`,
            { needsReconfiguration: true },
          );
        }
        throw new LlmError('The Claude Code CLI could not be started.', { needsReconfiguration: true });
      } finally {
        if (harness) {
          // Read before cleanup: the calls file is the ground truth of which
          // tools genuinely reached Josi's server, recorded by our own code
          // rather than parsed out of the CLI's event stream.
          executedToolCalls = readExecutedCalls(harness.callsPath);
          harness.cleanup();
        }
      }

      if (result.timedOut) {
        throw new LlmError('Claude Code did not answer in time.', { retryable: true });
      }

      const parsed = parseClaudeResult(result.stdout);

      // Exit code FIRST only when there is no envelope to read: a non-zero exit
      // with no JSON is a plain failure.
      if (!parsed) {
        if (result.code !== 0) throw classifyClaudeFailure(result.stderr, command);
        throw new LlmError('Claude Code returned nothing Josi could read.', { retryable: true });
      }

      // The trap. A signed-out CLI exits zero and reports the refusal in here.
      if (parsed.isError || result.code !== 0) {
        throw classifyClaudeFailure(parsed.text || result.stderr, command);
      }
      if (!parsed.text) {
        throw new LlmError('Claude Code returned an empty answer.', { retryable: true });
      }

      return {
        text: parsed.text,
        // Nothing PENDING, ever: on the harness path the CLI's own loop already
        // ran the tools, and what ran is reported below as fact.
        toolCalls: [],
        ...(executedToolCalls?.length ? { executedToolCalls } : {}),
        // REAL counts, unlike the Codex path, because the CLI reports them.
        usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
        latencyMs: Date.now() - started,
        // Zero is the true per-call figure for a flat monthly fee. Inventing an
        // estimate would put a fabricated number into the usage ledger.
        reportedCostUsd: 0,
      };
    },
  };
}
