// The assistant over the wire.
//
// Written from the attacker's side, like the Phase 1 authorization suite: a
// signed-in colleague who knows a thread id, and a super admin who is curious
// about what someone has been asking Josi. Both are legitimate users of the
// installation, which is exactly why hiding the navigation would not stop them.
//
// The Phase 5 schema added three owner-scoped resource types. If the spine were
// going to be bypassed anywhere, it would be in the new routes, so these run
// against the real router stack and a real migrated database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createReminder, json, seal, MasterKey } from '@josi-ce/core';
import { ensureInternalCalendar, saveClient, setCapability, upsertConnection } from '@josi-ce/connectors';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-assistant-'));
const keyPath = join(dir, 'master.key');
const KEY_BYTES = Buffer.alloc(32, 4);
writeFileSync(keyPath, KEY_BYTES.toString('base64'));

let server: Server;
let base: string;
let db: TestDb;
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

let replies: Array<{ content?: string | null; tool_calls?: unknown[] }> = [];
let llmRequests: any[] = [];
const llmFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  llmRequests.push(JSON.parse(String(init?.body ?? '{}')));
  const next = replies.shift() ?? { content: 'ok' };
  return new Response(
    JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;
const llmResolve = async () => ['203.0.113.5'];
const connectorFetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

interface Res { status: number; body: any; setCookie: string[]; headers: Headers }

async function call(
  path: string,
  opts: { method?: string; body?: unknown; jar?: string; headers?: Record<string,string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.jar) headers.cookie = opts.jar;
  const token = opts.jar ? /josi_csrf=([^;]+)/.exec(opts.jar)?.[1] : undefined;
  if (token) headers['x-josi-csrf'] = decodeURIComponent(token);
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [], headers:res.headers };
}

function mergeJar(existing: string | undefined, setCookie: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (existing ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const raw of setCookie) {
    const first = raw.split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(identifier: string, password: string): Promise<string> {
  const pre = await call('/api/auth/csrf');
  let jar = mergeJar(undefined, pre.setCookie);
  const res = await call('/api/auth/login', { method: 'POST', body: { identifier, password }, jar });
  expect(res.status, `login ${identifier}`).toBe(200);
  return mergeJar(jar, res.setCookie);
}

const PW = { admin: 'admin-password-123', alice: 'alice-password-123', bob: 'bob-password-123' };

beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin', password: PW.admin })).id;
  ids.alice = (await createUser(db, { email: 'alice@ce.test', username: 'alice', role: 'member', password: PW.alice })).id;
  ids.bob = (await createUser(db, { email: 'bob@ce.test', username: 'bob', role: 'member', password: PW.bob })).id;

  const app = createApp(db, {
    cookieSecure: false, appUrl: 'http://localhost:3000',
    masterKeyCheck: { path: keyPath }, llmFetch, llmResolve, connectorFetch,
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cookies.admin = await signIn('admin', PW.admin);
  cookies.alice = await signIn('alice', PW.alice);
  cookies.bob = await signIn('bob', PW.bob);
});

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

beforeEach(async () => {
  replies = [];
  llmRequests = [];
  await db.query(`delete from approvals`);
  await db.query(`delete from reminders`);
  await db.query(`delete from tasks`);
  await db.query(`delete from messages`);
  await db.query(`delete from threads`);
  await db.query(`delete from contacts`);
  await db.query(`delete from resource_shares`);
  await db.query(`delete from step_up_verifications`);
  await db.query(`delete from user_approval_prefs`);
  await db.query(`delete from admin_approval_policy`);
  await db.query(`delete from llm_providers`);
  await db.query(`delete from llm_usage`);
  await db.query(`delete from rate_limits where bucket='durable_turn'`);
  await db.query(`update security_policy set local_only = false where id = true`);
});

async function configureModel(): Promise<void> {
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,
    [seal(new MasterKey(KEY_BYTES), { apiKey: 'k' })],
  );
}

/** A thread with one exchange in it, owned by whoever is named. */
async function threadWith(owner: 'alice' | 'bob', text = 'PRIVATE-CONVERSATION-TEXT') {
  const created = await call('/api/assistant/threads', {
    method: 'POST', jar: cookies[owner], body: { title: 'mine' },
  });
  const id = created.body.thread.id;
  await db.query(`insert into messages (thread_id, direction, body) values ($1, 'in', $2)`, [id, text]);
  return id;
}

describe('durable native turns and devices',()=>{
  it('returns 202 before model work, reconciles, and idempotently returns the stable turn',async()=>{
    const threadId=await threadWith('alice');
    const body={client_message_id:'phone-1',message:'continue after disconnect'};
    const accepted=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body});
    expect(accepted.status).toBe(202);expect(accepted.body.turn).toMatchObject({status:'queued',lifecycle_state:'accepted_queued'});expect(accepted.body.turn.job_id).toBe(accepted.body.turn.id);expect(accepted.body.telemetry).toEqual({state:'accepted_queued',turn_id:accepted.body.turn.id,thread_id:threadId});expect(JSON.stringify(accepted.body)).not.toContain(body.message);expect(llmRequests).toHaveLength(0);
    const duplicate=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body});
    expect(duplicate.status).toBe(202);expect(duplicate.body.duplicate).toBe(true);expect(duplicate.body.turn.id).toBe(accepted.body.turn.id);
    for(let i=0;i<25;i++)expect((await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body})).status).toBe(202);
    const state=await call(`/api/assistant/threads/${threadId}/turns`,{jar:cookies.alice});
    expect(state.status).toBe(200);expect(state.body.turns[0]).toMatchObject({id:accepted.body.turn.id,job_id:accepted.body.turn.id,status:'queued',lifecycle_state:'accepted_queued'});expect(typeof state.body.next_cursor).toBe('string');
    expect((await call(`/api/assistant/threads/${threadId}/turns?turn_id=${accepted.body.turn.id}`,{jar:cookies.alice})).body.turns).toHaveLength(1);
    expect((await call(`/api/assistant/threads/${threadId}/turns`,{jar:cookies.bob})).status).toBe(404);
    expect((await call(`/api/assistant/threads/${threadId}/turns?after=not-a-date`,{jar:cookies.alice})).body.code).toBe('invalid_reconciliation_cursor');
    const mismatch=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,headers:{'Idempotency-Key':'header-key'},body:{client_message_id:'body-key',message:'x'}});
    expect(mismatch.status).toBe(409);expect(mismatch.body.code).toBe('idempotency_conflict');
    const overlong=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body:{client_message_id:'x'.repeat(129),message:'x'}});
    expect(overlong.status).toBe(400);expect(overlong.body.code).toBe('invalid_idempotency_key');
    const paddedOverlong=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body:{client_message_id:` ${'x'.repeat(127)} `,message:'x'}});
    expect(paddedOverlong.status).toBe(400);expect(paddedOverlong.body.code).toBe('invalid_idempotency_key');
    const byteOverlong=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,headers:{'Idempotency-Key':'é'.repeat(65)},body:{message:'x'}});
    expect(byteOverlong.status).toBe(400);expect(byteOverlong.body.code).toBe('invalid_idempotency_key');
    await db.query(`update assistant_turns set status='failed',error_code='test',error_retryable=true where id=$1`,[accepted.body.turn.id]);
    const terminalDuplicate=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body});
    expect(terminalDuplicate.body.turn).toMatchObject({id:accepted.body.turn.id,status:'failed',lifecycle_state:'terminal_failed'});expect(terminalDuplicate.body.telemetry.state).toBe('terminal_failed');
  });

  it('rate-limits native submission bursts with retry guidance',async()=>{
    const threadId=await threadWith('alice');
    for(let i=0;i<20;i++)expect((await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body:{client_message_id:`burst-${i}`,message:'queued'}})).status).toBe(202);
    const limited=await call(`/api/assistant/threads/${threadId}/turns`,{method:'POST',jar:cookies.alice,body:{client_message_id:'burst-over',message:'queued'}});
    expect(limited.status).toBe(429);expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('seals Expo tokens and never returns ciphertext or plaintext',async()=>{
    const registered=await call('/api/assistant/devices',{method:'PUT',jar:cookies.alice,body:{device_identity:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',platform:'ios',expo_token:'ExpoPushToken[api_test]',app_state:'background',privacy_locked:true,categories:{assistant:true},quiet_start:'22:00',quiet_end:'07:00',timezone:'America/Los_Angeles'}});
    expect(registered.status).toBe(200);
    const listed=await call('/api/assistant/devices',{jar:cookies.alice});expect(JSON.stringify(listed.body)).not.toContain('api_test');expect(JSON.stringify(listed.body)).not.toContain('expo_token_enc');
    const [stored]=await db.query<{expo_token_enc:string;owner_binding:string}>(`select expo_token_enc,owner_binding from mobile_devices where id=$1`,[registered.body.device.id]);expect(stored.expo_token_enc).not.toContain('api_test');expect(stored.owner_binding).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(listed.body)).not.toContain('owner_binding');
    expect((await call(`/api/assistant/devices/${registered.body.device.id}`,{method:'DELETE',jar:cookies.bob})).status).toBe(404);
  });
});

describe('anonymous callers', () => {
  it('are refused every assistant surface', async () => {
    const anonJar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);
    for (const [method, path] of [
      ['GET', '/api/assistant/threads'],
      ['POST', '/api/assistant/threads'],
      ['GET', '/api/assistant/tasks'],
      ['GET', '/api/assistant/approvals'],
      ['GET', '/api/assistant/contacts'],
      ['GET', '/api/assistant/metrics'],
      ['POST', '/api/assistant/step-up'],
    ] as Array<[string, string]>) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(path, { method, body, jar: anonJar })).status, path).toBe(401);
    }
  });
});

describe('one member cannot reach another member conversation', () => {
  it('answers 404, not 403, for a thread that exists', async () => {
    const aliceThread = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${aliceThread}`, { jar: cookies.bob });
    // 403 would confirm the thread exists, which is the fact it is private to
    // protect.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE-CONVERSATION-TEXT');
  });

  it('answers the same 404 for a thread that does not exist', async () => {
    const real = await call(`/api/assistant/threads/${await threadWith('alice')}`, { jar: cookies.bob });
    const fake = await call('/api/assistant/threads/00000000-0000-0000-0000-000000000000', { jar: cookies.bob });
    expect(fake.status).toBe(real.status);
    expect(fake.body).toEqual(real.body);
  });

  it('cannot speak into it', async () => {
    const aliceThread = await threadWith('alice');
    await configureModel();
    const res = await call(`/api/assistant/threads/${aliceThread}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'hello' },
    });
    expect(res.status).toBe(404);
  });

  it('does not see it in their own list', async () => {
    await threadWith('alice');
    const res = await call('/api/assistant/threads', { jar: cookies.bob });
    expect(res.body.threads).toHaveLength(0);
  });
});

describe('one member cannot reach another member tasks or contacts', () => {
  it('404s a colleague task and refuses to change it', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key, slots) values ($1,'follow_up','{"what":"PRIVATE-TASK-DETAIL"}') returning id`,
      [ids.alice],
    );
    expect((await call(`/api/assistant/tasks/${task.id}`, { jar: cookies.bob })).status).toBe(404);
    const patch = await call(`/api/assistant/tasks/${task.id}`, {
      method: 'PATCH', jar: cookies.bob, body: { state: 'cancelled' },
    });
    expect(patch.status).toBe(404);
    const [row] = await db.query<{ state: string }>(`select state from tasks where id = $1`, [task.id]);
    expect(row.state).toBe('drafting');
  });

  it('404s a colleague contact', async () => {
    const created = await call('/api/assistant/contacts', {
      method: 'POST', jar: cookies.alice, body: { name: 'PRIVATE-CONTACT', email: 'p@x.test' },
    });
    const res = await call(`/api/assistant/contacts/${created.body.contact.id}`, { jar: cookies.bob });
    expect(res.status).toBe(404);
    expect((await call('/api/assistant/contacts', { jar: cookies.bob })).body.contacts).toHaveLength(0);
  });
});

describe('the super admin administers plumbing, not content', () => {
  it('is refused a member thread exactly like any other non-owner', async () => {
    const aliceThread = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${aliceThread}`, { jar: cookies.admin });
    expect(res.status).toBe(404);
  });

  it('is refused a member task', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key) values ($1,'follow_up') returning id`,
      [ids.alice],
    );
    expect((await call(`/api/assistant/tasks/${task.id}`, { jar: cookies.admin })).status).toBe(404);
  });

  it('gets counts and health, and no content at all', async () => {
    await threadWith('alice', 'ADMIN-MUST-NOT-SEE-THIS');
    await db.query(
      `insert into tasks (owner_user_id, template_key, slots) values ($1,'follow_up','{"what":"ADMIN-MUST-NOT-SEE-SLOT"}')`,
      [ids.alice],
    );
    await call('/api/assistant/contacts', {
      method: 'POST', jar: cookies.alice, body: { name: 'ADMIN-MUST-NOT-SEE-NAME' },
    });

    const res = await call('/api/admin/assistant', { jar: cookies.admin });
    expect(res.status).toBe(200);
    expect(res.body.counts.threads).toBe(1);
    expect(res.body.counts.tasks).toBe(1);
    expect(res.body.counts.contacts).toBe(1);

    const dump = JSON.stringify(res.body);
    for (const secret of ['ADMIN-MUST-NOT-SEE-THIS', 'ADMIN-MUST-NOT-SEE-SLOT', 'ADMIN-MUST-NOT-SEE-NAME']) {
      expect(dump, secret).not.toContain(secret);
    }
    // Whose work it is, and how much of it, is administration.
    expect(res.body.perUser.find((u: any) => u.username === 'alice').tasks).toBe(1);
  });

  it('cannot be reached by a member', async () => {
    expect((await call('/api/admin/assistant', { jar: cookies.alice })).status).toBe(403);
  });
});

describe('sharing is explicit, and read is not write', () => {
  async function share(threadId: string, canWrite: boolean) {
    await db.query(
      `insert into resource_shares (resource_type, resource_id, owner_user_id, shared_with_user_id, can_write)
       values ('thread', $1, $2, $3, $4)`,
      [threadId, ids.alice, ids.bob, canWrite],
    );
  }

  it('lets a named colleague read once shared', async () => {
    const t = await threadWith('alice', 'SHARED-TEXT');
    expect((await call(`/api/assistant/threads/${t}`, { jar: cookies.bob })).status).toBe(404);
    await share(t, false);
    const res = await call(`/api/assistant/threads/${t}`, { jar: cookies.bob });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('SHARED-TEXT');
  });

  it('does not let a read-only share speak into the conversation', async () => {
    await configureModel();
    const t = await threadWith('alice');
    await share(t, false);
    // Following a conversation is not the same as speaking in it as its owner.
    expect((await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'hi' },
    })).status).toBe(404);
  });

  it('runs a write-shared turn as the OWNER, so nothing is created under the wrong name', async () => {
    await configureModel();
    const t = await threadWith('alice');
    await share(t, true);
    replies = [{ content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'create_task', arguments: JSON.stringify({ template_key: 'follow_up', slots: { what: 'x', when: 'y' } }) } }] }, { content: 'done' }];

    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.bob, body: { message: 'make me a task' },
    });
    expect(res.status).toBe(200);
    const [task] = await db.query<{ owner_user_id: string }>(`select owner_user_id from tasks`);
    // Bob spoke; the task belongs to Alice, whose thread it is. A share must
    // not be a way to make Josi act under someone else's name.
    expect(task.owner_user_id).toBe(ids.alice);
  });
});

describe('talking to Josi', () => {
  it('refuses honestly when no model is configured, and invents no reply', async () => {
    const t = await threadWith('alice');
    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'hello' },
    });
    expect(res.status).toBe(503);
    expect(res.body.refusal.reason).toBe('no_model');
    expect(res.body).not.toHaveProperty('reply');
    // What the person said is kept; nothing is fabricated as an answer. The
    // claim that matters is the absence of an outbound message — a refusal
    // dressed up as a reply is the failure this guards against.
    const messages = await db.query<{ direction: string; body: string }>(
      `select direction, body from messages where thread_id = $1 order by created_at`, [t],
    );
    expect(messages.filter((m) => m.direction === 'out')).toHaveLength(0);
    expect(messages.map((m) => m.body)).toContain('hello');
  });

  it('records both sides of a real exchange', async () => {
    await configureModel();
    const t = await threadWith('alice');
    replies = [{ content: 'Hello Alice.' }];
    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'hi there' },
    });
    expect(res.body.reply).toBe('Hello Alice.');
    expect(res.body).not.toHaveProperty('actions');
    const messages = await db.query<{ direction: string; body: string }>(
      `select direction, body from messages where thread_id = $1 order by created_at`, [t],
    );
    expect(messages.map((m) => m.body)).toContain('hi there');
    expect(messages.map((m) => m.body)).toContain('Hello Alice.');
  });

  it('presents tool-backed replies without exposing actions or internal identifiers', async () => {
    await configureModel();
    const t = await threadWith('alice');
    const [task] = await db.query<{ id: string }>(
      `insert into tasks(owner_user_id,template_key,slots) values($1,'follow_up','{"what":"call back"}') returning id`,
      [ids.alice],
    );
    replies = [
      { content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'list_open_tasks', arguments: '{}' } }] },
      { content: `You have one open follow-up. Task ID: ${task.id}` },
    ];
    const res = await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'What is open?' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reply: 'You have one open follow-up.' });
    expect(JSON.stringify(res.body)).not.toContain(task.id);
    expect((await db.query(`select id from tasks where id=$1`, [task.id]))).toHaveLength(1);
  });

  it('carries verified calendar receipts into a follow-up without exposing them in chat', async () => {
    await configureModel();
    const t = await threadWith('alice');
    const receipt = {
      tool: 'query_calendar',
      result: {
        ok: true,
        events: [{ title: 'EDD call', event_id: 'calendar:source:event', source_id: 'source', calendar_name: 'Roman' }],
      },
    };
    await db.query(
      `insert into messages(thread_id,direction,channel,body,meta) values($1,'out','web',$2,$3::jsonb)`,
      [t, 'Should I replace the EDD call or create a separate event?', JSON.stringify({ calendar_receipts: [receipt] })],
    );
    replies = [{ content: 'I will move EDD, not LexisNexis.' }];
    await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'Push the EDD call by 30 minutes' },
    });

    const sent = JSON.stringify(llmRequests.at(-1)?.messages ?? []);
    expect(sent).toContain('Verified calendar receipts from this prior turn');
    expect(sent).toContain('calendar:source:event');
    expect(sent).toContain('Push the EDD call by 30 minutes');

    const visible = await call(`/api/assistant/threads/${t}`, { jar: cookies.alice });
    const rendered = JSON.stringify(visible.body);
    expect(rendered).not.toContain('Verified calendar receipts from this prior turn');
    expect(rendered).not.toContain('calendar:source:event');
    expect(rendered).not.toContain('calendar_receipts');

    const [stored] = await db.query<{ meta: Record<string, unknown> }>(
      `select meta from messages where thread_id=$1 and direction='out' and meta ? 'calendar_receipts' order by created_at desc limit 1`,
      [t],
    );
    expect(JSON.stringify(stored.meta)).toContain('calendar:source:event');
  });

  it('never writes the conversation into the audit log', async () => {
    await configureModel();
    const t = await threadWith('alice');
    replies = [{ content: 'REPLY-CONTENT-SECRET' }];
    await call(`/api/assistant/threads/${t}/talk`, {
      method: 'POST', jar: cookies.alice, body: { message: 'INBOUND-CONTENT-SECRET' },
    });
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('INBOUND-CONTENT-SECRET');
    expect(events).not.toContain('REPLY-CONTENT-SECRET');
  });
});

describe('step-up over the wire', () => {
  it('refuses a wrong password without saying anything about it', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: 'not-the-password' },
    });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('not-the-password');
  });

  it('accepts the right one and unlocks the session', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: PW.alice },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = await db.query<{ user_id: string }>(`select user_id from step_up_verifications`);
    expect(rows[0].user_id).toBe(ids.alice);
  });

  it('unlocks nobody else', async () => {
    await call('/api/assistant/step-up', { method: 'POST', jar: cookies.alice, body: { password: PW.alice } });
    const rows = await db.query<{ user_id: string }>(`select user_id from step_up_verifications`);
    expect(rows.every((r) => r.user_id === ids.alice)).toBe(true);
  });

  it('cannot be cleared by another member password', async () => {
    const res = await call('/api/assistant/step-up', {
      method: 'POST', jar: cookies.alice, body: { password: PW.bob },
    });
    expect(res.status).toBe(401);
  });
});

describe('approval levels over the wire', () => {
  it('defaults to always ask', async () => {
    const res = await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice });
    expect(res.body.level).toBe('always_ask');
  });

  it('reports the EFFECTIVE level, not the wish, when the admin is stricter', async () => {
    await call('/api/assistant/approval-levels/email_send', {
      method: 'PUT', jar: cookies.alice, body: { level: 'automatic' },
    });
    expect((await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice })).body.level)
      .toBe('automatic');

    const admin = await call('/api/admin/assistant/approval-policy/email_send', {
      method: 'PUT', jar: cookies.admin, body: { maxLevel: 'always_ask' },
    });
    expect(admin.status).toBe(200);

    const after = await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice });
    expect(after.body.level).toBe('always_ask');
    expect(after.body.userChoice).toBe('automatic');
    expect(after.body).toMatchObject({adminCeiling:'always_ask',managedPolicy:true});
    const ignored=await call('/api/assistant/approval-levels/email_send',{
      method:'PUT',jar:cookies.alice,body:{level:'automatic'},
    });
    expect(ignored.status).toBe(409);
    expect((await call('/api/assistant/approval-levels/email_send',{jar:cookies.alice})).body.userChoice).toBe('automatic');
  });

  it('does not let the admin loosen a member choice', async () => {
    await call('/api/assistant/approval-levels/email_send', {
      method: 'PUT', jar: cookies.alice, body: { level: 'always_ask' },
    });
    await call('/api/admin/assistant/approval-policy/email_send', {
      // Loosening is refused without this; the assertion below is about the
      // member's choice surviving even when the ceiling is fully open.
      method: 'PUT', jar: cookies.admin, body: { maxLevel: 'automatic', confirmRelaxation: true },
    });
    expect((await call('/api/assistant/approval-levels/email_send', { jar: cookies.alice })).body.level)
      .toBe('always_ask');
  });

  it('does not let a member set the installation policy', async () => {
    const res = await call('/api/admin/assistant/approval-policy/email_send', {
      method: 'PUT', jar: cookies.alice, body: { maxLevel: 'automatic' },
    });
    expect(res.status).toBe(403);
  });
});

describe('approvals over the wire', () => {
  it('returns an uncached backend count/list refreshed after expiry and exact-ID decisions', async () => {
    const approvals: string[] = [];
    for (let i=0;i<3;i++) {
      const [task]=await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key,state)
        values($1,'follow_up','awaiting_approval') returning id`,[ids.alice]);
      const [approval]=await db.query<{id:string}>(`insert into approvals(subject_type,subject_id,owner_user_id,action_class,action,summary,payload_hash)
        values('task',$1,$2,'email_send','send','Identical summary','h') returning id`,[task.id,ids.alice]);
      approvals.push(approval.id);
    }
    const initial=await call('/api/assistant/approvals',{jar:cookies.alice});
    expect(initial.headers.get('cache-control')).toBe('private, no-store');
    expect(initial.body.count).toBe(3); expect(initial.body.refreshAfterMs).toBe(2000);
    expect(initial.body.approvals.map((a:{id:string})=>a.id).sort()).toEqual([...approvals].sort());
    expect((await call(`/api/assistant/approvals/${approvals[1]}/decide`,{method:'POST',jar:cookies.alice,body:{approve:false}})).body.approval.id).toBe(approvals[1]);
    expect((await call(`/api/assistant/approvals/${approvals[0]}/decide`,{method:'POST',jar:cookies.alice,body:{approve:true}})).body.approval.id).toBe(approvals[0]);
    const remaining=await call('/api/assistant/approvals',{jar:cookies.alice});
    expect(remaining.body.count).toBe(1); expect(remaining.body.approvals[0].id).toBe(approvals[2]);
    await db.query(`update approvals set expires_at=now() where id=$1`,[approvals[2]]);
    const expired=await call('/api/assistant/approvals',{jar:cookies.alice});
    expect(expired.body.count).toBe(0); expect(expired.body.approvals).toEqual([]);
    expect(await db.query(`select id from approvals where id=any($1::uuid[])`,[approvals])).toHaveLength(3);
  });

  it('shows a member only their own pending approvals, and lets nobody else decide', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key) values ($1,'follow_up') returning id`,
      [ids.alice],
    );
    const [approval] = await db.query<{ id: string }>(
      `insert into approvals (subject_type, subject_id, owner_user_id, action_class, action, summary, payload_hash)
       values ('task', $1, $2, 'email_send', 'send_email', 'SEND-SUMMARY-PRIVATE', 'h') returning id`,
      [task.id, ids.alice],
    );

    expect((await call('/api/assistant/approvals', { jar: cookies.bob })).body.approvals).toHaveLength(0);
    const mine = await call('/api/assistant/approvals', { jar: cookies.alice });
    expect(mine.body.approvals).toHaveLength(1);

    // Neither a colleague nor the administrator may agree on Alice's behalf.
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/assistant/approvals/${approval.id}/decide`, {
        method: 'POST', jar: cookies[who], body: { approve: true },
      });
      expect(res.status, who).toBe(404);
    }
    const [row] = await db.query<{ status: string }>(`select status from approvals where id = $1`, [approval.id]);
    expect(row.status).toBe('pending');
  });

  it('returns canonical terminal status when another device already decided', async () => {
    const [task] = await db.query<{ id: string }>(
      `insert into tasks (owner_user_id, template_key) values ($1,'follow_up') returning id`, [ids.alice],
    );
    const [approval] = await db.query<{ id: string }>(
      `insert into approvals (subject_type, subject_id, owner_user_id, action_class, action, summary, payload_hash)
       values ('task',$1,$2,'email_send','send_email','summary','h') returning id`, [task.id,ids.alice],
    );
    expect((await call(`/api/assistant/approvals/${approval.id}/decide`,{method:'POST',jar:cookies.alice,body:{approve:false}})).status).toBe(200);
    const conflict=await call(`/api/assistant/approvals/${approval.id}/decide`,{method:'POST',jar:cookies.alice,body:{approve:true}});
    expect(conflict.status).toBe(409);
    expect(conflict.body.approvalStatus).toBe('denied');

    const [otherTask]=await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key) values($1,'follow_up') returning id`,[ids.alice]);
    const [other]=await db.query<{id:string}>(`insert into approvals(subject_type,subject_id,owner_user_id,action_class,action,summary,payload_hash)
      values('task',$1,$2,'email_send','send_email','summary','h2') returning id`,[otherTask.id,ids.alice]);
    expect((await call(`/api/assistant/approvals/${other.id}/decide`,{method:'POST',jar:cookies.alice,body:{approve:true}})).status).toBe(200);
    const approvedConflict=await call(`/api/assistant/approvals/${other.id}/decide`,{method:'POST',jar:cookies.alice,body:{approve:false}});
    expect(approvedConflict.status).toBe(409);
    expect(approvedConflict.body.approvalStatus).toBe('approved');
  });

  it('requires an explicit decision boolean and persists truthful expiry state',async()=>{
    const [thread]=await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'Expiry') returning id`,[ids.alice]);
    const [task]=await db.query<{id:string}>(`insert into tasks(owner_user_id,thread_id,template_key,state,slots)
      values($1,$2,'schedule_appointment','awaiting_approval','{}') returning id`,[ids.alice,thread.id]);
    const [approval]=await db.query<{id:string}>(`insert into approvals(subject_type,subject_id,owner_user_id,action_class,action,summary,payload_hash,expires_at)
      values('task',$1,$2,'calendar_write','create','expired event','h',now()-interval '1 minute') returning id`,[task.id,ids.alice]);
    const [message]=await db.query<{id:string}>(`insert into messages(thread_id,direction,body,meta) values($1,'out','Review',jsonb_build_object('nativeApproval',jsonb_build_object('status','pending'))) returning id`,[thread.id]);
    await db.query(`insert into assistant_action_states(owner_user_id,thread_id,domain,operation,status,task_id,approval_id,presented_turn_id,expires_at)
      values($1,$2,'calendar','create','prepared',$3,$4,$5,now()-interval '1 minute')`,[ids.alice,thread.id,task.id,approval.id,message.id]);

    const missing=await call(`/api/assistant/approvals/${approval.id}/decide`,{method:'POST',jar:cookies.alice,body:{}});
    expect(missing.status).toBe(400);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe('pending');

    const expired=await call(`/api/assistant/approvals/${approval.id}/decide`,{method:'POST',jar:cookies.alice,body:{approve:true}});
    expect(expired.status).toBe(409);
    expect(expired.body.approvalStatus).toBe('expired');
    expect((await db.query<{status:string}>(`select status from assistant_action_states where approval_id=$1`,[approval.id]))[0].status).toBe('expired');
    expect((await db.query<{state:string}>(`select state from tasks where id=$1`,[task.id]))[0].state).toBe('cancelled');
    expect((await db.query<{status:string}>(`select meta->'nativeApproval'->>'status' status from messages where id=$1`,[message.id]))[0].status).toBe('expired');
  });
});

describe('reminders over the wire', () => {
  // Round-2 item 13: the Tasks page's window into what the assistant
  // scheduled. Same spine as tasks: owner-scoped reads, 404 for anything that
  // is not yours — never a 403 that would confirm it exists.
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

  it('answers with upcoming and recently settled, owner-scoped', async () => {
    const mine = await createReminder(db, {
      ownerUserId: ids.alice, body: 'ALICE-UPCOMING', dueAt: inMinutes(30),
    });
    const settled = await createReminder(db, {
      ownerUserId: ids.alice, body: 'ALICE-DELIVERED', dueAt: inMinutes(30),
    });
    await db.query(
      `update reminders set status = 'delivered', delivered_at = now() - interval '1 day' where id = $1`,
      [settled.id],
    );
    // Settled long ago: out of the recent window, invisible.
    const stale = await createReminder(db, {
      ownerUserId: ids.alice, body: 'ALICE-ANCIENT', dueAt: inMinutes(30),
    });
    await db.query(
      `update reminders set status = 'delivered', delivered_at = now() - interval '30 days' where id = $1`,
      [stale.id],
    );
    await createReminder(db, { ownerUserId: ids.bob, body: 'BOB-PRIVATE', dueAt: inMinutes(30) });

    const res = await call('/api/assistant/reminders', { jar: cookies.alice });
    expect(res.status).toBe(200);
    expect(res.body.upcoming.map((r: { body: string }) => r.body)).toEqual(['ALICE-UPCOMING']);
    expect(res.body.recent.map((r: { body: string }) => r.body)).toEqual(['ALICE-DELIVERED']);
    expect(JSON.stringify(res.body)).not.toContain('BOB-PRIVATE');
    expect(mine.id).toBeTruthy();
  });

  it('cancels the owner\u2019s own scheduled reminder', async () => {
    const r = await createReminder(db, {
      ownerUserId: ids.alice, body: 'cancel me', dueAt: inMinutes(30),
    });
    const res = await call(`/api/assistant/reminders/${r.id}/cancel`, {
      method: 'POST', jar: cookies.alice,
    });
    expect(res.status).toBe(200);
    expect(res.body.reminder.status).toBe('cancelled');
    // Gone from upcoming, present in recent — the page shows what happened.
    const list = await call('/api/assistant/reminders', { jar: cookies.alice });
    expect(list.body.upcoming).toHaveLength(0);
    expect(list.body.recent.map((x: { status: string }) => x.status)).toEqual(['cancelled']);
  });

  it('returns content-free monotonic reminder intents without transferring server delivery ownership', async () => {
    const threadId=await threadWith('alice');
    const r=await createReminder(db,{ownerUserId:ids.alice,threadId,body:'PRIVATE SNAPSHOT BODY',
      dueAt:inMinutes(45),timezone:'America/Los_Angeles'});
    const snapshot=await call('/api/assistant/reminders/native-actions',{jar:cookies.alice});
    expect(snapshot.status).toBe(200);expect(snapshot.headers.get('cache-control')).toMatch(/no-store/);
    expect(snapshot.body.actions).toHaveLength(1);
    expect(snapshot.body.actions[0]).toMatchObject({version:1,id:r.id,threadId,revision:1,operation:'upsert',timezone:'America/Los_Angeles'});
    expect(JSON.stringify(snapshot.body)).not.toContain('PRIVATE SNAPSHOT BODY');
    expect((await call('/api/assistant/reminders/native-actions',{jar:cookies.bob})).body.actions).toEqual([]);
    const edit=await call(`/api/assistant/reminders/${r.id}`,{method:'PUT',jar:cookies.alice,body:{due_at:inMinutes(90).toISOString(),timezone:'UTC'}});
    expect(edit.body.reminder).toMatchObject({id:r.id,revision:2,timezone:'UTC'});
    expect(edit.body).not.toHaveProperty('native_action');
    expect((await call('/api/assistant/reminders/native-actions',{jar:cookies.alice})).body.actions[0]).toMatchObject({id:r.id,revision:2,operation:'upsert',timezone:'UTC'});
    expect((await call(`/api/assistant/reminders/${r.id}`,{method:'PUT',jar:cookies.bob,body:{message:'steal'}})).status).toBe(404);
    const cancel=await call(`/api/assistant/reminders/${r.id}/cancel`,{method:'POST',jar:cookies.alice});
    expect(cancel.body.reminder).toMatchObject({id:r.id,revision:3,status:'cancelled'});
    expect(cancel.body).not.toHaveProperty('native_action');
    expect((await call('/api/assistant/reminders/native-actions',{jar:cookies.alice})).body.actions).toEqual([
      {version:1,id:r.id,threadId,revision:3,operation:'cancel'},
    ]);
  });

  it('does not expose stale or hand-written native scheduling claims in thread history',async()=>{
    const threadId=await threadWith('alice');
    const valid={version:1,id:'opaque-1',threadId,revision:1,operation:'cancel'};
    await db.query(`insert into messages(thread_id,direction,body,meta) values($1,'out','safe',$2)`,
      [threadId,json({nativeActions:[valid,{...valid,body:'leak'}],internal_secret:'hidden'})]);
    const detail=await call(`/api/assistant/threads/${threadId}`,{jar:cookies.alice});
    expect(detail.body.messages.at(-1).meta).toEqual({});
    expect(JSON.stringify(detail.body)).not.toContain('internal_secret');
    expect((await call(`/api/assistant/threads/${threadId}`,{jar:cookies.bob})).status).toBe(404);
  });

  it('a colleague\u2019s reminder or a settled one is 404, and nothing changes', async () => {
    const r = await createReminder(db, {
      ownerUserId: ids.alice, body: 'not yours', dueAt: inMinutes(30),
    });
    for (const who of ['bob', 'admin'] as const) {
      const res = await call(`/api/assistant/reminders/${r.id}/cancel`, {
        method: 'POST', jar: cookies[who],
      });
      expect(res.status, who).toBe(404);
    }
    const [row] = await db.query<{ status: string }>(`select status from reminders where id = $1`, [r.id]);
    expect(row.status).toBe('scheduled');

    // Cancel it, then a second cancel finds nothing left.
    await call(`/api/assistant/reminders/${r.id}/cancel`, { method: 'POST', jar: cookies.alice });
    const again = await call(`/api/assistant/reminders/${r.id}/cancel`, { method: 'POST', jar: cookies.alice });
    expect(again.status).toBe(404);
  });

  it('refuses anonymous callers', async () => {
    const anonJar = mergeJar(undefined, (await call('/api/auth/csrf')).setCookie);
    expect((await call('/api/assistant/reminders', { jar: anonJar })).status).toBe(401);
  });
});

describe('metrics', () => {
  it('are scoped to the person asking', async () => {
    await db.query(`insert into tasks (owner_user_id, template_key) values ($1,'follow_up')`, [ids.alice]);
    expect((await call('/api/assistant/metrics', { jar: cookies.alice })).body.metrics.tasks).toBe(1);
    expect((await call('/api/assistant/metrics', { jar: cookies.bob })).body.metrics.tasks).toBe(0);
  });
});

describe('transactional conversational writes over HTTP',()=>{
  const tc=(name:string,args:unknown,id='tc')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

  it('keeps the exact partial email, asks explicit approval, and a retry cannot enqueue twice',async()=>{
    await configureModel();
    const key=new MasterKey(KEY_BYTES);
    await saveClient(db,key,{provider:'google',clientId:'cid',clientSecret:'secret',redirectUri:'https://example.test/callback',actorUserId:ids.admin});
    const connection=await upsertConnection(db,key,{ownerUserId:ids.alice,provider:'google',providerAccountId:'http-mail',accountEmail:'alice-mail@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly'},requestedCapabilities:['google.mail.read','google.mail.send']});
    await setCapability(db,{connection,capability:'google.mail.read',enabled:true,actorUserId:ids.alice});
    await setCapability(db,{connection,capability:'google.mail.send',enabled:true,actorUserId:ids.alice});
    const t=await threadWith('alice');

    replies=[{content:null,tool_calls:[tc('check_email_availability',{})]},{content:'Gmail answered a live mailbox check, so I can reach it now.'}];
    const visibility=await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'you see my emails?'}});
    expect(visibility.body.reply).toMatch(/answered a live mailbox check/i);

    replies=[{content:null,tool_calls:[tc('draft_email',{recipient:'romanvaxman14@gmail.com',body:'testing the connection'})]},{content:'What subject should I use?'}];
    expect((await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'send email to romanvaxman14@gmail.com body testing the connection'}})).body.reply).toMatch(/subject/i);

    replies=[{content:null,tool_calls:[tc('draft_email',{subject:'testing the coonection'})]},{content:'model text must not replace the authoritative preview'}];
    const draft=await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'testing the coonection in the topic is just fine'}});
    expect(draft.body.reply).toBe('Send email\nTo: romanvaxman14@gmail.com\nSubject: testing the coonection\nBody: testing the connection\n\nApprove this exact action? Reply yes or no.');

    const before=llmRequests.length;
    expect((await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'yes'}})).body.reply).toMatch(/queued the exact email/i);
    expect(llmRequests).toHaveLength(before);
    expect((await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'yes'}})).body.reply).toMatch(/do not have one/i);
    const [emailTask]=await db.query<{id:string}>(`select id from tasks where template_key='send_message' order by created_at desc limit 1`);
    expect(await db.query(`select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`,[emailTask.id])).toHaveLength(1);
    expect((await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'was it sent?'}})).body.reply).toMatch(/email.*queued.*not confirmed sent/i);
    expect((await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'why?'}})).body.reply).toMatch(/email.*queued.*not confirmed sent/i);
  });

  it('creates the separate EDD draft on the write default without asking among read calendars',async()=>{
    await configureModel();
    const key=new MasterKey(KEY_BYTES);
    const connection=await upsertConnection(db,key,{ownerUserId:ids.alice,provider:'google',providerAccountId:'http-calendar',accountEmail:'alice-calendar@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.readonly'},requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:ids.alice});
    await setCapability(db,{connection,capability:'google.calendar.read',enabled:true,actorUserId:ids.alice});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable,is_write_default)
      values($1,$2,'primary','Main calendar',true,true,true),($1,$2,'lexis','LexisNexis',false,true,false)`,[ids.alice,connection.id]);
    const primary=await ensureInternalCalendar(db,{ownerUserId:ids.alice,connectionId:connection.id,provider:'google',providerCalendarId:'primary'});
    const lexis=await ensureInternalCalendar(db,{ownerUserId:ids.alice,connectionId:connection.id,provider:'google',providerCalendarId:'lexis'});
    await db.query(`update calendar_sync_origins set last_sync_at=now() where id in($1,$2)`,[primary.id,lexis.id]);
    const t=await threadWith('alice');
    replies=[{content:null,tool_calls:[tc('draft_calendar_event',{title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00'})]},{content:'wrong old LexisNexis'}];
    const prepared=await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:"create tomorrow 3pm PT 30m 'Phone call with EDD' (they call me)"}});
    expect(prepared.body.reply).toContain('Calendar: Main calendar');
    expect(prepared.body.reply).toContain('Title: Phone call with EDD');
    expect(prepared.body.reply).not.toContain('LexisNexis');
    await call(`/api/assistant/threads/${t}/talk`,{method:'POST',jar:cookies.alice,body:{message:'yes'}});
    const [task]=await db.query<{slots:Record<string,unknown>}>(`select slots from tasks where template_key='schedule_appointment' order by created_at desc limit 1`);
    expect(task.slots).not.toHaveProperty('event_id');
    expect(task.slots.calendar_source).toMatchObject({calendar_id:'primary',calendar_name:'Main calendar'});
  });
});
