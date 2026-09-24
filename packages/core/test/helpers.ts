import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgliteDb, type Db } from '../src/db.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export interface TestDb extends Db {
  exec(sql: string): Promise<void>;
}

/** Fresh in-memory PostgreSQL with every real migration applied, in order.
 * Tests run the same SQL a real installation runs, so a migration that breaks
 * the schema breaks the suite before anyone deploys it. */
export async function testDb(): Promise<TestDb> {
  const pg = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return { ...pgliteDb(pg), exec: async (sql: string) => void (await pg.exec(sql)) };
}
