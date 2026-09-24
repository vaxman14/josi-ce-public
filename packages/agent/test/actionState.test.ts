import {beforeEach,describe,expect,it} from 'vitest';
import {testDb,type TestDb} from '../../core/test/helpers.js';
import {createUser} from '../../auth/src/users.js';
import {addMessage,createThread,getTask,markActionsPresented,MasterKey,setUserApprovalLevel} from '@josi-ce/core';
import {ensureInternalCalendar,setCapability,upsertConnection} from '@josi-ce/connectors';
import {executeAssistantTool} from '../src/execute.js';
import {formatCalendarRange} from '../src/calendarPresentation.js';

let db:TestDb;
let user:string;
let thread:string;
const key=new MasterKey(Buffer.alloc(32,8));

beforeEach(async()=>{
  db=await testDb();
  user=(await createUser(db,{email:'state@example.test',username:'state',role:'super_admin'})).id;
  thread=(await createThread(db,{ownerUserId:user})).id;
});

const ctx=()=>({userId:user,threadId:thread,turnId:null,connectors:{masterKey:()=>key}});
async function present(result:{task_id?:unknown},body:string){
  const message=await addMessage(db,{threadId:thread,direction:'out',body});
  if(typeof result.task_id==='string')await markActionsPresented(db,{ownerUserId:user,threadId:thread,taskIds:[result.task_id],messageId:message.id});
}

describe('action drafts are merged only inside their namespace',()=>{
  it('completes the exact email transcript while preserving recipient and body',async()=>{
    const first=await executeAssistantTool(db,ctx(),'draft_email',{
      recipient:'romanvaxman14@gmail.com',body:'testing the connection',
    }) as any;
    expect(first).toMatchObject({ok:true,state:'collecting',missing_slots:['subject']});
    await present(first,'What subject should I use?');

    const second=await executeAssistantTool(db,ctx(),'draft_email',{
      subject:'testing the coonection',
    }) as any;
    expect(second.state).toBe('prepared');
    expect(second.summary).toBe('Send email\nTo: romanvaxman14@gmail.com\nSubject: testing the coonection\nBody: testing the connection');
    const task=await getTask(db,second.task_id);
    expect(task.slots).toMatchObject({recipient:'romanvaxman14@gmail.com',subject:'testing the coonection',body:'testing the connection'});
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1 and status='pending'`,[task.id])).toHaveLength(1);
  });

  it('routes an ordinary write to the authoritative default without asking among read calendars',async()=>{
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly'},
      requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await setCapability(db,{connection,capability:'google.calendar.read',enabled:true,actorUserId:user});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,is_write_default)
      values($1,$2,'primary','Main calendar',true,true,true),($1,$2,'other','LexisNexis archive',false,true,false)`,[user,connection.id]);
    const primary=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'primary'});
    const other=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'other'});
    await db.query(`update calendar_sync_origins set last_sync_at=now() where id in($1,$2)`,[primary.id,other.id]);

    await setUserApprovalLevel(db,{userId:user,actionClass:'calendar_write',level:'automatic'});
    const first=await executeAssistantTool(db,ctx(),'draft_calendar_event',{title:'Phone call with EDD'}) as any;
    expect(first).toMatchObject({state:'collecting',missing_slots:['start','end']});
    await present(first,'What time should I use?');
    const completed=await executeAssistantTool(db,ctx(),'draft_calendar_event',{
      start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00',
    }) as any;
    expect(completed,JSON.stringify(completed)).toMatchObject({state:'approved',authorization:'user_policy'});
    expect(completed.summary).toContain('Calendar: Main calendar');
    expect(completed.summary).toContain('Title: Phone call with EDD');
    expect(completed.summary).not.toContain('LexisNexis');
    const task=await getTask(db,completed.task_id);
    expect(task.state).toBe('ready');
    expect(task.slots).not.toHaveProperty('event_id');
    expect(task.slots.calendar_source).toMatchObject({calendar_id:'primary',calendar_name:'Main calendar'});
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1`,[task.id])).toEqual([]);
    expect(await db.query(`select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`,[task.id])).toHaveLength(1);
  });

  it('keeps the no-approval preference while a missing duration completes the Vaxman Kids event',async()=>{
    await db.query(`insert into workspace(id,name,timezone) values(true,'Test','America/Los_Angeles') on conflict(id) do update set timezone=excluded.timezone`);
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'vaxman-kids',accountEmail:'kids@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly'},
      requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await setCapability(db,{connection,capability:'google.calendar.read',enabled:true,actorUserId:user});
    const [source]=await db.query<{id:string}>(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,is_write_default)
      values($1,$2,'vaxman-kids','Vaxman Kids',true,true,true) returning id`,[user,connection.id]);
    const origin=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'vaxman-kids'});
    await db.query(`update calendar_sync_origins set last_sync_at=now() where id=$1`,[origin.id]);
    await setUserApprovalLevel(db,{userId:user,actionClass:'calendar_write',level:'automatic'});

    const first=await executeAssistantTool(db,{...ctx(),latestUserText:'November 14, 2026 at 4:30 PM'},'draft_calendar_event',{
      source_id:source.id,title:'Vaxman Kids event',start:'2026-11-14T16:30:00-08:00',
    }) as any;
    expect(first).toMatchObject({state:'collecting',missing_slots:['end']});
    await present(first,'How long should it last?');

    const completed=await executeAssistantTool(db,{...ctx(),latestUserText:'2 hours'},'draft_calendar_event',{duration_minutes:120}) as any;
    expect(completed,JSON.stringify(completed)).toMatchObject({state:'approved',authorization:'user_policy'});
    expect(completed.summary).toContain('Calendar: Vaxman Kids');
    expect(completed.summary).toContain('Date: Saturday, November 14, 2026');
    expect(completed.summary).toContain('Time: 4:30–6:30 PM PST');
    expect(completed.summary).not.toContain('2026-11-14T');
    expect(formatCalendarRange('2026-11-14T23:30:00Z','2026-11-15T01:00:00Z',{locale:'invalid_locale',timeZone:'invalid/zone'}))
      .toBe('Start: Saturday, November 14, 2026 at 11:30 PM UTC\nEnd: Sunday, November 15, 2026 at 1:00 AM UTC');
    expect(formatCalendarRange(undefined,'bad',{timeZone:null})).toBe('Start: Not specified\nEnd: Not specified');
    const task=await getTask(db,completed.task_id);
    expect(task.slots).toMatchObject({start:'2026-11-14T16:30:00-08:00',end:'2026-11-14T18:30:00-08:00'});
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1`,[task.id])).toEqual([]);
  });

  it('discards a superseded pre-migration source id when primary intent resolves the current write default',async()=>{
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct-stale',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly'},
      requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await setCapability(db,{connection,capability:'google.calendar.read',enabled:true,actorUserId:user});
    const [stale]=await db.query<{id:string}>(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,writable,is_write_default)
      values($1,$2,'primary','Old primary alias',true,true) returning id`,[user,connection.id]);
    const [current]=await db.query<{id:string}>(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable)
      values($1,$2,'actual-primary','Primary calendar',true,true) returning id`,[user,connection.id]);
    const staleOrigin=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'primary'});
    const currentOrigin=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'actual-primary'});
    await db.query(`update calendar_sync_origins set last_sync_at=now() where id in($1,$2)`,[staleOrigin.id,currentOrigin.id]);

    const previous=await executeAssistantTool(db,ctx(),'draft_calendar_event',{
      source_id:stale.id,title:'Old call',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00',
    }) as any;
    expect(previous.state).toBe('prepared');
    await present(previous,previous.summary);

    await db.query(`update calendar_sources set is_write_default=false where owner_user_id=$1 and is_write_default`,[user]);
    await db.query(`update calendar_sources set is_write_default=true where id=$1`,[current.id]);
    await db.query(`delete from calendar_sources where id=$1`,[stale.id]);
    const next=await executeAssistantTool(db,ctx(),'draft_calendar_event',{
      source_id:stale.id,calendar:'Primary calendar',title:'Fresh call',start:'2026-09-18T16:00:00-07:00',end:'2026-09-18T16:30:00-07:00',
    }) as any;

    expect(next.state,JSON.stringify(next)).toBe('prepared');
    expect(next.summary).toContain('Calendar: Primary calendar');
    const task=await getTask(db,next.task_id);
    expect(task.slots).not.toHaveProperty('source_id');
    expect(task.slots.calendar_source).toMatchObject({source_id:current.id,calendar_id:'actual-primary',calendar_name:'Primary calendar'});
    expect((await db.query<{status:string}>(`select status from assistant_action_states where task_id=$1`,[previous.task_id]))[0].status).toBe('superseded');
  });

  it('does not guess when no write default exists',async()=>{
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct2',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar'},requestedCapabilities:['google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable)
      values($1,$2,'one','One',true,true),($1,$2,'two','Two',false,true)`,[user,connection.id]);
    const first=await executeAssistantTool(db,ctx(),'draft_calendar_event',{title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00'}) as any;
    await present(first,'Which calendar should I use?');
    const result=await executeAssistantTool(db,ctx(),'draft_calendar_event',{calendar:'the main one'}) as any;
    expect(result).toMatchObject({ok:false,error:'select_calendar'});
  });

  it('corrects stale model times and stale source ids from the latest relative request',async()=>{
    await db.query(`insert into workspace(id,name,timezone) values(true,'Test','America/Los_Angeles') on conflict(id) do update set timezone=excluded.timezone`);
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct3',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly'},requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await setCapability(db,{connection,capability:'google.calendar.read',enabled:true,actorUserId:user});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,is_write_default)
      values($1,$2,'stable-primary@example.test','Main calendar',true,true,true)`,[user,connection.id]);
    const origin=await ensureInternalCalendar(db,{ownerUserId:user,connectionId:connection.id,provider:'google',providerCalendarId:'stable-primary@example.test'});
    await db.query(`update calendar_sync_origins set last_sync_at=now() where id=$1`,[origin.id]);

    const result=await executeAssistantTool(db,{
      ...ctx(),latestUserText:'tomorrow at 4pm, 45 minutes',effectiveNow:new Date('2026-09-18T04:00:00.000Z'),
    },'draft_calendar_event',{
      source_id:'00000000-0000-0000-0000-000000000000',calendar:'the main one',title:'Regression check',
      start:'2026-09-17T16:00:00-07:00',end:'2026-09-17T16:30:00-07:00',
    }) as any;
    expect(result.state,JSON.stringify(result)).toBe('prepared');
    const task=await getTask(db,result.task_id);
    expect(task.slots).toMatchObject({
      start:'2026-09-18T16:00:00-07:00',end:'2026-09-18T16:45:00-07:00',
      calendar_time_intent:{kind:'relative_day',localDate:'2026-09-18',localTime:'16:00',durationMinutes:45,timeZone:'America/Los_Angeles'},
      calendar_source:{calendar_id:'stable-primary@example.test',calendar_name:'Main calendar'},
    });
    expect(task.slots.calendar_source).not.toHaveProperty('source_id','00000000-0000-0000-0000-000000000000');

    const retry=await executeAssistantTool(db,{
      ...ctx(),latestUserText:'tomorrow at 5pm, 30 minutes',effectiveNow:new Date('2026-09-18T04:02:00.000Z'),
    },'draft_calendar_event',{
      calendar:'default',title:'Regression check',
      // Deliberately stale model retry: the server must not reuse it.
      start:'2026-09-18T16:00:00-07:00',end:'2026-09-18T16:45:00-07:00',
    }) as any;
    expect(retry.state,JSON.stringify(retry)).toBe('prepared');
    const retriedTask=await getTask(db,retry.task_id);
    expect(retriedTask.slots).toMatchObject({start:'2026-09-18T17:00:00-07:00',end:'2026-09-18T17:30:00-07:00'});
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1 and status='pending'`,[task.id])).toHaveLength(0);
  });
});
