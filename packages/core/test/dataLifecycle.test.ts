// Backup reach, deletion cascades, and re-runnable migrations.
//
// All three held before this file existed, and all three held BY CONSTRUCTION
// rather than because anything checked — which is the same as holding by luck
// once somebody adds a table. The launch audit said so, and this is the row it
// pointed at.
//
// What each part is really asserting:
//
//   BACKUP    `pg_dump` takes no table allow-list, so a new table is included
//             automatically. The risk is not that it is forgotten; it is that
//             somebody adds an allow-list, or excludes something from the
//             portable export that a person's own data lives in.
//
//   DELETION  Every table that holds one person's data must go when that
//             person does. A table added with the wrong cascade leaves their
//             contacts, their tombstones or their merge decisions behind, and
//             a tombstone that outlives its owner is a deletion record for a
//             user who no longer exists.
//
//   MIGRATION What stops a migration running twice is the RUNNER, which records
//             each file in `_migrations` inside the transaction that applies
//             it. So most migrations are not idempotent and do not need to be.
//             What is asserted instead: that the runner really works that way,
//             and that any migration CLAIMING idempotence — by using
//             `if not exists` — actually delivers it. A half-kept promise is
//             worse than none, and 0020 was one: `if not exists` on the tables
//             and a bare `create trigger` underneath.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '../../db/migrations');
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migrationSql = (f: string) => readFileSync(join(migrationsDir, f), 'utf8');
const allMigrations = migrationFiles.map(migrationSql).join('\n');

let db: TestDb;

beforeEach(async () => { db = await testDb(); });

/** Every table the migrations create. */
function declaredTables(): string[] {
  return [...allMigrations.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/gi)]
    .map((m) => m[1]);
}

// -------------------------------------------------------------------- backup

describe('backup reaches every table', () => {
  const writer = readFileSync(join(here, '../../ops/src/pgWriter.ts'), 'utf8');

  it('takes no table allow-list, so a new table needs no registration', () => {
    // The property that makes "is the new table backed up?" answerable without
    // a manifest. If somebody adds `--table` or `-t`, every table added after
    // that silently stops being backed up.
    expect(writer, 'pg_dump must not be given a table allow-list').not.toMatch(/'-t'|"--table"|'--table'/);
    expect(writer).toMatch(/pg_dump/);
  });

  it('excludes from the portable export only things that are not a person’s data', () => {
    // A portable export is for taking your data elsewhere. Excluding a table
    // that holds it would make the export quietly incomplete.
    const excludes = /const PORTABLE_EXCLUDES = \[([\s\S]*?)\]/.exec(writer)?.[1] ?? '';
    const tables = [...excludes.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);

    // Derived artefacts and job bookkeeping only. Anything a person typed, or
    // that came from their accounts, must travel.
    const allowedToExclude = new Set(['document_versions', 'document_embeddings', 'processing_jobs']);
    for (const table of tables) {
      expect(allowedToExclude.has(table), `${table} is excluded from the portable export`).toBe(true);
    }
  });

  it('does not exclude any contact-sync table', () => {
    const excludes = /const PORTABLE_EXCLUDES = \[([\s\S]*?)\]/.exec(writer)?.[1] ?? '';
    for (const table of [
      'contacts', 'contact_sync_origins', 'contact_links',
      'contact_tombstones', 'contact_merge_decisions',
    ]) {
      expect(excludes, `${table} must be in a portable export`).not.toContain(table);
    }
  });
});

// ------------------------------------------------------------------ deletion

describe('deleting a person takes their data with them', () => {
  /** Tables that hold data belonging to exactly one user. */
  const OWNED = [
    'contacts', 'contact_sync_origins', 'contact_links',
    'contact_tombstones', 'contact_merge_decisions',
  ];

  it('declares a cascade on every owner column', () => {
    // Read from the schema rather than from a list somebody maintains: a table
    // added with `on delete set null` would leave one person's rows attached to
    // nobody, and a tombstone with no owner is a deletion record for a user who
    // no longer exists.
    for (const table of OWNED) {
      const block = new RegExp(
        `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i',
      ).exec(allMigrations);
      const alters = [...allMigrations.matchAll(
        new RegExp(`alter\\s+table\\s+${table}\\s+add\\s+column[^;]*owner_user_id[^;]*;`, 'gi'),
      )].join('\n');
      const source = `${block?.[1] ?? ''}\n${alters}`;
      if (!/owner_user_id/.test(source)) continue;
      expect(
        /owner_user_id[^,]*references\s+users\s*\(id\)\s*on\s+delete\s+cascade/i.test(source),
        `${table}.owner_user_id must cascade when the user is deleted`,
      ).toBe(true);
    }
  });

  it('actually removes every row, proven by deleting a user', async () => {
    const alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
    const bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;

    // A full set of rows for each of them, written directly so the test does
    // not depend on the sync engine to reach every table.
    for (const owner of [alice, bob]) {
      const [contact] = await db.query<{ id: string }>(
        `insert into contacts (owner_user_id, name) values ($1, 'Someone') returning id`, [owner],
      );
      const [other] = await db.query<{ id: string }>(
        `insert into contacts (owner_user_id, name) values ($1, 'Someone Else') returning id`, [owner],
      );
      const [connection] = await db.query<{ id: string }>(
        `insert into connections (owner_user_id, provider, granted_scopes, status)
         values ($1, 'google', 'x', 'active') returning id`, [owner],
      );
      const [origin] = await db.query<{ id: string }>(
        `insert into contact_sync_origins (connection_id, owner_user_id, provider, source_account)
         values ($1, $2, 'google', 'x@example.test') returning id`, [connection.id, owner],
      );
      await db.query(
        `insert into contact_links (origin_id, contact_id, owner_user_id, source_id)
         values ($1, $2, $3, 'people/1')`, [origin.id, contact.id, owner],
      );
      await db.query(
        `insert into contact_tombstones (owner_user_id, origin_id, provider, source_account, source_id, deleted_side)
         values ($1, $2, 'google', 'x@example.test', 'people/2', 'remote')`, [owner, origin.id],
      );
      const [a, b] = [contact.id, other.id].sort();
      await db.query(
        `insert into contact_merge_decisions (owner_user_id, contact_a, contact_b, decision)
         values ($1, $2, $3, 'keep_separate')`, [owner, a, b],
      );
    }

    const countFor = async (owner: string) => {
      const counts: Record<string, number> = {};
      for (const table of OWNED) {
        const [row] = await db.query<{ n: string }>(
          `select count(*)::text as n from ${table} where owner_user_id = $1`, [owner],
        );
        counts[table] = Number(row.n);
      }
      return counts;
    };

    const before = await countFor(alice);
    for (const table of OWNED) {
      expect(before[table], `${table} should have a row to delete`).toBeGreaterThan(0);
    }

    await db.query(`delete from users where id = $1`, [alice]);

    const after = await countFor(alice);
    for (const table of OWNED) {
      expect(after[table], `${table} still holds a deleted user's rows`).toBe(0);
    }

    // And the other person is untouched — a cascade that took too much would
    // be just as wrong.
    const survivors = await countFor(bob);
    for (const table of OWNED) {
      expect(survivors[table], `${table} lost the other user's rows`).toBeGreaterThan(0);
    }
  });

  it('leaves no tombstone behind when its owner is gone', async () => {
    // Called out separately because it is the least obvious: a tombstone is
    // keyed by owner and provider rather than by a contact, so it does not
    // follow a contact's deletion and needs its own cascade.
    const user = (await createUser(db, { email: 't@ce.test', username: 'tomb', role: 'member' })).id;
    await db.query(
      `insert into contact_tombstones (owner_user_id, provider, source_account, source_id, deleted_side)
       values ($1, 'google', 'x@example.test', 'people/9', 'remote')`, [user],
    );
    expect(await db.query(`select id from contact_tombstones`)).toHaveLength(1);

    await db.query(`delete from users where id = $1`, [user]);
    expect(await db.query(`select id from contact_tombstones`)).toHaveLength(0);
  });
});

// ----------------------------------------------------------------- migrations

describe('migrations are applied exactly once', () => {
  const runner = readFileSync(join(here, '../../db/migrate.mjs'), 'utf8');

  it('is what actually stops a migration running twice', () => {
    // The first version of this suite asserted that EVERY migration was
    // re-runnable, and fourteen of them are not — they use plain
    // `create table`. That was the test being wrong rather than the schema:
    // the runner records each file in `_migrations` inside the same
    // transaction that applies it, and skips anything already there. A
    // non-idempotent migration is normal under that design.
    expect(runner).toMatch(/create table if not exists _migrations/);
    expect(runner).toMatch(/select name from _migrations/);
    expect(runner).toMatch(/applied\.has\(file\)/);
    expect(runner, 'the bookkeeping row must land with the migration').toMatch(/begin|sql\.begin/);
  });

  /** The migrations that CLAIM to be re-runnable, by using `if not exists`. */
  const claimsIdempotent = migrationFiles.filter((f) => /if\s+not\s+exists/i.test(migrationSql(f)));

  it('there are some making that claim', () => {
    expect(claimsIdempotent.length).toBeGreaterThan(3);
  });

  // A half-kept promise is worse than none: `if not exists` on the tables and a
  // bare `create trigger` underneath means the file looks safe to re-run and is
  // not. That is exactly what 0020 did.
  it.each(claimsIdempotent)('%s really is re-runnable', async (file) => {
    await expect(
      db.exec(migrationSql(file)),
      `${file} uses "if not exists" but is not safe to re-run`,
    ).resolves.not.toThrow();
  });

  it('re-running the re-runnable ones changes nothing that matters', async () => {
    const before = {
      schedules: await db.query<{ kind: string }>(`select kind from schedules order by kind`),
      policy: await db.query<{ action_class: string; max_level: string }>(
        `select action_class, max_level from admin_approval_policy order by action_class`,
      ),
      migrationLog: await db.query<{ action_class: string }>(
        `select action_class from approval_policy_migration order by action_class`,
      ),
      checklist: await db.query<{ id: boolean }>(`select id from admin_checklist_state`),
    };

    for (const file of claimsIdempotent) await db.exec(migrationSql(file));

    const after = {
      schedules: await db.query<{ kind: string }>(`select kind from schedules order by kind`),
      policy: await db.query<{ action_class: string; max_level: string }>(
        `select action_class, max_level from admin_approval_policy order by action_class`,
      ),
      migrationLog: await db.query<{ action_class: string }>(
        `select action_class from approval_policy_migration order by action_class`,
      ),
      checklist: await db.query<{ id: boolean }>(`select id from admin_checklist_state`),
    };

    // Seeded rows are seeded once. A migration that re-inserts on every run
    // produces a duplicate schedule firing twice as often, or a second
    // "we changed your policy" notice for a change that happened once.
    expect(after.schedules).toEqual(before.schedules);
    expect(after.policy).toEqual(before.policy);
    expect(after.migrationLog).toEqual(before.migrationLog);
    expect(after.checklist).toEqual(before.checklist);
  });

  it('declares the tables this suite claims to cover', () => {
    // Guards the two lists above from drifting: a contact-sync table added
    // later is caught here even if nobody remembers to extend OWNED.
    const tables = declaredTables();
    for (const table of [
      'contacts', 'contact_sync_origins', 'contact_links',
      'contact_tombstones', 'contact_merge_decisions',
    ]) {
      expect(tables, `${table} is not declared by any migration`).toContain(table);
    }
    // Every table whose name begins `contact_` is covered by the cascade test.
    const contactTables = tables.filter((t) => t.startsWith('contact_'));
    expect(contactTables.sort()).toEqual([
      'contact_links', 'contact_merge_decisions', 'contact_sync_origins', 'contact_tombstones',
    ]);
  });
});
