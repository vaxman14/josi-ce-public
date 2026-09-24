// Fresh-database migration check: every migration applies in order to an empty
// database, and the columns this branch added are actually there afterwards.
import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { testDb } from '../../../packages/core/test/helpers.js';

describe('a fresh database migrates cleanly', () => {
  it('upgrades the deployed 0.1.4 boolean developer-service policy', async () => {
    const pg = new PGlite();
    const migrations = join(import.meta.dirname, '../../../packages/db/migrations');
    const files = readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files.filter((f) => f < '0033_developer_services.sql')) {
      await pg.exec(readFileSync(join(migrations, file), 'utf8'));
    }
    await pg.exec(`
      create table developer_service_policy (
        service text primary key check (service in ('github', 'netlify', 'vercel', 'supabase')),
        allowed boolean not null default true,
        note text,
        updated_at timestamptz not null default now()
      );
      create trigger developer_service_policy_touch before update on developer_service_policy
        for each row execute function touch_updated_at();
      insert into developer_service_policy (service, allowed, note) values
        ('github', true, 'kept enabled'),
        ('netlify', false, 'kept disabled');
    `);

    for (const file of files.filter((f) => f >= '0033_developer_services.sql')) {
      await pg.exec(readFileSync(join(migrations, file), 'utf8'));
    }

    const columns = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'developer_service_policy'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toContain('mode');
    expect(columns.rows.map((row) => row.column_name)).not.toContain('allowed');

    const policies = await pg.query<{ service: string; mode: string; note: string | null }>(
      `select service, mode, note from developer_service_policy order by service`,
    );
    expect(policies.rows).toEqual([
      { service: 'cloudflare', mode: 'not_allowed', note: null },
      { service: 'dockerhub', mode: 'not_allowed', note: null },
      { service: 'ghcr', mode: 'not_allowed', note: null },
      { service: 'github', mode: 'everyone', note: 'kept enabled' },
      { service: 'gitlab', mode: 'not_allowed', note: null },
      { service: 'jira', mode: 'not_allowed', note: null },
      { service: 'linear', mode: 'not_allowed', note: null },
      { service: 'neon', mode: 'not_allowed', note: null },
      { service: 'netlify', mode: 'not_allowed', note: 'kept disabled' },
      { service: 'notion', mode: 'not_allowed', note: null },
      { service: 'npm', mode: 'not_allowed', note: null },
      { service: 'railway', mode: 'not_allowed', note: null },
      { service: 'render', mode: 'not_allowed', note: null },
      { service: 'sentry', mode: 'not_allowed', note: null },
      { service: 'supabase', mode: 'not_allowed', note: null },
      { service: 'vercel', mode: 'not_allowed', note: null },
    ]);
  });

  it('applies every migration and lands the provider-ecosystem schema', async () => {
    const db = await testDb();
    const [cfg] = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'llm_providers' and column_name = 'provider_config'`,
    );
    expect(cfg?.column_name).toBe('provider_config');

    // The provider kinds added by 0031 must be accepted by the CHECK
    // constraint, or a provider selectable in the UI would be unsavable.
    for (const kind of ['bedrock', 'vertex_ai', 'azure_ai', 'ernie', 'hunyuan', 'cohere', 'gemini']) {
      // Every one of these is an external provider, and the schema refuses an
      // external row without the acknowledgment (M89) — which is the
      // constraint doing its job, so the fixture satisfies it rather than
      // working around it.
      await db.query(
        `insert into llm_providers
           (role, provider, model, external_acknowledged, external_acknowledged_at)
         values ('primary', $1, 'm', true, now())
         on conflict (role) do update set provider = excluded.provider`,
        [kind],
      );
    }
    const [row] = await db.query<{ provider: string }>(
      `select provider from llm_providers where role = 'primary'`,
    );
    expect(row.provider).toBe('gemini');
  });

  it('creates the backup destination table with no host-secret column', async () => {
    const db = await testDb();
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'backup_destination'`,
    );
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('credentials_enc');
    expect(names).toContain('bucket');
    // The credential is held by the application, sealed. There is deliberately
    // no column naming a file the operator must create and mount.
    expect(names).not.toContain('secret_prefix');
    expect(names).not.toContain('secret_file');
  });

  it('separates developer-service permission from developer-service connection', async () => {
    const db = await testDb();
    const policy = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'developer_service_policy'`,
    );
    const connections = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'developer_connections'`,
    );
    // Two tables, because "may connect" and "has connected" are two facts.
    expect(policy.map((c) => c.column_name)).toContain('mode');
    expect(connections.map((c) => c.column_name)).toContain('credentials_enc');
    // The credential is per person. A column for an installation-wide one would
    // be the admin-owned credential this design exists to avoid.
    expect(connections.map((c) => c.column_name)).toContain('owner_user_id');
    expect(policy.map((c) => c.column_name)).not.toContain('credentials_enc');

    // Every service ships refused.
    const modes = await db.query<{ service: string; mode: string }>(
      `select service, mode from developer_service_policy order by service`,
    );
    expect(modes).toHaveLength(16);
    expect(modes.every((m) => m.mode === 'not_allowed')).toBe(true);
  });

  it('stores a licence as a verifiable token, not as a granted flag', async () => {
    const db = await testDb();
    const cols = (await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'licence'`,
    )).map((c) => c.column_name);
    expect(cols).toContain('token');
    // The cached verdict exists for display. What must NOT exist is a boolean
    // an operator could flip to license themselves: entitlement comes from a
    // signature, and the token is re-verified on every read.
    expect(cols).toContain('last_state');
    expect(cols).not.toContain('licensed');
    expect(cols).not.toContain('is_valid');
  });

  it('has no duplicate migration numbers introduced by this branch', () => {
    const files = readdirSync(join(import.meta.dirname, '../../../packages/db/migrations'))
      .filter((f) => f.endsWith('.sql'));
    const counts = new Map<string, string[]>();
    for (const f of files) {
      const n = f.slice(0, 4);
      counts.set(n, [...(counts.get(n) ?? []), f]);
    }
    const dupes = [...counts.entries()].filter(([, v]) => v.length > 1);
    // 0030 is duplicated on this branch already, from two features that landed
    // separately. Recorded rather than asserted away, so it is visible; what
    // this guards is that nothing NEW duplicates a number.
    expect(dupes.map(([n]) => n)).toEqual(['0030']);
  });
});
