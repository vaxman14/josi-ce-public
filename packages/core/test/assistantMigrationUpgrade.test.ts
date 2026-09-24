import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const feature = '0056_assistant_migration.sql';

describe('assistant migration schema upgrade', () => {
  it('does not reuse the feature migration numeric prefix', () => {
    const files = readdirSync(migrations).filter(name => name.endsWith('.sql'));
    expect(files.filter(name => name.startsWith(feature.slice(0, 4)))).toEqual([feature]);
  });

  it('upgrades a v0.1.39 schema with existing persona data and rerun guard', async () => {
    const pg = new PGlite();
    const files = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort();
    for (const file of files.filter(name => name !== feature)) await pg.exec(readFileSync(join(migrations, file), 'utf8'));
    const user = randomUUID();
    await pg.query(`insert into users(id,email,username,role) values($1,$2,$3,'member')`, [user, 'upgrade@example.test', 'upgrade-user']);
    await pg.query(`insert into memories(owner_user_id,content) values($1,'Existing synthetic memory')`, [user]);
    await pg.query(`insert into memories(owner_user_id,content) values($1,'  existing  SYNTHETIC memory  ')`, [user]);
    await pg.query(`insert into persona_profiles(owner_user_id,kind,content) values($1,'soul','tone: brief')`, [user]);
    await pg.exec(`create table if not exists _migrations(name text primary key, applied_at timestamptz not null default now())`);

    const apply = async () => {
      const applied = await pg.query<{ name: string }>('select name from _migrations where name=$1', [feature]);
      if (applied.rows.length) return false;
      await pg.transaction(async tx => {
        await tx.exec(readFileSync(join(migrations, feature), 'utf8'));
        await tx.query('insert into _migrations(name) values($1)', [feature]);
      });
      return true;
    };
    expect(await apply()).toBe(true);
    expect(await apply()).toBe(false);
    const existing = (await pg.query<{ id: string; content: string; content_fingerprint: string }>(
      `select id,content,content_fingerprint from memories where owner_user_id=$1 order by created_at,id`, [user])).rows;
    expect(existing).toHaveLength(2);
    expect(existing[0].content_fingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(existing[1].content_fingerprint).toBe(existing[0].content_fingerprint);
    await expect(pg.query(`insert into memories(owner_user_id,content,content_fingerprint) values($1,' existing  SYNTHETIC memory ',$2)`,
      [user, existing[0].content_fingerprint])).rejects.toThrow();
    await pg.query(`delete from memories where id=$1`, [existing[0].id]);
    await expect(pg.query(`insert into memories(owner_user_id,content,content_fingerprint) values($1,'Existing synthetic memory',$2)`,
      [user, existing[0].content_fingerprint])).rejects.toThrow();
    await pg.query(`update memories set content='Different fact',content_fingerprint=md5('different fact') where id=$1`, [existing[1].id]);
    await expect(pg.query(`insert into memories(owner_user_id,content,content_fingerprint) values($1,'Existing synthetic memory',$2)`,
      [user, existing[0].content_fingerprint])).resolves.toBeDefined();
    const other = randomUUID();
    await pg.query(`insert into users(id,email,username,role) values($1,$2,$3,'member')`, [other, 'other@example.test', 'other-user']);
    const [moved] = (await pg.query<{ id: string }>(`select id from memories where owner_user_id=$1 and content_fingerprint=$2 limit 1`,
      [user, existing[0].content_fingerprint])).rows;
    await pg.query(`update memories set owner_user_id=$1 where id=$2`, [other, moved.id]);
    await expect(pg.query(`insert into memories(owner_user_id,content,content_fingerprint) values($1,'Existing synthetic memory',$2)`,
      [other, existing[0].content_fingerprint])).rejects.toThrow();
    await expect(pg.query(`insert into memories(owner_user_id,content,content_fingerprint) values($1,'Existing synthetic memory',$2)`,
      [user, existing[0].content_fingerprint])).resolves.toBeDefined();
    expect((await pg.query(`select content from persona_profiles where owner_user_id=$1`, [user])).rows[0]).toEqual({ content: 'tone: brief' });
    expect((await pg.query(`select to_regclass('migration_previews') as previews, to_regclass('migration_archives') as archives`)).rows[0]).toEqual({ previews: 'migration_previews', archives: 'migration_archives' });
    await pg.close();
  });
});
