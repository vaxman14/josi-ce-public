#!/usr/bin/env node
// Migration runner. PostgreSQL only, over a normal connection — there is no
// hosted management API in the picture, because CE runs on the operator's own
// database.
//
// Each file runs inside a transaction together with the row that records it, so
// a migration either lands completely or not at all. A half-applied schema is
// the failure mode this is built to make impossible.
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** The database password is read from a file for the same reason the master key
 * is: an environment variable is visible in `docker inspect` and inherited by
 * every child process. */
function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const passwordFile = process.env.PGPASSWORD_FILE;
  if (!passwordFile) return url;

  let password;
  try {
    password = readFileSync(passwordFile, 'utf8').trim();
  } catch {
    console.error(`could not read the database password from ${passwordFile}`);
    process.exit(1);
  }
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

const sql = postgres(connectionString(), { max: 1, prepare: false, onnotice: () => {} });

try {
  await sql`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;

  const applied = new Set((await sql`select name from _migrations`).map((r) => r.name));
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const body = readFileSync(join(MIGRATIONS, file), 'utf8');
    console.log(`apply ${file}`);
    // All or nothing, including the bookkeeping row.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into _migrations (name) values (${file})`;
    });
    ran++;
  }

  console.log(ran ? `migrations complete (${ran} applied)` : 'migrations complete (nothing to do)');
  await sql.end();
  process.exit(0);
} catch (err) {
  // The message may name a table or a constraint, which is fine in a log the
  // operator reads. It never contains the password: that came from a file and
  // was only ever placed into the connection URL.
  console.error('migration failed:', err?.message ?? err);
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}
