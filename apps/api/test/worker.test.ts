// The worker's job handling.
//
// Exercised as a function rather than by starting the process, so the failure
// paths — unknown kind, missing task, retry, dead — are actually reachable.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { MasterKey, addMessage, attachCollectingAction, authorizeActionByUserPolicy, createTask, createThread, enqueue, markActionsPresented, placeHold, prepareAction, requestApproval, resolveConversationalAction, setSlots, setUserApprovalLevel, transition } from '@josi-ce/core';
import { saveClient, setCapability, setSyncMode, upsertConnection } from '@josi-ce/connectors';
import { processQueue } from '../../worker/src/jobs.js';

let db: TestDb;
let owner: string;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'w@ce.test', username: 'worker-owner', role: 'super_admin' })).id;
});

describe('the worker drains the queue', () => {
  it('claims, runs and completes a job', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

    const outcome = await processQueue(db, 'w1');
    expect(outcome).toEqual({ claimed: 1, done: 1, failed: 0 });
    const [row] = await db.query<{ status: string }>(`select status from job_queue`);
    expect(row.status).toBe('done');
  });

  it('fails an unknown job kind rather than marking it done', async () => {
    // A job nobody handles is a bug. Completing it would hide that forever.
    await enqueue(db, { kind: 'invented.kind' });
    const outcome = await processQueue(db, 'w1');
    expect(outcome.failed).toBe(1);
    const [row] = await db.query<{ status: string; last_error: string }>(
      `select status, last_error from job_queue`,
    );
    expect(row.status).toBe('queued'); // will retry, then go dead
    expect(row.last_error).toMatch(/no handler/);
  });

  it('fails a wake for a task that no longer exists', async () => {
    await enqueue(db, { kind: 'task.wake', payload: { taskId: '00000000-0000-0000-0000-000000000000' } });
    expect((await processQueue(db, 'w1')).failed).toBe(1);
  });

  it('leaves a ready task alone when nothing can carry it out yet', async () => {
    // Phase 5 ships no executors. The honest behaviour is to wait, not to fail
    // — a failed task reads, to the person waiting, like Josi tried and could
    // not.
    const task = await createTask(db, {
      ownerUserId: owner, templateKey: 'send_message',
      slots: { recipient: 'a@b.test', subject: 's', body_brief: 'b' },
    });
    await transition(db, task.id, 'ready');
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });

    expect((await processQueue(db, 'w1')).done).toBe(1);
    const [row] = await db.query<{ state: string; fail_reason: string | null }>(
      `select state, fail_reason from tasks where id = $1`, [task.id],
    );
    expect(row.state).toBe('ready');
    expect(row.fail_reason).toBeNull();
  });

  it('expires holds on schedule', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await placeHold(db, {
      taskId: task.id, resourceKey: 'r', startsAt: new Date(), endsAt: new Date(), ttlSeconds: 1,
    });
    await db.query(`update holds set expires_at = now() - interval '1 minute'`);
    await enqueue(db, { kind: 'holds.expire' });

    await processQueue(db, 'w1');
    const [row] = await db.query<{ status: string }>(`select status from holds`);
    expect(row.status).toBe('expired');
  });

  it('expires approvals nobody answered', async () => {
    const task = await createTask(db, { ownerUserId: owner, templateKey: 'follow_up' });
    await requestApproval(db, {
      taskId: task.id, ownerUserId: owner, actionClass: 'email_send', action: 'send_email',
      summary: 's', payload: {}, ttlSeconds: 1,
    });
    await db.query(`update approvals set expires_at = now() - interval '1 minute'`);
    await enqueue(db, { kind: 'approvals.expire' });

    await processQueue(db, 'w1');
    const [row] = await db.query<{ status: string }>(`select status from approvals`);
    expect(row.status).toBe('expired');
  });

  it('expires the exact native card and cancels its waiting task',async()=>{
    const thread=(await createThread(db,{ownerUserId:owner})).id;
    const task=await createTask(db,{ownerUserId:owner,threadId:thread,templateKey:'schedule_appointment',slots:{title:'Expired event',start:'2026-11-14T16:30:00-08:00',end:'2026-11-14T18:30:00-08:00'}});
    const action=await attachCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'calendar',operation:'create',taskId:task.id});
    const prepared=await prepareAction(db,{actionState:action,task,summary:'Expired event',actionClass:'calendar_write',action:'create'});
    const message=(await addMessage(db,{threadId:thread,direction:'out',body:'Review',meta:{nativeApproval:{approvalId:prepared.approval.id,status:'pending'}}})).id;
    await markActionsPresented(db,{ownerUserId:owner,threadId:thread,taskIds:[task.id],messageId:message});
    await db.query(`update approvals set expires_at=now()-interval '1 minute' where id=$1`,[prepared.approval.id]);
    await db.query(`update assistant_action_states set expires_at=now()-interval '1 minute' where id=$1`,[action.id]);
    await enqueue(db,{kind:'approvals.expire'});

    await processQueue(db,'expire-native');
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[prepared.approval.id]))[0].status).toBe('expired');
    expect((await db.query<{status:string}>(`select status from assistant_action_states where id=$1`,[action.id]))[0].status).toBe('expired');
    expect((await db.query<{state:string}>(`select state from tasks where id=$1`,[task.id]))[0].state).toBe('cancelled');
    expect((await db.query<{status:string}>(`select meta->'nativeApproval'->>'status' status from messages where id=$1`,[message]))[0].status).toBe('expired');
  });

  it('promotes a due schedule into a job', async () => {
    await db.query(
      `insert into schedules (kind, interval_seconds, next_run_at) values ('holds.expire', 60, now() - interval '1 minute')`,
    );
    const outcome = await processQueue(db, 'w1');
    expect(outcome.claimed).toBe(1);
    // And it was rescheduled rather than firing every tick.
    const [row] = await db.query<{ due: boolean }>(`select next_run_at > now() as due from schedules`);
    expect(row.due).toBe(true);
  });

  it('does not hand the same job to two workers', async () => {
    await enqueue(db, { kind: 'holds.expire' });
    const [a, b] = [await processQueue(db, 'w1'), await processQueue(db, 'w2')];
    expect(a.claimed + b.claimed).toBe(1);
  });

  it('keeps job payloads free of content', async () => {
    // A queue row is readable by anything that can reach the database, so a
    // payload carrying a message body would route around every ownership check
    // in the product.
    const task = await createTask(db, {
      ownerUserId: owner, templateKey: 'follow_up', slots: { what: 'PRIVATE-SLOT' },
    });
    await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
    const dump = JSON.stringify(await db.query(`select * from job_queue`));
    expect(dump).not.toContain('PRIVATE-SLOT');
  });
});

describe('user-policy-authorized calendar execution',()=>{
  const key=new MasterKey(Buffer.alloc(32,19));
  async function automaticCalendar(){
    await db.query(`insert into workspace(id,name,timezone) values(true,'Test','America/Los_Angeles') on conflict(id) do update set timezone=excluded.timezone`);
    await setUserApprovalLevel(db,{userId:owner,actionClass:'calendar_write',level:'automatic'});
    const connection=await upsertConnection(db,key,{ownerUserId:owner,provider:'google',providerAccountId:'calendar-worker',accountEmail:'calendar@example.test',tokens:{accessToken:'calendar-access',refreshToken:'calendar-refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar'},requestedCapabilities:['google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:owner});
    const thread=(await createThread(db,{ownerUserId:owner})).id;
    const slots={title:'Vaxman Kids event',start:'2026-11-14T16:30:00-08:00',end:'2026-11-14T18:30:00-08:00',calendar_source:{provider:'google',account_id:connection.id,calendar_id:'vaxman-kids',calendar_name:'Vaxman Kids'}};
    const task=await createTask(db,{ownerUserId:owner,threadId:thread,templateKey:'schedule_appointment',slots});
    const action=await attachCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'calendar',operation:'create',taskId:task.id});
    await authorizeActionByUserPolicy(db,{actionStateId:action.id,actionClass:'calendar_write',action:'create'});
    return {task,thread};
  }
  it('executes a complete calendar write without creating or consuming an approval',async()=>{
    const {task,thread}=await automaticCalendar();
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1`,[task.id])).toEqual([]);
    expect(await processQueue(db,'calendar-policy',20,{masterKey:key})).toMatchObject({done:1,failed:0});
    expect((await db.query<{state:string}>(`select state from tasks where id=$1`,[task.id]))[0].state).toBe('confirmed');
    const [event]=await db.query<{title:string;starts_at:string;ends_at:string}>(`select title,starts_at,ends_at from calendar_events where owner_user_id=$1 and title='Vaxman Kids event'`,[owner]);
    expect(event).toBeTruthy();
    expect(new Date(event.starts_at).toISOString()).toBe('2026-11-15T00:30:00.000Z');
    expect(new Date(event.ends_at).toISOString()).toBe('2026-11-15T02:30:00.000Z');
    expect((await db.query<{status:string}>(`select status from assistant_action_states where task_id=$1`,[task.id]))[0].status).toBe('succeeded');
    const [result]=await db.query<{body:string}>(`select body from messages where thread_id=$1 and direction='out' order by created_at desc limit 1`,[thread]);
    expect(result.body).toContain('Vaxman Kids');
    expect(result.body).toContain('Saturday, November 14, 2026');
    expect(result.body).toContain('4:30–6:30 PM PST');
    expect(result.body).toContain('queued to sync');
  });

  it('refuses a payload changed after automatic authorization',async()=>{
    const {task}=await automaticCalendar();
    await setSlots(db,task.id,{title:'Changed after authorization'},{actor:'user',actorUserId:owner});
    expect(await processQueue(db,'calendar-policy-mutated',20,{masterKey:key})).toMatchObject({done:1,failed:0});
    expect((await db.query<{state:string}>(`select state from tasks where id=$1`,[task.id]))[0].state).toBe('failed');
    expect(await db.query(`select id from calendar_events where owner_user_id=$1 and title='Changed after authorization'`,[owner])).toEqual([]);
  });
});

describe('approved conversational email execution',()=>{
  const key=new MasterKey(Buffer.alloc(32,12));
  async function approvedEmail(){
    await saveClient(db,key,{provider:'google',clientId:'cid',clientSecret:'secret',redirectUri:'https://example.test/callback',actorUserId:owner});
    const connection=await upsertConnection(db,key,{ownerUserId:owner,provider:'google',providerAccountId:'mail-worker',accountEmail:'worker@example.test',
      tokens:{accessToken:'mail-access',refreshToken:'mail-refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/gmail.send'},requestedCapabilities:['google.mail.send']});
    await setCapability(db,{connection,capability:'google.mail.send',enabled:true,actorUserId:owner});
    const thread=(await createThread(db,{ownerUserId:owner})).id;
    const slots={recipient:'romanvaxman14@gmail.com',subject:'testing the coonection',body:'testing the connection',body_brief:'testing the connection'};
    const task=await createTask(db,{ownerUserId:owner,threadId:thread,templateKey:'send_message',slots});
    const action=await attachCollectingAction(db,{ownerUserId:owner,threadId:thread,domain:'email',operation:'send',taskId:task.id});
    await prepareAction(db,{actionState:action,task,summary:'exact email',actionClass:'email_send',action:'send'});
    const out=(await addMessage(db,{threadId:thread,direction:'out',body:'review'})).id;
    await markActionsPresented(db,{ownerUserId:owner,threadId:thread,taskIds:[task.id],messageId:out});
    await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'yes'});
    return {thread,task};
  }

  it('sends the pinned payload once even with a duplicate wake',async()=>{
    const {task}=await approvedEmail();
    await enqueue(db,{kind:'task.wake',payload:{taskId:task.id}});
    let sends=0;
    const fetchImpl=(async(url:RequestInfo|URL)=>{if(String(url).includes('/messages/send'))sends++;return new Response('{}',{status:200});}) as typeof fetch;
    await processQueue(db,'mail-one',20,{masterKey:key,connectorFetch:fetchImpl});
    await processQueue(db,'mail-two',20,{masterKey:key,connectorFetch:fetchImpl});
    expect(sends).toBe(1);
    expect((await db.query<{status:string}>(`select status from assistant_action_states where task_id=$1`,[task.id]))[0].status).toBe('succeeded');
  });

  it('records provider refusal as email-specific failure without retrying the send',async()=>{
    const {thread,task}=await approvedEmail();
    let sends=0;
    const fetchImpl=(async(url:RequestInfo|URL)=>{if(String(url).includes('/messages/send'))sends++;return new Response('{}',{status:503});}) as typeof fetch;
    await processQueue(db,'mail-fail',20,{masterKey:key,connectorFetch:fetchImpl});
    expect(sends).toBe(1);
    await addMessage(db,{threadId:thread,direction:'out',body:'The email failed.',meta:{action_status_domain:'email'}});
    const status=await resolveConversationalAction(db,{ownerUserId:owner,threadId:thread,inbound:'why?'});
    expect(status.reply).toMatch(/email was not sent.*attempt failed/i);
    expect((await db.query<{state:string}>(`select state from tasks where id=$1`,[task.id]))[0].state).toBe('failed');
  });
});

// --------------------------------------------------- scheduled contact sync

describe('the worker syncs contacts on a schedule', () => {
  const key = new MasterKey(Buffer.alloc(32, 9));

  /** A connected account with the contacts capability really granted. */
  async function connect(user: string, token: string) {
    const connection = await upsertConnection(db, key, {
      ownerUserId: user,
      provider: 'google',
      tokens: {
        accessToken: token, refreshToken: `${token}-r`, expiresIn: 3600,
        grantedScopes: 'https://www.googleapis.com/auth/contacts.readonly',
      },
      accountEmail: `${token}@google.test`,
      providerAccountId: `acct-${token}`,
      requestedCapabilities: ['google.contacts.read'],
    });
    await setCapability(db, {
      connection, capability: 'google.contacts.read', enabled: true, actorUserId: user,
    });
    return setSyncMode(db, { connectionId: connection.id, ownerUserId: user, mode: 'import_only' });
  }

  /** Answers per access token, so one person's request cannot receive another's
   * contacts even by mistake. */
  const books: Record<string, Array<Record<string, unknown>>> = {};
  const connectorFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const token = (new Headers(init?.headers as HeadersInit).get('authorization') ?? '')
      .replace(/^Bearer /, '');
    if (String(url).includes('token')) {
      return new Response(JSON.stringify({ access_token: token || 'x', expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({
      connections: books[token] ?? [], nextSyncToken: `tok-${token}`,
    }), { status: 200 });
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    for (const k of Object.keys(books)) delete books[k];
    await saveClient(db, key, {
      provider: 'google', clientId: 'cid', clientSecret: 'SECRET',
      redirectUri: 'https://josi.example.test/api/connections/google/callback',
      actorUserId: owner,
    });
  });

  it('fans a due schedule out into one job per origin, and syncs nothing itself', async () => {
    // One slow provider must delay its own account and nobody else's, so the
    // schedule enqueues rather than syncing inline.
    const origin = await connect(owner, 'owner-token');
    books['owner-token'] = [{
      resourceName: 'people/x1', names: [{ displayName: 'Scheduled Contact' }],
      emailAddresses: [{ value: 'scheduled@example.test' }],
    }];

    await enqueue(db, { kind: 'contacts.sync_due', payload: {} });
    const fanout = await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
    expect(fanout.done).toBe(1);

    const queued = await db.query<{ kind: string; payload: any }>(
      `select kind, payload from job_queue where kind = 'contacts.sync'`,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].payload.originId).toBe(origin.id);
    // The fan-out itself imported nothing.
    expect(await db.query(`select id from contacts`)).toHaveLength(0);

    const run = await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
    expect(run.failed).toBe(0);
    const contacts = await db.query<{ name: string; owner_user_id: string }>(
      `select name, owner_user_id from contacts`,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0].name).toBe('Scheduled Contact');
    expect(contacts[0].owner_user_id).toBe(owner);
  });

  it('keeps two people’s address books apart when the WORKER runs them', async () => {
    // The isolation claim has to hold for a background job as well as for a
    // request: there is no session here, and the owner comes from the origin.
    const other = (await createUser(db, { email: 'o2@ce.test', username: 'other', role: 'member' })).id;
    await connect(owner, 'owner-token');
    await connect(other, 'other-token');
    books['owner-token'] = [{
      resourceName: 'people/o1', names: [{ displayName: 'Owner Client' }],
      emailAddresses: [{ value: 'owner-client@example.test' }],
    }];
    books['other-token'] = [{
      resourceName: 'people/t1', names: [{ displayName: 'Other Client' }],
      emailAddresses: [{ value: 'other-client@example.test' }],
    }];

    await enqueue(db, { kind: 'contacts.sync_due', payload: {} });
    await processQueue(db, 'w1', 10, { masterKey: key, connectorFetch });
    await processQueue(db, 'w1', 10, { masterKey: key, connectorFetch });

    const mine = await db.query<{ name: string }>(
      `select name from contacts where owner_user_id = $1`, [owner],
    );
    const theirs = await db.query<{ name: string }>(
      `select name from contacts where owner_user_id = $1`, [other],
    );
    expect(mine.map((c) => c.name)).toEqual(['Owner Client']);
    expect(theirs.map((c) => c.name)).toEqual(['Other Client']);
  });

  it('stamps the attempt before running, so a crash is not a hot loop', async () => {
    const origin = await connect(owner, 'owner-token');
    await enqueue(db, { kind: 'contacts.sync_due', payload: {} });
    await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });

    const [row] = await db.query<{ last_attempt_at: string | null }>(
      `select last_attempt_at from contact_sync_origins where id = $1`, [origin.id],
    );
    expect(row.last_attempt_at).toBeTruthy();

    // A second fan-out finds nothing due, so the origin is not re-queued on
    // every tick.
    await enqueue(db, { kind: 'contacts.sync_due', payload: {} });
    await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
    expect(await db.query(`select id from job_queue where kind = 'contacts.sync'`)).toHaveLength(1);
  });

  it('fails the job rather than skipping it when the master key is absent', async () => {
    // The tokens are sealed with it. A silent skip would leave an origin that
    // never syncs and never says why.
    await connect(owner, 'owner-token');
    await enqueue(db, { kind: 'contacts.sync', payload: { originId: 'not-checked-yet' } });
    const outcome = await processQueue(db, 'w1', 5, {});
    expect(outcome.failed).toBe(1);
    const [job] = await db.query<{ last_error: string }>(`select last_error from job_queue`);
    expect(job.last_error).toMatch(/master key/i);
  });

  it('records a revoked connection on the origin rather than dying', async () => {
    // A background job that throws is a failure nobody sees. A status on the
    // origin is one the person can act on.
    const origin = await connect(owner, 'owner-token');
    await db.query(`update connections set status = 'revoked' where owner_user_id = $1`, [owner]);

    await enqueue(db, { kind: 'contacts.sync', payload: { originId: origin.id } });
    const outcome = await processQueue(db, 'w1', 5, { masterKey: key, connectorFetch });
    expect(outcome.failed).toBe(0);

    const [after] = await db.query<{ status: string }>(
      `select status from contact_sync_origins where id = $1`, [origin.id],
    );
    expect(after.status).toBe('disconnected');
    expect(await db.query(`select id from contacts`), 'nothing was deleted').toHaveLength(0);
  });

  it('is scheduled by a row the migration installs, exactly once', async () => {
    const rows = await db.query<{ interval_seconds: number; enabled: boolean }>(
      `select interval_seconds, enabled from schedules where kind = 'contacts.sync_due'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
    expect(rows[0].interval_seconds).toBe(120);
  });
});
