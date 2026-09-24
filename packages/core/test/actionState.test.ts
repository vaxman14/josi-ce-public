import { beforeEach, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  activeCollectingAction, addMessage, attachCollectingAction, createTask, decideActionApproval, getTask, markActionsPresented, prepareAction,
  resolveConversationalAction, type AssistantActionState, type Db, type Task,
} from '../src/index.js';

let db: Db; let owner: string; let thread: string;
beforeEach(async()=>{
  db=await testDb();
  owner=(await createUser(db,{email:'actions@example.test',username:'actions',role:'member'})).id;
  thread=(await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Exact transcripts') returning id`,[owner]))[0].id;
});

async function prepared(domain:'email'|'calendar',slots:Record<string,unknown>,messageId?:string){
  const template=domain==='email'?'send_message':'schedule_appointment';
  const task=await createTask(db,{ownerUserId:owner,threadId:thread,templateKey:template,slots});
  const state=await attachCollectingAction(db,{ownerUserId:owner,threadId:thread,domain,operation:domain==='email'?'send':'create',taskId:task.id});
  const out=await prepareAction(db,{actionState:state,task,summary:domain==='email'?'email preview':'calendar preview',actionClass:domain==='email'?'email_send':'calendar_write',action:domain==='email'?'send':'create'});
  const message=messageId??(await addMessage(db,{threadId:thread,direction:'out',body:'Please approve.'})).id;
  await markActionsPresented(db,{ownerUserId:owner,threadId:thread,taskIds:[task.id],messageId:message});
  return {task,state:out as AssistantActionState&{approval:{id:string}}};
}

const emailSlots={recipient:'romanvaxman14@gmail.com',subject:'testing the coonection',body:'testing the connection'};
const calendarSlots={title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00',calendar_source:{source_id:'source-main',provider:'google',account_id:'account-main',calendar_id:'primary',calendar_name:'Main'}};

describe('transactional conversational action state',()=>{
  it('executes the exact immediately presented email approval once and keeps its audit evidence',async()=>{
    const {task,state}=await prepared('email',emailSlots);
    const first=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect(first).toMatchObject({handled:true,action:{domain:'email'}});
    expect((await getTask(db,task.id)).state).toBe('ready');
    expect(await db.query(`select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`,[task.id])).toHaveLength(1);
    const again=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect(again.reply).not.toMatch(/queued the exact/i);
    expect(await db.query(`select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`,[task.id])).toHaveLength(1);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[state.approval.id]))[0].status).toBe('approved');
    expect((await db.query<{kind:string}>(`select kind from events where subject_id=$1 order by created_at`,[task.id])).map(x=>x.kind)).toEqual(expect.arrayContaining(['approval.requested','approval.granted']));
  });

  it('rolls back every approval write when queueing fails',async()=>{
    const {task,state}=await prepared('email',emailSlots);
    const failing:Db={query:db.query,transaction:work=>db.transaction!(tx=>work({
      query:async<T>(sql:string,params?:unknown[])=>{
        if(/insert into job_queue/i.test(sql))throw new Error('synthetic queue failure');
        return tx.query<T>(sql,params);
      },
    }))};
    await expect(decideActionApproval(failing,{approvalId:state.approval.id,decidedBy:owner,approve:true}))
      .rejects.toThrow(/synthetic queue failure/);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[state.approval.id]))[0].status).toBe('pending');
    expect((await getTask(db,task.id)).state).toBe('awaiting_approval');
    expect((await db.query<{status:string}>(`select status from assistant_action_states where task_id=$1`,[task.id]))[0].status).toBe('prepared');
  });

  it('requires a durable queued yes to target the exact presented approval message',async()=>{
    const email=await prepared('email',emailSlots);
    const [presented]=await db.query<{presented_turn_id:string}>(`select presented_turn_id from assistant_action_states where task_id=$1`,[email.task.id]);
    const untargeted=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes',requireReplyTarget:true,replyToMessageId:null});
    expect(untargeted.reply).toMatch(/reply directly/i);expect((await getTask(db,email.task.id)).state).toBe('awaiting_approval');
    const wrong=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes',requireReplyTarget:true,replyToMessageId:'00000000-0000-4000-8000-000000000099'});
    expect(wrong.reply).toMatch(/reply directly/i);expect((await getTask(db,email.task.id)).state).toBe('awaiting_approval');
    const targeted=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes',requireReplyTarget:true,replyToMessageId:presented.presented_turn_id});
    expect(targeted.reply).toMatch(/queued the exact/i);expect((await getTask(db,email.task.id)).state).toBe('ready');
  });

  it('keeps calendar and email namespaces isolated in both interleaving directions',async()=>{
    const email=await prepared('email',emailSlots);
    const calendar=await prepared('calendar',calendarSlots);
    await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect((await getTask(db,calendar.task.id)).state).toBe('ready');
    expect((await getTask(db,email.task.id)).state).toBe('awaiting_approval');

    const thread2=(await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Reverse') returning id`,[owner]))[0].id;
    thread=thread2;
    const calendar2=await prepared('calendar',calendarSlots);
    const email2=await prepared('email',emailSlots);
    await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect((await getTask(db,email2.task.id)).state).toBe('ready');
    expect((await getTask(db,calendar2.task.id)).state).toBe('awaiting_approval');
  });

  it('rejects an ambiguous yes and honors denial and expiry without execution',async()=>{
    const message=(await addMessage(db,{threadId:thread,direction:'out',body:'Two previews'})).id;
    const email=await prepared('email',emailSlots,message);
    const calendar=await prepared('calendar',calendarSlots,message);
    const ambiguous=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect(ambiguous.reply).toMatch(/ambiguous/i);
    expect((await getTask(db,email.task.id)).state).toBe('awaiting_approval');
    expect((await getTask(db,calendar.task.id)).state).toBe('awaiting_approval');

    await db.query(`update assistant_action_states set status='superseded' where task_id=$1`,[calendar.task.id]);
    const denied=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'no'});
    expect(denied.reply).toMatch(/not sent/i);
    expect((await getTask(db,email.task.id)).state).toBe('cancelled');

    const fresh=await prepared('calendar',calendarSlots);
    await db.query(`update assistant_action_states set expires_at=now()-interval '1 minute' where task_id=$1`,[fresh.task.id]);
    const expired=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect(expired.reply).toMatch(/expired/i);
    expect((await getTask(db,fresh.task.id)).state).toBe('cancelled');
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[fresh.state.approval.id]))[0].status).toBe('expired');
  });

  it('answers email execution status from email state, never stale calendar names',async()=>{
    await prepared('calendar',{...calendarSlots,title:'LexisNexis'});
    const email=await prepared('email',emailSlots);
    const status=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'was it sent?'});
    expect(status.reply).toMatch(/email.*waiting for your approval/i);
    expect(status.reply).not.toMatch(/EDD|LexisNexis/);
    await addMessage(db,{threadId:thread,direction:'out',body:status.reply!,meta:{action_status_domain:'email'}});
    await db.query(`update assistant_action_states set status='failed' where task_id=$1`,[email.task.id]);
    await db.query(`update tasks set state='failed',fail_reason='provider_unavailable' where id=$1`,[email.task.id]);
    const why=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'why?'});
    expect(why.reply).toMatch(/email was not sent.*failed/i);
    expect(why.reply).not.toMatch(/EDD|LexisNexis/);
  });

  it('does not apply yes after a later unrelated assistant turn',async()=>{
    const email=await prepared('email',emailSlots);
    await addMessage(db,{threadId:thread,direction:'out',body:'An unrelated later answer.'});
    const result=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    expect(result.reply).toMatch(/do not have one immediately preceding/i);
    expect((await getTask(db,email.task.id)).state).toBe('awaiting_approval');
  });

  it('continues a partial draft only from its immediately preceding presented turn',async()=>{
    const task=await createTask(db,{ownerUserId:owner,threadId:thread,templateKey:'send_message',slots:{recipient:'first@example.test'}});
    const state=await attachCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'email',operation:'send',taskId:task.id});
    const prompt=await addMessage(db,{threadId:thread,direction:'out',body:'What subject and body should I use?'});
    await markActionsPresented(db,{ownerUserId:owner,threadId:thread,taskIds:[task.id],messageId:prompt.id});
    expect((await activeCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'email',operation:'send'}))?.id).toBe(state.id);

    await addMessage(db,{threadId:thread,direction:'out',body:'An unrelated answer interrupted the draft.'});
    expect(await activeCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'email',operation:'send'})).toBeNull();
    expect((await db.query<{status:string}>(`select status from assistant_action_states where id=$1`,[state.id]))[0].status).toBe('superseded');
    expect((await getTask(db,task.id)).state).toBe('cancelled');
  });
});
