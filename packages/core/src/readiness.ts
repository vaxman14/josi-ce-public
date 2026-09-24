// Liveness and readiness, kept apart on purpose.
//
//   /health  — is this process alive? No dependencies consulted. A health check
//              that fails when the database blips causes an orchestrator to
//              restart a perfectly healthy process, which makes the outage
//              worse rather than better.
//
//   /ready   — may this instance take traffic? Database reachable, schema
//              migrated, master key present.
//
// What readiness reports is a deliberate line. An unauthenticated endpoint must
// not describe the inside of the installation: no hostnames, ports, driver
// names, versions, file paths, connection strings or error text from the
// database. It names coarse subsystems only, because an operator needs to know
// *which* thing is not ready and an attacker learns nothing useful from the
// word "database".
import type { Db } from './db.js';
import { masterKeyAvailable, type LoadOptions } from './masterKey.js';

/** Coarse, stable identifiers. This list is the entire vocabulary of the
 * readiness endpoint — anything more specific belongs in the server's own logs,
 * which are not public. */
export type ReadinessBlocker = 'database' | 'migrations' | 'master_key';

export interface ReadinessResult {
  ready: boolean;
  blockers: ReadinessBlocker[];
}

/** Tables every installation must have before it can serve anything. Their
 * absence means migrations have not run, which is a different operational
 * problem from the database being unreachable. */
const REQUIRED_TABLES = ['workspace', 'users', 'sessions', 'setup_state'];

export async function checkReadiness(
  db: Db,
  opts: { masterKey?: LoadOptions | false } = {},
): Promise<ReadinessResult> {
  const blockers: ReadinessBlocker[] = [];

  let databaseUp = false;
  try {
    await db.query('select 1');
    databaseUp = true;
  } catch {
    blockers.push('database');
  }

  if (databaseUp) {
    try {
      const rows = await db.query<{ present: string }>(
        `select count(*)::text as present from information_schema.tables
         where table_schema = 'public' and table_name = any($1::text[])`,
        [REQUIRED_TABLES],
      );
      if (Number(rows[0]?.present ?? 0) < REQUIRED_TABLES.length) blockers.push('migrations');
    } catch {
      // The database answered `select 1` but not this: treat it as unmigrated
      // rather than inventing a third state.
      blockers.push('migrations');
    }
  }

  // `false` disables the check for tests and for the migration container, which
  // legitimately runs before any key exists.
  if (opts.masterKey !== false && !masterKeyAvailable(opts.masterKey ?? {})) {
    blockers.push('master_key');
  }

  return { ready: blockers.length === 0, blockers };
}
