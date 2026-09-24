import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import {
  createInternalEvent, enqueueCalendarWebhook, ensureInternalCalendar, getInternalEvent, listInternalEvents,
  processCalendarOutbox, provisionCalendarOrigins, saveClient, setCapability, syncCalendarOrigin,
  updateInternalEvent, upsertConnection,
} from '../src/index.js';

let db: TestDb; let alice: string; let bob: string;
const key = new MasterKey(Buffer.alloc(32, 4));

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db,{email:'alice@calendar.test',username:'alice',role:'super_admin'})).id;
  bob = (await createUser(db,{email:'bob@calendar.test',username:'bob',role:'member'})).id;
  await saveClient(db,key,{provider:'google',clientId:'client',clientSecret:'calendar-CLIENT-SECRET',redirectUri:'https://example.test/callback',actorUserId:alice});
});

async function connected(user=alice){
  const c=await upsertConnection(db,key,{ownerUserId:user,provider:'google',tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar'},accountEmail:'a@example.test',providerAccountId:`acct-${user}`,requestedCapabilities:['google.calendar.write'],enableRequestedCapabilities:true});
  await setCapability(db,{connection:c,capability:'google.calendar.write',enabled:true,actorUserId:user});
  return c;
}

describe('internal calendar is authoritative',()=>{
  it('persists immediately, reads locally, and queues exactly one provider write',async()=>{
    const c=await connected(); const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    const event=await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'EDD call',start:'2026-09-18T22:30:00Z',end:'2026-09-18T23:00:00Z'}});
    expect(event.sync_state).toBe('pending');
    expect((await listInternalEvents(db,{ownerUserId:alice,start:'2026-09-18T00:00:00Z',end:'2026-09-19T00:00:00Z'})).map(e=>e.id)).toEqual([event.id]);
    expect(await listInternalEvents(db,{ownerUserId:bob,start:'2026-09-18T00:00:00Z',end:'2026-09-19T00:00:00Z'})).toEqual([]);
    const rows=await db.query<{n:number}>(`select count(*)::int n from calendar_outbox where event_id=$1`,[event.id]); expect(rows[0].n).toBe(1);
  });

  it('uses one idempotent outbox row and records the provider mapping',async()=>{
    const c=await connected(); const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    const event=await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'LexisNexis',start:'2026-09-18T22:00:00Z',end:'2026-09-18T22:30:00Z'}});
    await updateInternalEvent(db,{ownerUserId:alice,eventId:event.id,changes:{title:'LexisNexis call'}});
    const calls:string[]=[]; const fetchImpl:typeof fetch=async(url,init)=>{calls.push(`${init?.method} ${url}`);return new Response(JSON.stringify({id:'g-1',iCalUID:'uid-1',etag:'"e1"',updated:'2026-09-17T10:00:00Z'}),{status:200});};
    expect(await processCalendarOutbox(db,{masterKey:key,fetchImpl})).toBe(1);
    expect(calls).toHaveLength(1); expect(calls[0]).toContain('POST');
    const stored=await getInternalEvent(db,{ownerUserId:alice,eventId:event.id}); expect(stored?.sync_state).toBe('synced');
    const [link]=await db.query<any>(`select provider_event_id,ical_uid from calendar_event_links where event_id=$1`,[event.id]); expect(link).toMatchObject({provider_event_id:'g-1',ical_uid:'uid-1'});
  });

  it('recovers after a crash-after-create without duplicating the Google event',async()=>{
    const c=await connected(); const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    const event=await createInternalEvent(db,{ownerUserId:alice,originId:origin.id,event:{title:'One event',start:'2026-09-18T20:00:00Z',end:'2026-09-18T20:30:00Z'}});
    let calls=0; const stable=event.id.replace(/-/g,'');
    const fetchImpl:typeof fetch=async(url)=>{calls++; if(calls===1)return new Response('{}',{status:409}); expect(String(url)).toContain(stable); return new Response(JSON.stringify({id:stable,etag:'"ok"'}),{status:200});};
    await processCalendarOutbox(db,{masterKey:key,fetchImpl});
    expect(calls).toBe(2); expect((await getInternalEvent(db,{ownerUserId:alice,eventId:event.id}))?.sync_state).toBe('synced');
  });

  it('incrementally imports Google events and an expired cursor repairs with a full pull',async()=>{
    const c=await connected(); const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    await db.query(`update calendar_sync_origins set sync_cursor='expired' where id=$1`,[origin.id]); let n=0;
    const fetchImpl:typeof fetch=async()=>{n++; if(n===1)return new Response('{}',{status:410}); return new Response(JSON.stringify({items:[{id:'remote-1',summary:'Remote call',etag:'"r1"',updated:'2026-09-17T10:00:00Z',start:{dateTime:'2026-09-19T17:00:00Z'},end:{dateTime:'2026-09-19T17:30:00Z'}}],nextSyncToken:'fresh'}),{status:200});};
    await syncCalendarOrigin(db,origin.id,{masterKey:key,fetchImpl});
    expect((await listInternalEvents(db,{ownerUserId:alice,start:'2026-09-19T00:00:00Z',end:'2026-09-20T00:00:00Z'}))[0].title).toBe('Remote call');
    const [saved]=await db.query<any>(`select sync_cursor,status from calendar_sync_origins where id=$1`,[origin.id]); expect(saved).toMatchObject({sync_cursor:'fresh',status:'idle'});
  });

  it('imports recurring instances with their provider series and original occurrence time',async()=>{
    const c=await connected();const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    let requested='';
    const fetchImpl:typeof fetch=async(url)=>{requested=String(url);return new Response(JSON.stringify({items:[{id:'series_20260918T220000Z',recurringEventId:'series',originalStartTime:{dateTime:'2026-09-18T22:00:00Z'},summary:'Weekly call',start:{dateTime:'2026-09-18T22:00:00Z'},end:{dateTime:'2026-09-18T22:30:00Z'}}],nextSyncToken:'recurring'}),{status:200});};
    await syncCalendarOrigin(db,origin.id,{masterKey:key,fetchImpl});
    expect(requested).toContain('singleEvents=true');
    const [event]=await db.query<{recurring_provider_event_id:string;original_start:string}>(`select recurring_provider_event_id,original_start from calendar_events where owner_user_id=$1`,[alice]);
    expect(event.recurring_provider_event_id).toBe('series');
    expect(new Date(event.original_start).toISOString()).toBe('2026-09-18T22:00:00.000Z');
  });

  it('surfaces a concurrent local/remote edit instead of overwriting either',async()=>{
    const c=await connected(); const origin=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google'});
    const first:typeof fetch=async()=>new Response(JSON.stringify({items:[{id:'r1',summary:'Original',etag:'"1"',start:{dateTime:'2026-09-20T10:00:00Z'},end:{dateTime:'2026-09-20T11:00:00Z'}}],nextSyncToken:'s1'}),{status:200});
    await syncCalendarOrigin(db,origin.id,{masterKey:key,fetchImpl:first}); const [event]=await listInternalEvents(db,{ownerUserId:alice,start:'2026-09-20T00:00:00Z',end:'2026-09-21T00:00:00Z'});
    await updateInternalEvent(db,{ownerUserId:alice,eventId:event.id,changes:{title:'Local edit'}});
    const second:typeof fetch=async()=>new Response(JSON.stringify({items:[{id:'r1',summary:'Remote edit',etag:'"2"',start:{dateTime:'2026-09-20T10:00:00Z'},end:{dateTime:'2026-09-20T11:00:00Z'}}],nextSyncToken:'s2'}),{status:200});
    await syncCalendarOrigin(db,origin.id,{masterKey:key,fetchImpl:second}); const saved=await getInternalEvent(db,{ownerUserId:alice,eventId:event.id});
    expect(saved?.title).toBe('Local edit'); expect(saved?.sync_state).toBe('conflict');
  });

  it('keeps multiple calendars distinct and deduplicates webhook jobs',async()=>{
    const c=await connected();
    const primary=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'primary'});
    const work=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'work@example.test',name:'Work'});
    expect(primary.id).not.toBe(work.id);
    await db.query(`update calendar_sync_origins set webhook_channel_id='channel',webhook_resource_id='resource' where id=$1`,[work.id]);
    expect(await enqueueCalendarWebhook(db,{channelId:'channel',resourceId:'resource'})).toBe(true);
    expect(await enqueueCalendarWebhook(db,{channelId:'channel',resourceId:'resource'})).toBe(true);
    const [jobs]=await db.query<{n:number}>(`select count(*)::int n from job_queue where kind='calendar.sync'`); expect(jobs.n).toBe(1);
    expect(await enqueueCalendarWebhook(db,{channelId:'wrong',resourceId:'resource'})).toBe(false);
  });

  it('backfills every selected calendar, including secondaries',async()=>{
    const c=await connected();
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,selected) values($1,$2,'real-primary','Primary',true,true,true),($1,$2,'secondary','Secondary',false,false,true),($1,$2,'off','Off',false,true,false)`,[alice,c.id]);
    expect(await provisionCalendarOrigins(db)).toBe(2);
    const origins=await db.query<{provider_calendar_id:string}>(`select provider_calendar_id from calendar_sync_origins where connection_id=$1 order by provider_calendar_id`,[c.id]);
    expect(origins.map(origin=>origin.provider_calendar_id)).toEqual(['real-primary','secondary']);
    const [secondary]=await db.query<{writable:boolean;is_write_default:boolean}>(`select writable,is_write_default from calendar_sources where connection_id=$1 and provider_calendar_id='secondary'`,[c.id]);
    expect(secondary).toEqual({writable:false,is_write_default:false});
  });

  it('upgrade reconciliation prefers the writable provider primary over an arbitrary secondary default',async()=>{
    const c=await connected();
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,selected,is_write_default)
      values($1,$2,'provider-primary','Primary calendar',true,true,true,false),($1,$2,'kids','Kids',false,true,true,true)`,[alice,c.id]);
    const kids=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'kids'});
    const primary=await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'provider-primary'});
    await db.exec(readFileSync(new URL('../../db/migrations/0054_calendar_write_default_primary.sql',import.meta.url),'utf8'));

    const rows=await db.query<{provider_calendar_id:string;is_write_default:boolean}>(`select provider_calendar_id,is_write_default from calendar_sources where connection_id=$1 order by provider_calendar_id`,[c.id]);
    expect(rows).toEqual([{provider_calendar_id:'kids',is_write_default:false},{provider_calendar_id:'provider-primary',is_write_default:true}]);
    const [defaultCalendar]=await db.query<{id:string}>(`select id from calendars where owner_user_id=$1 and is_default`,[alice]);
    expect(defaultCalendar.id).toBe(primary.calendar_id);
    expect(defaultCalendar.id).not.toBe(kids.calendar_id);
  });

  it('moves an old internal default when backfilling the explicit write default',async()=>{
    const c=await connected();
    await ensureInternalCalendar(db,{ownerUserId:alice,connectionId:c.id,provider:'google',providerCalendarId:'old-primary',name:'Old primary',writable:true});
    await db.query(`update calendar_sources set is_write_default=false where connection_id=$1`,[c.id]);
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,writable,selected,is_write_default)
      values($1,$2,'new-default','New default',true,true,true)`,[alice,c.id]);

    expect(await provisionCalendarOrigins(db)).toBe(1);
    const [defaults]=await db.query<{n:number}>(`select count(*)::int n from calendars where owner_user_id=$1 and is_default`,[alice]);
    expect(defaults.n).toBe(1);
    const [mapped]=await db.query<{provider_calendar_id:string}>(`select s.provider_calendar_id from calendars c
      join calendar_sync_origins o on o.calendar_id=c.id
      join calendar_sources s on s.connection_id=o.connection_id and s.provider_calendar_id=o.provider_calendar_id
      where c.owner_user_id=$1 and c.is_default and s.is_write_default`,[alice]);
    expect(mapped.provider_calendar_id).toBe('new-default');
  });
});
