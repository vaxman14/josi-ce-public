import { describe, expect, it } from 'vitest';
import { calendarEventUrl, runJob } from '../src/jobs.js';
import { testDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { MasterKey, createThread, processPushBatch, seal, submitDurableTurn, upsertMobileDevice, type Job } from '@josi-ce/core';

describe('calendar write target', () => {
  it('writes Google events to the selected calendar instead of primary', () => {
    expect(calendarEventUrl('google', 'vaxman kids@example.test')).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/vaxman%20kids%40example.test/events',
    );
  });

  it('keeps the selected Microsoft calendar and event for edits', () => {
    expect(calendarEventUrl('microsoft', 'calendar/id', 'event/id')).toBe(
      'https://graph.microsoft.com/v1.0/me/calendars/calendar%2Fid/events/event%2Fid',
    );
  });
});

describe('durable native end to end',()=>{
  it('continues send -> disconnect -> worker -> persist -> push with synthetic providers',async()=>{
    const db=await testDb();const key=new MasterKey(Buffer.alloc(32,5));
    const user=await createUser(db,{email:'mobile@worker.test',username:'mobile-worker',role:'member'});
    await db.query(`insert into sessions(user_id,token_hash,expires_at) values($1,'mobile-worker-session',now()+interval '1 day')`,[user.id]);
    const thread=await createThread(db,{ownerUserId:user.id});
    await db.query(`insert into llm_providers(role,provider,model,api_key_enc,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_context_tokens) values('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,[seal(key,{apiKey:'test'})]);
    await upsertMobileDevice(db,key,user.id,{deviceIdentity:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',platform:'ios',expoToken:'ExpoPushToken[worker_e2e]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const accepted=await submitDurableTurn(db,{ownerUserId:user.id,threadId:thread.id,clientMessageId:'disconnected-client',message:'hello after quit'});
    const [job]=await db.query<Job>(`select * from job_queue where kind='assistant.turn' and payload->>'turnId'=$1`,[accepted.turn.id]);
    const llmFetch=async()=>new Response(JSON.stringify({choices:[{message:{content:'background reply'}}],usage:{prompt_tokens:2,completion_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
    await runJob(db,job,{masterKey:key,llmFetch:llmFetch as typeof fetch,llmResolve:async()=>['203.0.113.5']});
    const [turn]=await db.query<{status:string}>(`select status from assistant_turns where id=$1`,[accepted.turn.id]);expect(turn.status).toBe('completed');
    const [reply]=await db.query<{body:string}>(`select body from messages where thread_id=$1 and direction='out'`,[thread.id]);expect(reply.body).toBe('background reply');
    const push=async()=>new Response(JSON.stringify({data:[{status:'ok',id:'worker-ticket'}]}),{status:200,headers:{'content-type':'application/json'}});
    expect((await processPushBatch(db,key,push as typeof fetch)).ticketed).toBe(1);
  });
});
