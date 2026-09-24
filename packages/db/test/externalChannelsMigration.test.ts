import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

describe('external channel migrations', () => {
  it('apply after the complete current schema and expose only WhatsApp and Slack', async () => {
    const pg = new PGlite();
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      await pg.exec(readFileSync(join(migrations, file), 'utf8'));
    }
    const providers = await pg.query<{ provider: string }>('select provider from external_channel_configs order by provider');
    expect(providers.rows.map((row) => row.provider)).toEqual(['slack', 'whatsapp']);
    const tables = await pg.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema='public' and table_name like 'external_channel%' order by table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'external_channel_configs', 'external_channel_events', 'external_channel_link_codes',
      'external_channel_links', 'external_channel_outbound',
    ]);
    await pg.close();
  });

  it('is safe when an older build already created the channel tables', async () => {
    const pg = new PGlite();
    const files = readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files.filter((name) => name < '0037_')) {
      await pg.exec(readFileSync(join(migrations, file), 'utf8'));
    }
    await pg.exec(readFileSync(join(migrations, '0037_external_messaging_channels.sql'), 'utf8'));
    await pg.exec(readFileSync(join(migrations, '0038_external_channel_link_codes.sql'), 'utf8'));
    await pg.exec(readFileSync(join(migrations, '0037_external_messaging_channels.sql'), 'utf8'));
    await pg.exec(readFileSync(join(migrations, '0038_external_channel_link_codes.sql'), 'utf8'));
    const providers = await pg.query<{ provider: string }>('select provider from external_channel_configs order by provider');
    expect(providers.rows.map((row) => row.provider)).toEqual(['slack', 'whatsapp']);
    await pg.close();
  });
});
