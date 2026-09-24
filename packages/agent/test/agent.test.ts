// One turn of the assistant, against a stubbed model.
//
// No provider is contacted. The model is a function that returns whatever the
// test says, which is the only way to assert what the agent does when a model
// misbehaves — refuses, loops, calls a tool it should not have been offered.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, createThread, seal, verifyStepUp, listTasksFor, createTask } from '@josi-ce/core';
import { runAssistantTurn } from '../src/index.js';
import { setCapability, upsertConnection } from '@josi-ce/connectors';

let db: TestDb;
let alice: string;
let bob: string;

const key = new MasterKey(Buffer.alloc(32, 3));
const resolve = async () => ['1.1.1.1'];

/** Queued model replies, consumed one per hop. */
let replies: Array<{ content?: string | null; tool_calls?: unknown[] }> = [];
let requests: any[] = [];

const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  requests.push(JSON.parse(String(init?.body ?? '{}')));
  const next = replies.shift() ?? { content: 'ok' };
  return new Response(
    JSON.stringify({
      choices: [{ message: next }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

const toolCall = (name: string, args: unknown, id = 't1') => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

const registry = () => ({ db, masterKey: key, fetchImpl, resolve });

async function configureModel(over: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary', 'openai', 'gpt-test', $1, true, now(), now(), $2, true, $3, 8000)
     on conflict (role) do update set
       activated_at = excluded.activated_at, probed_at = excluded.probed_at,
       cap_chat = excluded.cap_chat, cap_tool_calling = excluded.cap_tool_calling`,
    [seal(key, { apiKey: 'k' }), over.cap_chat ?? true, over.cap_tool_calling ?? true],
  );
}

async function turn(over: Record<string, unknown> = {}) {
  const thread = (over.threadId as string) ?? (await createThread(db, { ownerUserId: alice })).id;
  return runAssistantTurn({
    db, registry: registry(), userId: alice, threadId: thread,
    history: [], inbound: 'hello', ...over,
  } as any);
}

beforeEach(async () => {
  db = await testDb();
  replies = [];
  requests = [];
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
});

describe('refusing honestly', () => {
  it('says so when no model is configured, rather than answering anyway', async () => {
    const result = await turn();
    expect(result.refusal?.reason).toBe('no_model');
    expect(result.reply).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('refuses a model that has never been probed', async () => {
    await db.query(
      `insert into llm_providers (role, provider, model, api_key_enc, external_acknowledged)
       values ('primary', 'openai', 'gpt-test', $1, true)`,
      [seal(key, { apiKey: 'k' })],
    );
    const result = await turn();
    expect(result.refusal?.reason).toBe('not_probed');
    // Nothing was sent anywhere.
    expect(requests).toHaveLength(0);
  });

  it('refuses a model that failed its chat probe', async () => {
    // Phase 4's check constraint makes an active-but-failed provider
    // unrepresentable, so this forces the row past it the way a restored
    // database or a hand-edited row would. The point is that the agent refuses
    // on its own account too, rather than relying on the constraint being the
    // only thing standing there.
    await db.query(`alter table llm_providers drop constraint llm_active_requires_probe`);
    await configureModel({ cap_chat: false });
    const result = await turn();
    expect(result.refusal?.reason).toBe('cannot_chat');
    expect(requests).toHaveLength(0);
  });
});

describe('capability gating', () => {
  it('offers no tools to a model that was not proven to call them', async () => {
    await configureModel({ cap_tool_calling: false });
    replies = [{ content: 'I can talk but not act.' }];
    const result = await turn();
    expect(result.reply).toBe('I can talk but not act.');
    // The absence is the point: a tool offered is a promise made.
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].messages[0].content).toMatch(/cannot call tools/i);
  });

  it('offers tools to a model that was', async () => {
    await configureModel();
    replies = [{ content: 'sure' }];
    await turn();
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain('create_task');
  });

  it('tells the model plainly that nothing can carry the work out yet', async () => {
    await configureModel();
    replies = [{ content: 'ok' }];
    await turn();
    const system = requests[0].messages[0].content;
    // Phase 5 ships no executors. The model must not imply anything was sent.
    expect(system).toMatch(/WAIT rather than happen/);
    expect(system).toMatch(/calendar_write|email_send/);
  });

  it('offers calendar writing and removes the false warning when the live grant is on', async () => {
    await configureModel();
    const connection = await upsertConnection(db, key, {
      ownerUserId: alice,
      provider: 'google',
      tokens: {
        accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600,
        grantedScopes: 'https://www.googleapis.com/auth/calendar',
      },
      accountEmail: 'alice@example.test',
      providerAccountId: 'acct-calendar-write',
      requestedCapabilities: ['google.calendar.read', 'google.calendar.write'],
    });
    await setCapability(db, { connection, capability: 'google.calendar.write', enabled: true, actorUserId: alice });
    replies = [{ content: 'ok' }];
    await turn();
    const request = requests[0];
    expect(request.tools.map((t: any) => t.function.name)).toContain('draft_calendar_event');
    expect(request.tools.map((t: any) => t.function.name)).not.toContain('approve_task');
    expect(request.messages[0].content).not.toMatch(/not connected yet[^.]*calendar_write/);
  });

  it('offers approve_task only when an owned generic task is actually waiting', async () => {
    await configureModel();
    const task = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up' });
    await db.query(`update tasks set state='awaiting_approval' where id=$1`, [task.id]);
    replies = [{ content: 'ok' }];
    await turn();
    expect(requests[0].tools.map((t: any) => t.function.name)).toContain('approve_task');
  });

  it('supplies scheduling defaults instead of making the model ask for known context', async () => {
    await configureModel();
    replies = [{ content: 'How long should it be?' }];
    await turn({ inbound: 'Book test on September 5 at 9am' });
    const system = requests[0].messages[0].content;
    expect(system).toMatch(/current local date and time/i);
    expect(system).toMatch(/next occurrence that is not in the past/i);
    expect(system).toMatch(/effective timezone/i);
    expect(system).toMatch(/duration when no end time/i);
    expect(system).toMatch(/Move\/push the EDD call.*modifies the EDD event/i);
    expect(system).toMatch(/original calendar/i);
  });
});

describe('running tools', () => {
  it('creates a task and reports what is still missing', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('create_task', { template_key: 'follow_up', slots: { what: 'call back' } })] },
      { content: 'Started that. When should I chase it?' },
    ];
    const result = await turn();
    expect(result.reply).toMatch(/When should I chase/);
    const action = result.actions[0].result as any;
    expect(action.ok).toBe(true);
    expect(action.missing_slots).toEqual(['when']);
    expect(action.state).toBe('drafting');

    const tasks = await listTasksFor(db, { ownerUserId: alice });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner_user_id).toBe(alice);
  });

  it('marks a complete task ready, and says whether anything can carry it out', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('create_task', {
        template_key: 'follow_up', slots: { what: 'call back', when: 'tomorrow' },
      })] },
      { content: 'done' },
    ];
    const result = await turn();
    const action = result.actions[0].result as any;
    expect(action.state).toBe('ready');
    expect(action.will_be_carried_out).toBe(true);
  });

  it('will not pretend work needing an unconnected capability is under way', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('create_task', {
        template_key: 'send_message',
        slots: { recipient: 'a@b.test', subject: 's', body_brief: 'b' },
      })] },
      { content: 'prepared' },
    ];
    const result = await turn();
    const action = result.actions[0].result as any;
    expect(action.state).toBe('ready');
    expect(action.will_be_carried_out).toBe(false);
    expect(action.waiting_on).toBe('email_send');
    // Nothing was queued, because nothing can run it.
    expect(await db.query(`select id from job_queue`)).toHaveLength(0);
  });

  it('directs native clients to exact approval controls instead of an unthreaded yes',async()=>{
    await configureModel();
    const connection=await upsertConnection(db,key,{ownerUserId:alice,provider:'google',providerAccountId:'native-approval',accountEmail:'native@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/gmail.send'},requestedCapabilities:['google.mail.send']});
    await setCapability(db,{connection,capability:'google.mail.send',enabled:true,actorUserId:alice});
    replies=[
      {content:null,tool_calls:[toolCall('draft_email',{recipient:'recipient@example.test',subject:'Exact subject',body:'Exact body'})]},
      {content:'Type yes to approve.'},
    ];
    const result=await turn({inbound:'Send the exact email',requireApprovalReplyTarget:true});
    expect(result.reply).toMatch(/Use the Approve or Deny control below/i);
    expect(result.reply).not.toMatch(/reply yes|type yes/i);
    expect(result.actions[0].result).toMatchObject({state:'prepared',approval_id:expect.any(String)});
  });

  it('feeds tool results back in the provider dialect the adapter expects', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('list_open_tasks', {})] },
      { content: 'You have none.' },
    ];
    await turn();
    // Second request carries the assistant's tool_calls and a `tool` message.
    const second = requests[1].messages;
    const assistant = second.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls[0].function.name).toBe('list_open_tasks');
    const toolMsg = second.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('t1');
  });

  it('presents tool-backed prose without leaking identifiers while retaining backend actions', async () => {
    await configureModel();
    const task = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up', slots: { what: 'call back' } });
    replies = [
      { content: null, tool_calls: [toolCall('list_open_tasks', {})] },
      { content: `You have one open follow-up. Task ID: ${task.id}` },
    ];
    const result = await turn();
    expect(result.reply).toBe('You have one open follow-up.');
    expect(JSON.stringify(result.actions)).toContain(task.id);
  });

  it('applies the boundary after retries and all accumulated receipts', async () => {
    await configureModel();
    const first = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up', slots: { what: 'first' } });
    const second = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up', slots: { what: 'second' } });
    replies = [
      { content: null, tool_calls: [toolCall('list_open_tasks', {}, 'first-call')] },
      { content: null, tool_calls: [toolCall('list_open_tasks', {}, 'retry-call')] },
      { content: `Two follow-ups are open: ${first.id} and ${second.id}.` },
    ];
    const result = await turn();
    expect(result.actions).toHaveLength(2);
    expect(result.reply).not.toContain(first.id);
    expect(result.reply).not.toContain(second.id);
  });

  it('stops at the hop limit instead of looping forever', async () => {
    await configureModel();
    // A model that only ever calls tools.
    replies = Array.from({ length: 10 }, (_, i) => ({
      content: null, tool_calls: [toolCall('list_open_tasks', {}, `t${i}`)],
    }));
    const result = await turn({ maxHops: 3 });
    expect(result.reply).toMatch(/round in circles/);
    expect(requests).toHaveLength(3);
    const logged = await db.query(`select kind from events where kind = 'agent.hop_limit'`);
    expect(logged).toHaveLength(1);
  });

  it('answers an unknown tool without crashing the turn', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('drop_database', {})] },
      { content: 'I cannot do that.' },
    ];
    const result = await turn();
    expect((result.actions[0].result as any).error).toBe('unknown_tool');
    expect(result.reply).toBe('I cannot do that.');
  });
});

describe('the step-up gate sits in front of the tools', () => {
  it('does not turn a hallucinated approval into reauthentication on a routine turn', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('approve_task', { task_id: '3f19baec-b6b9-42a5-bf7f-3bf1fba3eabf' })] },
      { content: 'I will continue with the requested action instead.' },
    ];
    const result = await turn({ inbound: 'Add the attached invitation to my calendar.' });
    expect(result.actions[0].result).toMatchObject({ ok: false, error: 'tool_unavailable' });
    expect(result.reply).not.toMatch(/reauthentication|password/i);
    expect(await db.query(`select id from events where kind='stepup.required'`)).toEqual([]);
  });

  it('refuses a destructive tool until the session re-authenticates', async () => {
    await configureModel();
    const task = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up' });
    replies = [
      { content: null, tool_calls: [toolCall('cancel_task', { task_id: task.id })] },
      { content: 'Type your password here and I will continue.' },
    ];
    const result = await turn();
    const action = result.actions[0].result as any;
    expect(action.ok).toBe(false);
    expect(action.error).toBe('needs_reauth');
    expect(result.reply).toMatch(/protected reauthentication control in Settings/i);
    expect(result.reply).toMatch(/never send your password in chat/i);
    expect(result.reply).not.toMatch(/type your password|confirm your password/i);
    // And the task really was not cancelled.
    const [row] = await db.query<{ state: string }>(`select state from tasks where id = $1`, [task.id]);
    expect(row.state).toBe('drafting');
  });

  it('allows it once the session has', async () => {
    await configureModel();
    const thread = await createThread(db, { ownerUserId: alice });
    const task = await createTask(db, { ownerUserId: alice, templateKey: 'follow_up' });
    await verifyStepUp(db, {
      userId: alice, sessionKey: thread.id, password: 'x', verifyPassword: async () => true,
    });
    replies = [
      { content: null, tool_calls: [toolCall('cancel_task', { task_id: task.id })] },
      { content: 'Cancelled.' },
    ];
    const result = await turn({ threadId: thread.id });
    expect((result.actions[0].result as any).ok).toBe(true);
    const [row] = await db.query<{ state: string }>(`select state from tasks where id = $1`, [task.id]);
    expect(row.state).toBe('cancelled');
  });

  it('does not gate ordinary conversation', async () => {
    await configureModel();
    replies = [
      { content: null, tool_calls: [toolCall('list_open_tasks', {})] },
      { content: 'none' },
    ];
    const result = await turn();
    expect((result.actions[0].result as any).ok).toBe(true);
  });
});

describe('the agent acts only for the person whose turn it is', () => {
  it('cannot touch a colleague task, and says "no such task" rather than "not yours"', async () => {
    await configureModel();
    const bobsTask = await createTask(db, { ownerUserId: bob, templateKey: 'follow_up' });
    replies = [
      { content: null, tool_calls: [toolCall('update_task_slots', { task_id: bobsTask.id, slots: { what: 'x' } })] },
      { content: 'I could not find that.' },
    ];
    const result = await turn();
    const action = result.actions[0].result as any;
    expect(action.ok).toBe(false);
    // Same wording as a task that does not exist: a model told "that one is not
    // yours" can be steered into enumerating a colleague's ids.
    expect(action.error).toBe('not_found');
    expect(action.message).not.toMatch(/yours|permission|another/i);
    const [row] = await db.query<{ slots: any }>(`select slots from tasks where id = $1`, [bobsTask.id]);
    expect(row.slots).toEqual({});
  });

  it('lists only the acting person tasks', async () => {
    await configureModel();
    await createTask(db, { ownerUserId: bob, templateKey: 'follow_up' });
    await createTask(db, { ownerUserId: alice, templateKey: 'follow_up' });
    replies = [
      { content: null, tool_calls: [toolCall('list_open_tasks', {})] },
      { content: 'one' },
    ];
    const result = await turn();
    expect((result.actions[0].result as any).tasks).toHaveLength(1);
  });
});

describe('spending', () => {
  it('records the turn against the person who spoke', async () => {
    await configureModel();
    replies = [{ content: 'hi' }];
    await turn();
    const [row] = await db.query<{ user_id: string; purpose: string }>(
      `select user_id, purpose from llm_usage`,
    );
    expect(row).toMatchObject({ user_id: alice, purpose: 'assistant_chat' });
  });

  it('stops when the installation is over its cap, and says so plainly', async () => {
    await configureModel();
    await db.query(`update llm_caps set monthly_cost_usd = 1 where id = true`);
    await db.query(
      `insert into llm_usage (provider, model, role, cost_usd, cost_source)
       values ('openai','m','primary',50,'estimated')`,
    );
    const result = await turn();
    expect(result.refusal?.reason).toBe('capped');
    expect(result.refusal?.message).toMatch(/budget/i);
    expect(requests).toHaveLength(0);
  });

  it('refuses under Local-only rather than reaching a hosted provider', async () => {
    await configureModel();
    await db.query(`update security_policy set local_only = true where id = true`);
    const result = await turn();
    expect(result.refusal).toBeTruthy();
    expect(result.refusal?.message).toMatch(/Local-only/);
    expect(requests).toHaveLength(0);
  });
});
