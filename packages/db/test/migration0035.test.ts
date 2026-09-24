// Migration 0035 safety: it must move the DEFAULT forward without ever
// clobbering a value an administrator already changed.
//
// This is tested by applying migrations UP TO but NOT INCLUDING 0035 (so the
// database is in exactly the state a real, already-running installation like
// gate's is in today), then exercising both branches by hand before applying
// 0035 and checking what survived:
//
//   * a row still sitting at the literal old default (2147483648) -> bumped
//   * a row an admin already moved away from that default -> left alone
//
// Two separate PGlite instances stand in for "two different real
// installations" so the two scenarios cannot leak into each other.
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

const OLD_DEFAULT = 2147483648; // 2GiB, the value 0007 originally shipped
const NEW_DEFAULT = 21474836480; // 20GiB, item 40h-DECIDED

async function applyThrough(pg: PGlite, lastFile: string) {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    if (file === lastFile) return;
  }
  throw new Error(`migration file not found: ${lastFile}`);
}

async function applyOne(pg: PGlite, file: string) {
  await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
}

describe('migration 0035 — raising the storage quota default safely', () => {
  it('bumps a row still sitting at the literal old 2GiB default', async () => {
    const pg = new PGlite();
    await applyThrough(pg, '0030_vision_capability.sql');

    const before = await pg.query<{ max_total_bytes_per_user: string }>(
      `select max_total_bytes_per_user from storage_policy where id = true`,
    );
    expect(Number(before.rows[0].max_total_bytes_per_user)).toBe(OLD_DEFAULT);

    await applyOne(pg, '0035_storage_quota_default_20gb.sql');

    const after = await pg.query<{ max_total_bytes_per_user: string }>(
      `select max_total_bytes_per_user from storage_policy where id = true`,
    );
    expect(Number(after.rows[0].max_total_bytes_per_user)).toBe(NEW_DEFAULT);
  });

  it('does NOT touch a row an administrator already customized away from the old default', async () => {
    const pg = new PGlite();
    await applyThrough(pg, '0030_vision_capability.sql');

    // Simulate an administrator who already edited the global policy by hand
    // (the only way it could differ today — no route writes this column) to
    // some other value entirely, e.g. 5GiB.
    const adminChosenValue = 5 * 1024 * 1024 * 1024;
    await pg.exec(
      `update storage_policy set max_total_bytes_per_user = ${adminChosenValue} where id = true`,
    );

    const before = await pg.query<{ max_total_bytes_per_user: string }>(
      `select max_total_bytes_per_user from storage_policy where id = true`,
    );
    expect(Number(before.rows[0].max_total_bytes_per_user)).toBe(adminChosenValue);

    await applyOne(pg, '0035_storage_quota_default_20gb.sql');

    // Must be EXACTLY what the admin set, completely untouched — not bumped,
    // not reset, not averaged, nothing.
    const after = await pg.query<{ max_total_bytes_per_user: string }>(
      `select max_total_bytes_per_user from storage_policy where id = true`,
    );
    expect(Number(after.rows[0].max_total_bytes_per_user)).toBe(adminChosenValue);
  });

  it('does not touch storage_capabilities rows at all — per-user overrides are untouched', async () => {
    const pg = new PGlite();
    await applyThrough(pg, '0030_vision_capability.sql');

    const [user] = (await pg.query<{ id: string }>(
      `insert into users (email, username, role) values ('a@test.example', 'a', 'member') returning id`,
    )).rows;
    const customBytes = 5 * 1024 * 1024 * 1024; // representative administrator-selected override
    await pg.exec(
      `insert into storage_capabilities (user_id, may_map_local, may_map_cloud, may_index, max_bytes, granted_by)
       values ('${user.id}', true, true, true, ${customBytes}, '${user.id}')`,
    );

    await applyOne(pg, '0035_storage_quota_default_20gb.sql');

    const row = await pg.query<{ max_bytes: string }>(
      `select max_bytes from storage_capabilities where user_id = '${user.id}'`,
    );
    expect(Number(row.rows[0].max_bytes)).toBe(customBytes);
  });

  it('a brand-new install (0035 applied from the start, as part of the full sequence) starts at 20GiB', async () => {
    const pg = new PGlite();
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }
    const row = await pg.query<{ max_total_bytes_per_user: string }>(
      `select max_total_bytes_per_user from storage_policy where id = true`,
    );
    expect(Number(row.rows[0].max_total_bytes_per_user)).toBe(NEW_DEFAULT);
  });
});
