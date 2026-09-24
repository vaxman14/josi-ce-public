// Building a database connection from the environment.
//
// The password comes from a file, not from DATABASE_URL and not from PGPASSWORD.
// An environment variable holding a credential is printed by `docker inspect`,
// inherited by every child process, and captured by anything that dumps the
// environment on a crash.
import { readFileSync } from 'node:fs';
import { postgresDb, type Db } from './db.js';

export class ConnectionConfigError extends Error {}

/** Assembles the connection string, injecting the password from
 * `PGPASSWORD_FILE` when present. Never logs the result. */
export function connectionStringFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new ConnectionConfigError('DATABASE_URL is required');

  const passwordFile = env.PGPASSWORD_FILE;
  if (!passwordFile) return url;

  let password: string;
  try {
    password = readFileSync(passwordFile, 'utf8').trim();
  } catch {
    throw new ConnectionConfigError(`could not read the database password from ${passwordFile}`);
  }
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** A description of the connection that is safe to log: host and database, no
 * user, no password, no query string. */
export function describeConnection(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

export interface ConnectResult {
  db: Db;
  close: () => Promise<void>;
  describe: string;
}

/** Opens a pool. `postgres` is imported dynamically so that packages depending
 * on core for pure logic — and the test suite, which uses pglite — never pull
 * the driver in. */
export async function connectFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { max?: number } = {},
): Promise<ConnectResult> {
  const connectionString = connectionStringFromEnv(env);
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, {
    max: opts.max ?? 10,
    prepare: false,
    onnotice: () => {},
  });
  return {
    db: postgresDb(sql),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
    describe: describeConnection(connectionString),
  };
}
