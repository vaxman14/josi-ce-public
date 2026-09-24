// The real backup writer: pg_dump in, psql out.
//
// Injected everywhere else so the suite never shells out. This is the
// production implementation, and it exists because a backup feature that
// returns 503 in production while passing its tests against a stub is not a
// backup feature — it is a test suite with a UI.
//
// WHAT IS AND IS NOT IN THE ARCHIVE
//
// The dump carries every table, including the columns holding sealed
// credentials. Those stay CIPHERTEXT: the master key is a file outside the
// database, this process never reads it, and there is no code path here that
// could put it in the archive. That is M100, and it is why restoring without
// the key gives you your data and not your credentials.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BackupError, type BackupContents, type BackupKind, type BackupWriter } from './backup.js';
import { RestoreError, type RestoreReader } from './backup.js';

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Read from a file at call time and passed through the environment to the
   * child only. Never logged, never stored, never part of an error. */
  password?: string;
}

/** Tables whose contents are derived and enormous, excluded from a PORTABLE
 * export. A full backup keeps everything.
 *
 * This is not a privacy decision — the data is the owner's either way — it is a
 * size one: an export somebody actually wants to move somewhere should not carry
 * N copies of every document. */
const PORTABLE_EXCLUDES = [
  'document_versions',
  'document_embeddings',
  'processing_jobs',
];

function run(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new BackupError('the backup timed out', 'timeout'));
    }, opts.timeoutMs ?? 10 * 60_000);

    child.stdout.on('data', (d: Buffer) => out.push(d));
    // Kept only to classify. It is never returned to a caller or logged,
    // because pg_dump's stderr quotes connection strings and table contents.
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? 1 });
    });
    if (opts.input) { child.stdin.write(opts.input); child.stdin.end(); }
    else child.stdin.end();
  });
}

/** Map a failure to a category without letting the message escape. */
function classify(stderr: string): 'disk_full' | 'permission_denied' | 'database_unavailable' | 'unknown' {
  const s = stderr.toLowerCase();
  if (s.includes('no space left')) return 'disk_full';
  if (s.includes('permission denied') || s.includes('authentication failed')) return 'permission_denied';
  if (s.includes('could not connect') || s.includes('connection refused')) return 'database_unavailable';
  // pg_dump refuses to dump a server newer than itself. It presents as a
  // generic failure, which sent a real run looking in the wrong place; the
  // database is reachable and the tool is simply too old to read it.
  if (s.includes('server version') && s.includes('aborting')) return 'database_unavailable';
  return 'unknown';
}

export function pgBackupWriter(conn: PgConnection): BackupWriter {
  const baseArgs = [
    '-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.database,
  ];
  const env = conn.password ? { PGPASSWORD: conn.password } : {};

  return {
    async write({ kind, contents, destination }: {
      kind: BackupKind; contents: BackupContents; destination: string;
    }) {
      const args = [...baseArgs, '--no-owner', '--no-privileges', '--clean', '--if-exists'];
      if (kind === 'portable') {
        for (const table of PORTABLE_EXCLUDES) args.push('--exclude-table-data', table);
      }
      void contents;

      let result;
      try {
        result = await run('pg_dump', args, { env });
      } catch (e) {
        if (e instanceof BackupError) throw e;
        throw new BackupError('pg_dump could not be started', 'unknown');
      }
      if (result.code !== 0) {
        throw new BackupError('the database could not be dumped', classify(result.stderr));
      }

      // Compressed, because M109-style size limits and ordinary disks both
      // matter, and a SQL dump compresses by roughly ten to one.
      const compressed = gzipSync(result.stdout, { level: 6 });
      try {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, compressed, { mode: 0o600 });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        throw new BackupError(
          'the backup could not be written',
          code === 'ENOSPC' ? 'disk_full' : code === 'EACCES' ? 'permission_denied' : 'unknown',
        );
      }

      const st = await stat(destination);
      return {
        byteSize: st.size,
        sha256: createHash('sha256').update(compressed).digest('hex'),
      };
    },

    async read(path: string) {
      return readFile(path);
    },

    async remove(path: string) {
      await rm(path, { force: true });
    },
  };
}

/** Applies an archive produced by `pgBackupWriter`.
 *
 * `--single-transaction` so a failed restore leaves the database as it was
 * rather than half-replaced, which is the difference between a failed restore
 * and a destroyed installation. */
export function pgRestoreReader(conn: PgConnection): RestoreReader {
  const env = conn.password ? { PGPASSWORD: conn.password } : {};
  return {
    async apply({ archive }: { archive: Buffer }) {
      let sql: Buffer;
      try {
        sql = gunzipSync(archive);
      } catch {
        throw new RestoreError('that file is not a Josi backup', 'archive_corrupt');
      }

      const result = await run('psql', [
        '-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.database,
        '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', '-',
      ], { env, input: sql });

      if (result.code !== 0) {
        const s = result.stderr.toLowerCase();
        throw new RestoreError(
          'the backup could not be applied',
          s.includes('could not connect') ? 'database_unavailable' : 'archive_corrupt',
        );
      }

      // How much came back, counted rather than claimed.
      const counted = await run('psql', [
        '-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.database,
        '-tAc', 'select count(*) from users',
      ], { env });
      const rows = Number.parseInt(counted.stdout.toString().trim(), 10);
      return { rowsRestored: Number.isFinite(rows) ? rows : 0 };
    },
  };
}

/** Whether the tools are actually present, so the API can say "backups are not
 * available on this installation" honestly rather than failing at write time. */
export async function pgToolsAvailable(): Promise<boolean> {
  try {
    const r = await run('pg_dump', ['--version'], { timeoutMs: 10_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}
