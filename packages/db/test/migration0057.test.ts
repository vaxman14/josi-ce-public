import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations=join(dirname(fileURLToPath(import.meta.url)),'../migrations');

/** Upgrade proof, separate from the fresh-database suite: representative rows
 * from the deployed schema exist before 0057 and must remain afterwards. */
describe('migration 0057 durable mobile turns and push',()=>{
  it('upgrades an existing installation without changing conversations or child activity',async()=>{
    const pg=new PGlite();
    const files=readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort();
    for(const file of files.filter(f=>f<'0057_durable_mobile_turns_push.sql'))await pg.exec(readFileSync(join(migrations,file),'utf8'));
    await pg.exec(`
      insert into users(id,email,username,role) values('10000000-0000-4000-8000-000000000001','upgrade@example.test','upgrade','member');
      insert into threads(id,owner_user_id,title) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','kept');
      insert into messages(id,thread_id,direction,body) values('30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','in','existing');
      insert into child_activity_minutes(child_user_id,minute,channel) values('10000000-0000-4000-8000-000000000001',date_trunc('minute',now()),'web');
    `);
    await pg.exec(readFileSync(join(migrations,'0057_durable_mobile_turns_push.sql'),'utf8'));
    expect((await pg.query<{body:string}>(`select body from messages where id='30000000-0000-4000-8000-000000000001'`)).rows[0].body).toBe('existing');
    expect((await pg.query<{channel:string}>(`select channel from child_activity_minutes where child_user_id='10000000-0000-4000-8000-000000000001'`)).rows[0].channel).toBe('web');
    await pg.exec(`insert into child_activity_minutes(child_user_id,minute,channel) values('10000000-0000-4000-8000-000000000001',date_trunc('minute',now())+interval '1 minute','native')`);
    const tables=(await pg.query<{table_name:string}>(`select table_name from information_schema.tables where table_name in ('assistant_turns','assistant_turn_effects','mobile_devices','push_deliveries') order by table_name`)).rows.map(r=>r.table_name);
    expect(tables).toEqual(['assistant_turn_effects','assistant_turns','mobile_devices','push_deliveries']);
  });
});
