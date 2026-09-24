import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrations=join(dirname(fileURLToPath(import.meta.url)),'../migrations');

describe('migration 0059 server reminder delivery',()=>{
  it('adds revision fencing to an existing queued reminder',async()=>{
    const pg=new PGlite();
    const files=readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort();
    for(const file of files.filter(f=>f<'0059_native_reminder_delivery.sql'))await pg.exec(readFileSync(join(migrations,file),'utf8'));
    await pg.exec(`
      insert into users(id,email,username,role) values('10000000-0000-4000-8000-000000000001','legacy@example.test','legacy','member');
      insert into threads(id,owner_user_id,title) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','legacy');
      insert into reminders(id,owner_user_id,thread_id,body,due_at) values('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','private legacy body',now()+interval '1 hour');
      insert into job_queue(kind,payload,run_at) values('reminder.deliver','{"reminderId":"30000000-0000-4000-8000-000000000001"}',now()+interval '1 hour');
    `);
    await pg.exec(readFileSync(join(migrations,'0059_native_reminder_delivery.sql'),'utf8'));
    const reminder=(await pg.query<{revision:number;timezone:string}>(`select revision,timezone from reminders`)).rows[0];
    expect(reminder).toEqual({revision:1,timezone:'UTC'});
    const job=(await pg.query<{payload:{reminderId:string;revision:number}}>(`select payload from job_queue where kind='reminder.deliver'`)).rows[0];
    expect(job.payload).toEqual({reminderId:'30000000-0000-4000-8000-000000000001',revision:1});
  });
});
