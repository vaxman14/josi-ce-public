import {describe,it,expect} from 'vitest';
import {testDb} from './helpers.js';
import {MasterKey} from '../src/masterKey.js';
import {attachCollectingAction,beginDurableToolEffect,claimDurableTurn,completeDurableToolEffect,completeDurableTurn,createTask,durableTurnHasIncompleteEffects,failDurableTurn,listDurableTurns,looksSealed,markActionsPresented,prepareAction,processPushBatch,processPushReceipts,quietNow,revokeMobileDevice,submitDurableTurn,upsertMobileDevice} from '../src/index.js';

async function owner(db:Awaited<ReturnType<typeof testDb>>,name='alice'){
  const [u]=await db.query<{id:string}>(`insert into users(email,username,role) values($1,$2,'member') returning id`,[`${name}@example.test`,name]);
  const [s]=await db.query<{id:string}>(`insert into sessions(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 day') returning id`,[u.id,`mobile-test-${name}-${crypto.randomUUID()}`]);
  const [t]=await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'mobile') returning id`,[u.id]);return{u,t,s};
}

describe('durable native turns',()=>{
  it('atomically accepts once, binds receipts, and terminally fences a stale worker lease',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    const [a]=await db.query<{id:string}>(`insert into chat_attachments(owner_user_id,thread_id,filename,content_type,byte_size,storage_path,storage_state) values($1,$2,'a.txt','text/plain',1,'x','ready') returning id`,[u.id,t.id]);
    const first=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'native-1',message:'hello',attachmentIds:[a.id]});
    const duplicate=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'native-1',message:'hello',attachmentIds:[a.id]});
    expect(duplicate.duplicate).toBe(true);expect(duplicate.turn.id).toBe(first.turn.id);
    expect((await db.query(`select id from messages`))).toHaveLength(1);
    expect((await db.query(`select id from job_queue where kind='assistant.turn'`))).toHaveLength(1);
    await expect(submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'native-1',message:'different'})).rejects.toMatchObject({code:'idempotency_conflict'});
    const claimed=await claimDurableTurn(db,first.turn.id,1);expect(claimed?.status).toBe('running');
    await db.query(`update assistant_turns set lease_expires_at=now()-interval '1 second' where id=$1`,[first.turn.id]);
    const reclaimed=await claimDurableTurn(db,first.turn.id);expect(reclaimed).toBeNull();
    expect(await completeDurableTurn(db,{turnId:first.turn.id,leaseToken:claimed!.lease_token,reply:'late',toolReceipts:[]})).toBeNull();
    const reconciled=(await listDurableTurns(db,{ownerUserId:u.id,threadId:t.id}))[0];expect(reconciled).toMatchObject({status:'failed',error_code:'worker_interrupted',error_retryable:true});
    expect((await db.query(`select id from messages where direction='out'`))).toHaveLength(0);
    const retry=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'native-2',message:'hello',attachmentIds:[a.id],attemptOf:first.turn.id});
    await expect(submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'native-3',message:'hello',attachmentIds:[a.id],attemptOf:first.turn.id})).rejects.toMatchObject({code:'invalid_receipt_binding'});
    const retryClaim=await claimDurableTurn(db,retry.turn.id);expect(await completeDurableTurn(db,{turnId:retry.turn.id,leaseToken:retryClaim!.lease_token,reply:'done',toolReceipts:[{tool:'read'}]})).toBeTruthy();
    expect((await db.query(`select id from messages where direction='out'`))).toHaveLength(1);
  });

  it('fences consequential effects and refuses linked retries after an ambiguous boundary',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'effect',message:'do it'});
    const turn=await claimDurableTurn(db,accepted.turn.id);const args={turnId:turn!.id,leaseToken:turn!.lease_token,effectKey:'effect-key',toolName:'schedule_reminder'};
    expect(await beginDurableToolEffect(db,args)).toEqual({state:'started'});
    expect(await durableTurnHasIncompleteEffects(db,turn!.id)).toBe(true);
    await expect(beginDurableToolEffect(db,args)).rejects.toThrow(/unknown outcome|cannot be repeated/i);
    expect(await completeDurableToolEffect(db,{...args,receipt:{ok:true,id:'opaque'}})).toBe(true);
    expect(await beginDurableToolEffect(db,args)).toEqual({state:'completed',receipt:{ok:true,id:'opaque'}});
    await db.query(`update assistant_turns set lease_expires_at=now()-interval '1 second' where id=$1`,[turn!.id]);expect(await claimDurableTurn(db,turn!.id)).toBeNull();
    expect((await listDurableTurns(db,{ownerUserId:u.id,threadId:t.id}))[0]).toMatchObject({status:'failed',error_code:'effect_outcome_unknown',error_retryable:false});
    await expect(submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'unsafe-retry',message:'again',attemptOf:turn!.id})).rejects.toMatchObject({code:'invalid_receipt_binding'});
  });

  it('serializes concurrent same-key and same-thread submissions',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    const [a,b]=await Promise.all([
      submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'same',message:'once'}),
      submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'same',message:'once'}),
    ]);expect(a.turn.id).toBe(b.turn.id);expect(await db.query(`select id from messages`)).toHaveLength(1);
    const next=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'next',message:'second'});
    const first=await claimDurableTurn(db,a.turn.id);expect(first).toBeTruthy();expect(await claimDurableTurn(db,next.turn.id)).toBeNull();
    await failDurableTurn(db,{turnId:a.turn.id,leaseToken:first!.lease_token,code:'test',retryable:true});expect(await claimDurableTurn(db,next.turn.id)).toBeTruthy();
  });

  it('bounds idempotency keys by raw UTF-8 bytes',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    await expect(submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'é'.repeat(65),message:'too wide'})).rejects.toMatchObject({code:'invalid_idempotency_key'});
    expect(await db.query(`select id from assistant_turns where thread_id=$1`,[t.id])).toHaveLength(0);
  });

  it('fails queued work closed when the accepting login is revoked',async()=>{
    const db=await testDb(),{u,t,s}=await owner(db);
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,sessionId:s.id,threadId:t.id,clientMessageId:'revoked-session',message:'do not run'});
    await db.query(`update sessions set revoked_at=now() where id=$1`,[s.id]);
    expect(await claimDurableTurn(db,accepted.turn.id)).toBeNull();
    expect((await listDurableTurns(db,{ownerUserId:u.id,threadId:t.id}))[0]).toMatchObject({status:'failed',error_code:'session_expired',error_retryable:false});
  });

  it('enforces the database-backed active-turn capacity before persisting a message',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    await db.query(`insert into assistant_turn_capacity(owner_user_id,active_count) values($1,50)`,[u.id]);
    await expect(submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'over-cap',message:'do not persist'})).rejects.toMatchObject({code:'turn_queue_full'});
    expect(await db.query(`select id from messages where thread_id=$1`,[t.id])).toHaveLength(0);
  });

  it('finds an inbound turn after a long conversation by its receipt',async()=>{
    const db=await testDb(),{u,t}=await owner(db);
    for(let i=0;i<45;i++)await db.query(`insert into messages(thread_id,direction,body) values($1,$2,$3)`,[t.id,i%2?'out':'in',`old-${i}`]);
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'long',message:'new'});
    const [inbound]=await db.query(`select id from messages where id=$1 and thread_id=$2`,[accepted.turn.inbound_message_id,t.id]);expect(inbound).toBeTruthy();
  });

  it('refuses cross-owner attachment and failed-attempt bindings',async()=>{
    const db=await testDb(),a=await owner(db,'a'),b=await owner(db,'b');
    const [file]=await db.query<{id:string}>(`insert into chat_attachments(owner_user_id,thread_id,filename,content_type,byte_size,storage_path,storage_state) values($1,$2,'x','text/plain',1,'x','ready') returning id`,[b.u.id,b.t.id]);
    const [foreignMessage]=await db.query<{id:string}>(`insert into messages(thread_id,direction,body) values($1,'in','foreign') returning id`,[b.t.id]);
    const foreignTurn=await submitDurableTurn(db,{ownerUserId:b.u.id,threadId:b.t.id,clientMessageId:'foreign-turn',message:'foreign'});
    await expect(submitDurableTurn(db,{ownerUserId:a.u.id,threadId:a.t.id,clientMessageId:'x',message:'x',attachmentIds:[file.id]})).rejects.toMatchObject({code:'invalid_receipt_binding'});
    await expect(submitDurableTurn(db,{ownerUserId:a.u.id,threadId:a.t.id,clientMessageId:'reply',message:'x',replyToMessageId:foreignMessage.id})).rejects.toMatchObject({code:'invalid_receipt_binding'});
    await expect(submitDurableTurn(db,{ownerUserId:a.u.id,threadId:a.t.id,clientMessageId:'attempt',message:'x',attemptOf:foreignTurn.turn.id})).rejects.toMatchObject({code:'invalid_receipt_binding'});
    expect(await db.query(`select id from messages where thread_id=$1`,[a.t.id])).toHaveLength(0);
  });
});

describe('Expo push outbox',()=>{
  it('seals tokens, respects DST-aware quiet hours/privacy, tickets then receipts without real network',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,7));
    const device=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'ios',expoToken:'ExpoPushToken[test_token]',appState:'background',privacyLocked:true,quietStart:'23:00',quietEnd:'07:00',timezone:'America/Los_Angeles'});
    const [stored]=await db.query<{expo_token_enc:string}>(`select expo_token_enc from mobile_devices where id=$1`,[device.id]);expect(looksSealed(stored.expo_token_enc)).toBe(true);expect(stored.expo_token_enc).not.toContain('test_token');
    expect(quietNow(new Date('2026-11-01T09:30:00Z'),'America/Los_Angeles','23:00','07:00')).toBe(true);
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body,next_attempt_at) values($1,$2,'e1','assistant','turn',$3,'Private title','Private body',$4)`,[u.id,device.id,t.id,new Date('2026-09-18T20:00:00Z')]);
    let sent:any;const pushFetch=async(_url:any,init:any)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({data:[{status:'ok',id:'ticket-1'}]}),{status:200,headers:{'content-type':'application/json'}})};
    const outcome=await processPushBatch(db,key,pushFetch as typeof fetch,new Date('2026-09-18T20:01:00Z'));expect(outcome.ticketed).toBe(1);expect(sent[0]).toMatchObject({title:'Josi',body:'Open Josi to view this update.',data:{route:'turn',id:t.id}});
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    const receiptFetch=async()=>new Response(JSON.stringify({data:{'ticket-1':{status:'ok'}}}),{status:200,headers:{'content-type':'application/json'}});
    expect((await processPushReceipts(db,receiptFetch as typeof fetch)).providerAccepted).toBe(1);
  });

  it('persists and sends a notification-safe preview of the actual assistant reply',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'reply-preview');const key=new MasterKey(Buffer.alloc(32,17));
    await upsertMobileDevice(db,key,u.id,{deviceIdentity:'19191919-1919-4191-8191-191919191919',platform:'ios',expoToken:'ExpoPushToken[reply_preview]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const complete=async(clientMessageId:string,reply:string)=>{const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId,message:'reply'});const turn=await claimDurableTurn(db,accepted.turn.id);const assistantMessageId=await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply,toolReceipts:[{internal:'must not leak'}]});return{...turn!,assistant_message_id:assistantMessageId};};
    const reply='# Update\n\n**Done** — [open details](https://example.test).\u0007\n> Next step';
    const first=await complete('reply-preview',reply);
    const [stored]=await db.query<{body:string}>(`select body from push_deliveries where event_key=$1`,[`turn:${first.id}`]);expect(stored.body).toBe('Update Done — open details. Next step');expect(stored.body).not.toContain('must not leak');
    const [message]=await db.query<{body:string}>(`select body from messages where id=$1`,[first.assistant_message_id]);expect(message.body).toBe(reply);
    const sent:any[]=[];const fake=async(_u:any,init:any)=>{sent.push(...JSON.parse(init.body));return new Response(JSON.stringify({data:[{status:'ok',id:'reply-preview-ticket'}]}),{status:200,headers:{'content-type':'application/json'}})};
    expect((await processPushBatch(db,key,fake as typeof fetch)).ticketed).toBe(1);expect(sent[0].body).toBe(stored.body);

    const long=await complete('reply-preview-long','🙂'.repeat(400));
    const [longPush]=await db.query<{body:string}>(`select body from push_deliveries where event_key=$1`,[`turn:${long.id}`]);expect(longPush.body.endsWith('…')).toBe(true);expect(Buffer.byteLength(longPush.body,'utf8')).toBeLessThanOrEqual(720);expect(longPush.body).not.toContain('\n');
    const empty=await complete('reply-preview-empty',' \n\t **__~~``~~__** \u0007 ');
    expect((await db.query<{body:string}>(`select body from push_deliveries where event_key=$1`,[`turn:${empty.id}`]))[0].body).toBe('Your reply is ready.');
  });

  it('rotates tokens and revokes the old account binding on account switch',async()=>{
    const db=await testDb(),a=await owner(db,'switch-a'),b=await owner(db,'switch-b');const key=new MasterKey(Buffer.alloc(32,6));
    const old=await upsertMobileDevice(db,key,a.u.id,{deviceIdentity:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform:'ios',expoToken:'ExpoPushToken[switch-old]',appState:'background',privacyLocked:false,timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'old-owner','assistant','turn',$3,'Josi','private old owner body')`,[a.u.id,old.id,a.t.id]);
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body,status,lease_token) values($1,$2,'old-in-flight','assistant','turn',$3,'Josi','generic','sending',$4)`,[a.u.id,old.id,a.t.id,crypto.randomUUID()]);
    const current=await upsertMobileDevice(db,key,b.u.id,{deviceIdentity:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform:'ios',expoToken:'ExpoPushToken[switch-new]',appState:'background',privacyLocked:false,timezone:'UTC'});
    expect((await db.query<{revoked_at:string|null}>(`select revoked_at from mobile_devices where id=$1`,[old.id]))[0].revoked_at).toBeTruthy();
    expect((await db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries where event_key='old-owner'`))[0]).toEqual({status:'suppressed',last_error_code:'account_switched'});
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='old-in-flight'`))[0].status).toBe('sending');
    expect((await db.query<{revoked_at:string|null}>(`select revoked_at from mobile_devices where id=$1`,[current.id]))[0].revoked_at).toBeNull();
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'keep-on-refresh','assistant','turn',$3,'Josi','generic')`,[b.u.id,current.id,b.t.id]);
    await upsertMobileDevice(db,key,b.u.id,{deviceIdentity:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform:'ios',expoToken:'ExpoPushToken[rotated]',appState:'foreground',privacyLocked:true,categories:{assistant:false},timezone:'UTC'});
    expect((await db.query<{token_fingerprint:string}>(`select token_fingerprint from mobile_devices where id=$1`,[current.id]))[0].token_fingerprint).not.toBe('');
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='keep-on-refresh'`))[0].status).toBe('queued');
  });

  it('serializes the final token fence with an account switch',async()=>{
    const db=await testDb(),a=await owner(db,'fence-a'),b=await owner(db,'fence-b');const key=new MasterKey(Buffer.alloc(32,10));
    const old=await upsertMobileDevice(db,key,a.u.id,{deviceIdentity:'ffffffff-ffff-4fff-8fff-ffffffffffff',platform:'ios',expoToken:'ExpoPushToken[fence-old]',appState:'background',privacyLocked:false,timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'fenced','assistant','turn',$3,'Josi','ready')`,[a.u.id,old.id,a.t.id]);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const atBoundary=new Promise<void>(resolve=>{entered=resolve;});
    const dispatch=processPushBatch(db,key,(async()=>{entered();await gate;return new Response(JSON.stringify({data:[{status:'ok',id:'fenced-ticket'}]}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch);
    await atBoundary;
    let switched=false;const switching=upsertMobileDevice(db,key,b.u.id,{deviceIdentity:'ffffffff-ffff-4fff-8fff-ffffffffffff',platform:'ios',expoToken:'ExpoPushToken[fence-new]',appState:'background',privacyLocked:false,timezone:'UTC'}).then(x=>{switched=true;return x;});
    await new Promise(resolve=>setTimeout(resolve,20));expect(switched).toBe(false);
    release();expect((await dispatch).ticketed).toBe(1);await switching;
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='fenced'`))[0].status).toBe('ticketed');
  });

  it('serializes explicit device revocation with final push dispatch',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'revoke-fence');const key=new MasterKey(Buffer.alloc(32,12));
    const device=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'34343434-3434-4343-8343-343434343434',platform:'ios',expoToken:'ExpoPushToken[revoke-fence]',appState:'background',privacyLocked:false,timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'revoke-fenced','assistant','turn',$3,'Josi','ready')`,[u.id,device.id,t.id]);
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const atBoundary=new Promise<void>(resolve=>{entered=resolve;});
    const dispatch=processPushBatch(db,key,(async()=>{entered();await gate;return new Response(JSON.stringify({data:[{status:'ok',id:'revoke-ticket'}]}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch);
    await atBoundary;
    let revoked=false;const revoking=revokeMobileDevice(db,u.id,device.id).then(x=>{revoked=true;return x;});
    await new Promise(resolve=>setTimeout(resolve,20));expect(revoked).toBe(false);
    release();expect((await dispatch).ticketed).toBe(1);expect(await revoking).toBe(true);
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='revoke-fenced'`))[0].status).toBe('ticketed');
  });

  it('retries receipt lookup without resending and does not let an old token receipt revoke a rotated token',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,4));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'ios',expoToken:'ExpoPushToken[old]',appState:'background',privacyLocked:false,timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'receipt','assistant','turn',$3,'Josi','ready')`,[u.id,d.id,t.id]);
    const send=async()=>new Response(JSON.stringify({data:[{status:'ok',id:'old-ticket'}]}),{status:200,headers:{'content-type':'application/json'}});await processPushBatch(db,key,send as typeof fetch);
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    await processPushReceipts(db,(async()=>{throw new Error('network')}) as typeof fetch);
    const [afterNetwork]=await db.query<{status:string}>(`select status from push_deliveries where event_key='receipt'`);expect(afterNetwork.status).toBe('ticketed');
    const noResend=(async()=>{throw new Error('must not resend')}) as typeof fetch;expect((await processPushBatch(db,key,noResend)).sent).toBe(0);
    await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'ios',expoToken:'ExpoPushToken[new]',appState:'background',privacyLocked:false,timezone:'UTC'});
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    const receipt=async()=>new Response(JSON.stringify({data:{'old-ticket':{status:'error',details:{error:'DeviceNotRegistered'}}}}),{status:200,headers:{'content-type':'application/json'}});await processPushReceipts(db,receipt as typeof fetch);
    expect((await db.query<{revoked_at:string|null}>(`select revoked_at from mobile_devices where id=$1`,[d.id]))[0].revoked_at).toBeNull();
  });

  it('captures a foreground completion and sends it after the device backgrounds before dispatch',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'foreground-background');const key=new MasterKey(Buffer.alloc(32,13));
    const input={deviceIdentity:'13131313-1313-4131-8131-131313131313',platform:'ios' as const,expoToken:'ExpoPushToken[foreground_background]',privacyLocked:false,timezone:'UTC'};
    const device=await upsertMobileDevice(db,key,u.id,{...input,appState:'foreground'});
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'foreground-background',message:'finish while open'});
    const turn=await claimDurableTurn(db,accepted.turn.id);await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply:'done',toolReceipts:[]});
    expect(await db.query(`select id from push_deliveries where device_id=$1 and event_key=$2 and status='queued'`,[device.id,`turn:${turn!.id}`])).toHaveLength(1);
    await upsertMobileDevice(db,key,u.id,{...input,appState:'background'});
    const sent:any[]=[];const fake=async(_u:any,init:any)=>{sent.push(...JSON.parse(init.body));return new Response(JSON.stringify({data:[{status:'ok',id:'foreground-background-ticket'}]}),{status:200,headers:{'content-type':'application/json'}})};
    expect((await processPushBatch(db,key,fake as typeof fetch)).ticketed).toBe(1);expect(sent).toHaveLength(1);expect(sent[0].data).toEqual({route:'turn',id:turn!.id});
  });

  it('defers a completion while foreground without spending send attempts, then expires it boundedly',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'foreground-defer');const key=new MasterKey(Buffer.alloc(32,14));
    const device=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'14141414-1414-4141-8141-141414141414',platform:'ios',expoToken:'ExpoPushToken[foreground_defer]',appState:'foreground',privacyLocked:false,timezone:'UTC'});
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'foreground-defer',message:'stay open'});
    const turn=await claimDurableTurn(db,accepted.turn.id);await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply:'done',toolReceipts:[]});
    const now=new Date();const noSend=(async()=>{throw new Error('must not send while foreground')}) as typeof fetch;
    expect(await processPushBatch(db,key,noSend,now)).toMatchObject({sent:0,deferred:1,suppressed:0});
    const [deferred]=await db.query<{status:string;attempts:number;last_error_code:string;next_attempt_at:string}>(`select status,attempts,last_error_code,next_attempt_at from push_deliveries where device_id=$1 and event_key=$2`,[device.id,`turn:${turn!.id}`]);
    expect(deferred).toMatchObject({status:'retry',attempts:0,last_error_code:'foreground'});expect(new Date(deferred.next_attempt_at).getTime()).toBeGreaterThan(now.getTime());
    await db.query(`update mobile_devices set app_state='background' where id=$1`,[device.id]);
    await db.query(`update push_deliveries set created_at=$3,next_attempt_at=$4 where device_id=$1 and event_key=$2`,[device.id,`turn:${turn!.id}`,new Date(now.getTime()-11*60*1000),now]);
    expect(await processPushBatch(db,key,noSend,now)).toMatchObject({sent:0,deferred:0,suppressed:1});
    expect((await db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries where device_id=$1 and event_key=$2`,[device.id,`turn:${turn!.id}`]))[0]).toEqual({status:'suppressed',last_error_code:'foreground_expired'});
  });

  it('completes once and sends once across duplicate completion and worker retry attempts',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'completion-retry');const key=new MasterKey(Buffer.alloc(32,15));
    await upsertMobileDevice(db,key,u.id,{deviceIdentity:'15151515-1515-4151-8151-151515151515',platform:'ios',expoToken:'ExpoPushToken[completion_retry]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'completion-retry',message:'finish once'});
    const turn=await claimDurableTurn(db,accepted.turn.id);const completion={turnId:turn!.id,leaseToken:turn!.lease_token,reply:'done',toolReceipts:[]};
    expect(await completeDurableTurn(db,completion)).toBeTruthy();expect(await completeDurableTurn(db,completion)).toBeNull();
    expect(await db.query(`select id from push_deliveries where event_key=$1`,[`turn:${turn!.id}`])).toHaveLength(1);
    let calls=0;expect(await processPushBatch(db,key,(async()=>{calls++;throw new Error('synthetic network failure')}) as typeof fetch)).toMatchObject({sent:0,retried:1});
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 second' where event_key=$1`,[`turn:${turn!.id}`]);
    const succeeds=async()=>{calls++;return new Response(JSON.stringify({data:[{status:'ok',id:'completion-retry-ticket'}]}),{status:200,headers:{'content-type':'application/json'}})};
    expect((await processPushBatch(db,key,succeeds as typeof fetch)).ticketed).toBe(1);expect((await processPushBatch(db,key,succeeds as typeof fetch)).sent).toBe(0);expect(calls).toBe(2);
  });

  it('rechecks completion revocation, category preferences, and quiet hours before any send',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'completion-policy');const key=new MasterKey(Buffer.alloc(32,16));
    const disabled=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'16161616-1616-4161-8161-161616161616',platform:'ios',expoToken:'ExpoPushToken[completion_disabled]',appState:'background',privacyLocked:false,categories:{assistant:false},timezone:'UTC'});
    const quiet=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'17171717-1717-4171-8171-171717171717',platform:'ios',expoToken:'ExpoPushToken[completion_quiet]',appState:'background',privacyLocked:false,quietStart:'22:00',quietEnd:'07:00',timezone:'UTC'});
    const revoked=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'18181818-1818-4181-8181-181818181818',platform:'ios',expoToken:'ExpoPushToken[completion_revoked]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'completion-policy',message:'apply policy'});
    const turn=await claimDurableTurn(db,accepted.turn.id);await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply:'done',toolReceipts:[]});
    expect(await db.query(`select id from push_deliveries where device_id=$1 and event_key=$2`,[disabled.id,`turn:${turn!.id}`])).toHaveLength(0);
    expect(await db.query(`select id from push_deliveries where event_key=$1`,[`turn:${turn!.id}`])).toHaveLength(2);
    expect(await revokeMobileDevice(db,u.id,revoked.id)).toBe(true);
    const noSend=(async()=>{throw new Error('must not send against policy')}) as typeof fetch;
    const dispatchAt=new Date(Date.now()+24*60*60*1000);dispatchAt.setUTCHours(23,0,0,0);
    expect(await processPushBatch(db,key,noSend,dispatchAt)).toMatchObject({sent:0,suppressed:1});
    const states=await db.query<{device_id:string;status:string;last_error_code:string}>(`select device_id,status,last_error_code from push_deliveries where event_key=$1 order by device_id`,[`turn:${turn!.id}`]);
    expect(states).toEqual(expect.arrayContaining([{device_id:quiet.id,status:'suppressed',last_error_code:'quiet_hours'},{device_id:revoked.id,status:'suppressed',last_error_code:'device_revoked'}]));
  });

  it('continues accepted work through persistence into the push outbox after the client is gone',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,9));
    await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'ios',expoToken:'ExpoPushToken[e2e]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const accepted=await submitDurableTurn(db,{ownerUserId:u.id,threadId:t.id,clientMessageId:'disconnected',message:'finish in background'});
    const turn=await claimDurableTurn(db,accepted.turn.id);await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply:'persisted reply',toolReceipts:[{tool:'read',result:{ok:true}}],replyMeta:{retry:{kind:'none'}}});
    const [persistedTurn]=await db.query<{tool_receipts:any[]}>(`select tool_receipts from assistant_turns where id=$1`,[turn!.id]);expect(persistedTurn.tool_receipts).toEqual([{tool:'read',result:{ok:true}}]);
    expect(await completeDurableTurn(db,{turnId:turn!.id,leaseToken:turn!.lease_token,reply:'duplicate',toolReceipts:[]})).toBeNull();
    expect(await db.query(`select id from messages where direction='out'`)).toHaveLength(1);
    expect(await db.query(`select id from push_deliveries where event_key=$1`,[`turn:${turn!.id}`])).toHaveLength(1);
    const sent:any[]=[];const fake=async(_u:any,init:any)=>{sent.push(...JSON.parse(init.body));return new Response(JSON.stringify({data:[{status:'ok',id:'e2e-ticket'}]}),{status:200,headers:{'content-type':'application/json'}})};
    expect((await processPushBatch(db,key,fake as typeof fetch)).ticketed).toBe(1);expect(sent[0].data).toEqual({route:'turn',id:accepted.turn.id});
    const [persistedReply]=await db.query<{body:string;meta:Record<string,unknown>}>(`select body,meta from messages where direction='out'`);expect(persistedReply.body).toBe('persisted reply');expect(persistedReply.meta).toMatchObject({turn_id:turn!.id,retry:{kind:'none'}});
  });

  it('suppresses ordinary quiet-hour delivery while an explicit reminder bypasses it',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,3));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'ios',expoToken:'ExpoPushToken[quiet]',appState:'foreground',privacyLocked:false,quietStart:'22:00',quietEnd:'07:00',timezone:'UTC',ownerBinding:'owner-hash'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,route_thread_id,title,body,explicit_reminder,next_attempt_at) values($1,$2,'ordinary','assistant','turn',$3,null,'Josi','ordinary',false,$4),($1,$2,'reminder:'||($3::uuid)::text||':7','reminder','reminder',$3,$3,'Josi reminder','explicit',true,$4)`,[u.id,d.id,t.id,new Date('2026-09-18T22:59:00Z')]);
    let messages:any[]=[];const send=async(_url:any,init:any)=>{messages=JSON.parse(init.body);return new Response(JSON.stringify({data:[{status:'ok',id:'quiet-ticket'}]}),{status:200,headers:{'content-type':'application/json'}})};
    const result=await processPushBatch(db,key,send as typeof fetch,new Date('2026-09-18T23:00:00Z'));expect(result).toMatchObject({suppressed:1,ticketed:1});expect(messages).toHaveLength(1);expect(messages[0]).toMatchObject({title:'Josi',body:'explicit',data:{route:'reminder',id:t.id,threadId:t.id,owner:'owner-hash',revision:7}});
  });

  it('preserves supplied reminder and calendar bodies for unlocked devices',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'supplied-push-body');const key=new MasterKey(Buffer.alloc(32,18));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'20202020-2020-4202-8202-202020202020',platform:'ios',expoToken:'ExpoPushToken[supplied_bodies]',appState:'background',privacyLocked:false,timezone:'UTC',ownerBinding:'owner-hash'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,route_thread_id,title,body,explicit_reminder) values($1,$2,'reminder:'||($3::uuid)::text||':9','reminder','reminder',$3,$3,'Josi reminder','Call Alex at 3 PM',true),($1,$2,'supplied-calendar','calendar','task',$3,null,'Josi','Dentist starts in 15 minutes',false)`,[u.id,d.id,t.id]);
    let messages:any[]=[];const send=async(_url:any,init:any)=>{messages=JSON.parse(init.body);return new Response(JSON.stringify({data:[{status:'ok',id:'supplied-1'},{status:'ok',id:'supplied-2'}]}),{status:200,headers:{'content-type':'application/json'}})};
    expect((await processPushBatch(db,key,send as typeof fetch)).ticketed).toBe(2);expect(messages.map(message=>message.body).sort()).toEqual(['Call Alex at 3 PM','Dentist starts in 15 minutes']);
    expect(messages.find(message=>message.body==='Call Alex at 3 PM').data).toEqual({route:'reminder',id:t.id,threadId:t.id,owner:'owner-hash',revision:9});
  });

  it('creates approval outbox only when the exact request is presented',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,1));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',platform:'ios',expoToken:'ExpoPushToken[approval]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const task=await createTask(db,{ownerUserId:u.id,templateKey:'send_message',threadId:t.id,slots:{recipient:'a@example.test',subject:'s',body:'b'}});
    const action=await attachCollectingAction(db,{ownerUserId:u.id,threadId:t.id,domain:'email',operation:'send',taskId:task.id});
    const prepared=await prepareAction(db,{actionState:action,task,summary:'redacted summary',actionClass:'email_send',action:'send'});
    expect(await db.query(`select id from push_deliveries where device_id=$1`,[d.id])).toHaveLength(0);
    const [message]=await db.query<{id:string}>(`insert into messages(thread_id,direction,body) values($1,'out','review it') returning id`,[t.id]);
    await markActionsPresented(db,{ownerUserId:u.id,threadId:t.id,taskIds:[task.id],messageId:message.id});
    expect(await db.query(`select id from push_deliveries where device_id=$1 and event_key=$2 and category='approval' and route_type='approval'`,[d.id,`approval:${prepared.approval.id}`])).toHaveLength(1);
  });

  it('creates task and calendar completion outbox rows transactionally and idempotently',async()=>{
    const db=await testDb(),{u}=await owner(db);const key=new MasterKey(Buffer.alloc(32,5));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',platform:'ios',expoToken:'ExpoPushToken[tasks]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const [ordinary]=await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key,state) values($1,'follow_up','attempting') returning id`,[u.id]);
    const [calendar]=await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key,state) values($1,'schedule_appointment','attempting') returning id`,[u.id]);
    await db.query(`update tasks set state='confirmed' where id=$1`,[ordinary.id]);await db.query(`update tasks set state='failed' where id=$1`,[calendar.id]);
    const rows=await db.query<{event_key:string;category:string;route_type:string;device_id:string}>(`select event_key,category,route_type,device_id from push_deliveries order by event_key`);
    expect(rows).toHaveLength(2);expect(rows).toEqual(expect.arrayContaining([{event_key:`task:${calendar.id}:failed`,category:'calendar',route_type:'task',device_id:d.id},{event_key:`task:${ordinary.id}:confirmed`,category:'assistant',route_type:'task',device_id:d.id}]));
    await db.query(`update tasks set state='confirmed' where id=$1`,[ordinary.id]);expect(await db.query(`select id from push_deliveries where event_key=$1`,[`task:${ordinary.id}:confirmed`])).toHaveLength(1);
  });

  it('rechecks category preferences and classifies permanent Expo ticket errors without retrying',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,2));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',platform:'ios',expoToken:'ExpoPushToken[prefs]',appState:'background',privacyLocked:false,categories:{assistant:false},timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'disabled','assistant','turn',$3,'Josi','ready')`,[u.id,d.id,t.id]);
    expect((await processPushBatch(db,key,(async()=>{throw new Error('must not send')}) as typeof fetch)).suppressed).toBe(1);
    await db.query(`update mobile_devices set categories='{"assistant":true}' where id=$1`,[d.id]);
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'permanent','assistant','turn',$3,'Josi','ready')`,[u.id,d.id,t.id]);
    const permanent=async()=>new Response(JSON.stringify({data:[{status:'error',details:{error:'InvalidCredentials'}}]}),{status:200,headers:{'content-type':'application/json'}});
    expect((await processPushBatch(db,key,permanent as typeof fetch)).retried).toBe(0);
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='permanent'`))[0].status).toBe('failed');
  });

  it('classifies retryable and permanent Expo HTTP and receipt failures',async()=>{
    const db=await testDb(),{u,t}=await owner(db,'classify');const key=new MasterKey(Buffer.alloc(32,11));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'12121212-1212-4121-8121-121212121212',platform:'ios',expoToken:'ExpoPushToken[classify]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const add=(event:string)=>db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,$3,'assistant','turn',$4,'Josi','ready')`,[u.id,d.id,event,t.id]);
    await add('send-408');expect((await processPushBatch(db,key,(async()=>new Response('',{status:408})) as typeof fetch)).retried).toBe(1);
    await add('send-400');await processPushBatch(db,key,(async()=>new Response('',{status:400})) as typeof fetch);
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='send-400'`))[0].status).toBe('failed');
    await add('receipt-rate');await processPushBatch(db,key,(async()=>new Response(JSON.stringify({data:[{status:'ok',id:'rate-ticket'}]}),{status:200})) as typeof fetch);
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute' where event_key='receipt-rate'`);
    await processPushReceipts(db,(async()=>new Response(JSON.stringify({data:{'rate-ticket':{status:'error',details:{error:'MessageRateExceeded'}}}}),{status:200})) as typeof fetch);
    expect((await db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries where event_key='receipt-rate'`))[0]).toEqual({status:'retry',last_error_code:'MessageRateExceeded'});
    await add('receipt-http-400');await processPushBatch(db,key,(async()=>new Response(JSON.stringify({data:[{status:'ok',id:'bad-request-ticket'}]}),{status:200})) as typeof fetch);
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute' where event_key='receipt-http-400'`);
    await processPushReceipts(db,(async()=>new Response('',{status:400})) as typeof fetch);
    expect((await db.query<{status:string}>(`select status from push_deliveries where event_key='receipt-http-400'`))[0].status).toBe('failed');
  });

  it('reclaims a sender crash and revokes DeviceNotRegistered while deferring foreground banners',async()=>{
    const db=await testDb(),{u,t}=await owner(db);const key=new MasterKey(Buffer.alloc(32,8));
    const d=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',platform:'android',expoToken:'ExponentPushToken[dead]',appState:'foreground',privacyLocked:false,timezone:'UTC'});
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'fg','assistant','turn',$3,'Josi','ready')`,[u.id,d.id,t.id]);
    const noSend=(async()=>{throw new Error('must not send')}) as typeof fetch;
    expect((await processPushBatch(db,key,noSend)).deferred).toBe(1);
    await db.query(`update mobile_devices set app_state='background' where id=$1`,[d.id]);
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body,status,updated_at) values($1,$2,'stale','assistant','turn',$3,'Josi','ready','sending',now()-interval '11 minutes')`,[u.id,d.id,t.id]);
    const stale=async()=>new Response(JSON.stringify({data:[{status:'ok',id:'stale-ticket'}]}),{status:200,headers:{'content-type':'application/json'}});expect((await processPushBatch(db,key,stale as typeof fetch)).ticketed).toBe(1);
    await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'dead','assistant','turn',$3,'Josi','ready')`,[u.id,d.id,t.id]);
    const f=async()=>new Response(JSON.stringify({data:[{status:'error',details:{error:'DeviceNotRegistered'}}]}),{status:200,headers:{'content-type':'application/json'}});
    await processPushBatch(db,key,f as typeof fetch);expect((await db.query<{revoked_at:string|null}>(`select revoked_at from mobile_devices where id=$1`,[d.id]))[0].revoked_at).toBeTruthy();
  });
});
