// Read the signed-in Codex CLI's own visible model list. No API credential,
// credential-file read, or guessed model catalogue enters this path.
import { spawn } from 'node:child_process';
import { DEFAULT_CODEX_COMMAND } from './codexCli.js';

export interface CodexListedModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  hidden: boolean;
}

/** A deliberately narrow subprocess environment: the CLI finds its own login
 * in CODEX_HOME, but never inherits an API key or Josi's database secrets. */
function modelListEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [
    'PATH', 'HOME', 'USER', 'CODEX_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', CI: '1' };
  for (const key of keys) {
    if (parent[key]) env[key] = parent[key];
  }
  return env;
}

/** Speak the pinned Codex app-server's JSONL protocol, then exit. The response
 * is only a set of candidates; the existing real model probe decides whether
 * one can be activated on this person's plan. */
export function listCodexModels(
  opts: { command?: string | null; timeoutMs?: number } = {},
): Promise<CodexListedModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.command || DEFAULT_CODEX_COMMAND, ['app-server', '--stdio'], {
      env: modelListEnvironment(), stdio: ['pipe', 'pipe', 'ignore'],
    });
    let finished = false;
    let buffer = '';
    const finish = (models?: CodexListedModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      if (models) resolve(models);
      else reject(new Error('Codex model listing unavailable'));
    };
    const timer = setTimeout(() => finish(), Math.min(Math.max(opts.timeoutMs ?? 20_000, 1_000), 30_000));
    const send = (message: Record<string, unknown>) => {
      try { child.stdin.write(`${JSON.stringify(message)}\n`); }
      catch { finish(); }
    };
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', (data: Buffer) => {
      if (finished) return;
      buffer += data.toString('utf8');
      if (buffer.length > 1024 * 1024) { finish(); return; }
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let response: Record<string, unknown>;
        try { response = JSON.parse(line) as Record<string, unknown>; }
        catch { continue; }
        if (response.id === 1) {
          if (response.error) { finish(); return; }
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'model/list', params: { includeHidden: false } });
        } else if (response.id === 2) {
          const result = response.result as { data?: unknown } | undefined;
          if (response.error || !Array.isArray(result?.data)) { finish(); return; }
          const models: CodexListedModel[] = [];
          const seen = new Set<string>();
          for (const raw of result.data.slice(0, 200)) {
            if (!raw || typeof raw !== 'object') continue;
            const row = raw as Record<string, unknown>;
            const id = typeof row.id === 'string' ? row.id.trim() : '';
            if (!id || id.length > 120 || /[\x00-\x1f]/.test(id) || row.hidden === true || seen.has(id)) continue;
            seen.add(id);
            models.push({
              id,
              displayName: typeof row.displayName === 'string' && row.displayName.trim()
                ? row.displayName.trim().slice(0, 120) : id,
              isDefault: row.isDefault === true,
              hidden: false,
            });
          }
          finish(models);
          return;
        }
      }
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'josi_ce', title: 'Josi CE', version: '0.1.0' },
    } });
  });
}
