// Reminders: "remind me in five minutes" must actually happen five minutes
// later — Roman's round-2 item 4, promoted from polish to core feature.
//
// Three layers, each exercised where it lives: the core module (row + queued
// job), the assistant tool (the same executeAssistantTool both the in-process
// loop and the MCP harness call), and the worker (delivery to the chat surface
// and, best-effort, Telegram).
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import {
  MasterKey, ReminderError, cancelReminder, createReminder, createThread,
  listNativeReminderActions, listRemindersFor, reminderInstant, seal, updateReminder, upsertMobileDevice,
} from '@josi-ce/core';
import { executeAssistantTool } from '../../../packages/agent/src/execute.js';
import { TASK_TOOLS } from '../../../packages/agent/src/tools.js';
import { processQueue } from '../../worker/src/jobs.js';

let db: TestDb;
let owner: string;
let threadId: string;

const KEY = new MasterKey(Buffer.alloc(32, 41));

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'r@ce.test', username: 'reminder-owner', role: 'super_admin' })).id;
  threadId = (await createThread(db, { ownerUserId: owner })).id;
});

/** Reminders are delivered when due, not when created. Tests pull the queued
 * job's run_at back so `processQueue` can claim it without sleeping. */
async function makeDue() {
  await db.query(`update reminders set due_at = now() - interval '1 second' where status='scheduled'`);
  await db.query(`update job_queue set run_at = now() where kind = 'reminder.deliver'`);
}

// ------------------------------------------------------------------ the core

describe('createReminder', () => {
  it('stores the row and queues delivery at the due time', async () => {
    const due = new Date(Date.now() + 5 * 60_000);
    const reminder = await createReminder(db, {
      ownerUserId: owner, threadId, body: 'check in with Roman', dueAt: due,
    });
    expect(reminder.status).toBe('scheduled');

    const [job] = await db.query<{ kind: string; payload: any; run_at: string }>(
      `select kind, payload, run_at from job_queue`,
    );
    expect(job.kind).toBe('reminder.deliver');
    // The payload carries the id and NOTHING else — a queue row is
    // infrastructure and must not become a side channel for content.
    expect(job.payload).toEqual({ reminderId: reminder.id, revision: 1 });
    expect(Math.abs(new Date(job.run_at).getTime() - due.getTime())).toBeLessThan(2000);
  });

  it('refuses the past, the empty, and the absurdly distant', async () => {
    const args = { ownerUserId: owner, threadId, body: 'x' };
    await expect(createReminder(db, { ...args, dueAt: new Date(Date.now() - 1000) }))
      .rejects.toThrow(ReminderError);
    await expect(createReminder(db, { ...args, body: '   ', dueAt: new Date(Date.now() + 60_000) }))
      .rejects.toThrow(/something to say/);
    await expect(createReminder(db, { ...args, dueAt: new Date(Date.now() + 400 * 24 * 3600_000) }))
      .rejects.toThrow(/more than a year/);
  });

  it('formats exact instants for timezone/DST folds and rejects invalid zones', async () => {
    expect(reminderInstant(new Date('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01T01:30:00-07:00');
    expect(reminderInstant(new Date('2026-11-01T09:30:00Z'), 'America/Los_Angeles')).toBe('2026-11-01T01:30:00-08:00');
    expect(() => reminderInstant(new Date(), 'Bad/Zone')).toThrow(ReminderError);
  });

  it('edits monotonically and leaves old jobs harmless', async () => {
    const first = await createReminder(db, { ownerUserId: owner, threadId, body: 'first',
      dueAt: new Date(Date.now() + 60_000), timezone: 'America/Los_Angeles' });
    const edited = await updateReminder(db, { ownerUserId: owner, reminderId: first.id, body: 'second',
      dueAt: new Date(Date.now() + 120_000) });
    expect(edited).toMatchObject({ id: first.id, revision: 2, body: 'second', thread_id: threadId });
    const jobs = await db.query<{payload:any}>(`select payload from job_queue where kind='reminder.deliver' order by id`);
    expect(jobs.map(j=>j.payload.revision)).toEqual([1,2]);
    await db.query(`update job_queue set run_at=now() where kind='reminder.deliver' and (payload->>'revision')::int=1`);
    expect(await processQueue(db,'stale-revision',1)).toMatchObject({done:1,failed:0});
    expect(await db.query(`select id from messages`)).toHaveLength(0);
    expect((await db.query<{status:string}>(`select status from reminders where id=$1`,[first.id]))[0].status).toBe('scheduled');
    expect(await listNativeReminderActions(db,{ownerUserId:owner})).toEqual([expect.objectContaining({id:first.id,threadId,revision:2,operation:'upsert'})]);
    const cancelled = await cancelReminder(db,{ownerUserId:owner,reminderId:first.id});
    expect(cancelled).toMatchObject({id:first.id,revision:3,status:'cancelled'});
    expect(await listNativeReminderActions(db,{ownerUserId:owner})).toEqual([{version:1,id:first.id,threadId,revision:3,operation:'cancel'}]);
  });

  it('cancels only the owner\u2019s own scheduled reminder', async () => {
    const other = (await createUser(db, { email: 'x@ce.test', username: 'other', role: 'member' })).id;
    const r = await createReminder(db, {
      ownerUserId: owner, threadId, body: 'b', dueAt: new Date(Date.now() + 60_000),
    });
    // Somebody else's cancel finds nothing — same answer as "does not exist".
    expect(await cancelReminder(db, { ownerUserId: other, reminderId: r.id })).toBeNull();
    const mine = await cancelReminder(db, { ownerUserId: owner, reminderId: r.id });
    expect(mine?.status).toBe('cancelled');
    // A second cancel finds nothing left to cancel.
    expect(await cancelReminder(db, { ownerUserId: owner, reminderId: r.id })).toBeNull();
  });
});

// ------------------------------------------------------------------ the tool

describe('the schedule_reminder tool', () => {
  const ctx = () => ({ userId: owner, threadId });

  it('is in the catalogue both agent loops offer', () => {
    // The in-process loop and the MCP harness both serve TASK_TOOLS through
    // executeAssistantTool, so presence here is presence in both.
    const names = TASK_TOOLS.map((t) => t.def.name);
    expect(names).toContain('schedule_reminder');
    expect(names).toContain('update_reminder');
    expect(names).toContain('list_reminders');
    expect(names).toContain('cancel_reminder');
  });

  it('schedules from in_minutes and answers with the delivery time', async () => {
    const result = await executeAssistantTool(db, ctx(), 'schedule_reminder', {
      message: 'stand up and stretch', in_minutes: 5,
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.reminder_id).toBeTruthy();
    const ahead = new Date(result.due_at).getTime() - Date.now();
    expect(ahead).toBeGreaterThan(4 * 60_000);
    expect(ahead).toBeLessThan(6 * 60_000);
  });

  it('schedules from an exact due_at', async () => {
    const due = new Date(Date.now() + 3600_000).toISOString();
    const result = await executeAssistantTool(db, ctx(), 'schedule_reminder', {
      message: 'call the vet', due_at: due,
    }) as any;
    expect(result.ok).toBe(true);
    expect(Math.abs(new Date(result.due_at).getTime()-new Date(due).getTime())).toBeLessThan(1000);
  });

  it('updates and cancels with monotonic server revisions without claiming native scheduling', async () => {
    const scheduled = await executeAssistantTool(db, ctx(), 'schedule_reminder', {
      message: 'first', due_at: new Date(Date.now()+3600_000).toISOString(), timezone: 'America/Los_Angeles',
    }) as any;
    expect(scheduled).not.toHaveProperty('native_action');
    const edited = await executeAssistantTool(db,ctx(),'update_reminder',{
      reminder_id:scheduled.reminder_id,message:'second',in_minutes:120,
    }) as any;
    expect(edited).toMatchObject({ok:true,revision:2});
    expect(edited).not.toHaveProperty('native_action');
    const cancelled = await executeAssistantTool(db,ctx(),'cancel_reminder',{reminder_id:scheduled.reminder_id}) as any;
    expect(cancelled).toMatchObject({revision:3,status:'cancelled'});
    expect(cancelled).not.toHaveProperty('native_action');
  });

  it('refuses a missing time with instructions rather than guessing one', async () => {
    const result = await executeAssistantTool(db, ctx(), 'schedule_reminder', {
      message: 'no time given',
    }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('bad_time');
    expect((await listRemindersFor(db, { ownerUserId: owner }))).toHaveLength(0);
  });

  it('relays a core refusal (the past) as a message the model can repeat', async () => {
    const result = await executeAssistantTool(db, ctx(), 'schedule_reminder', {
      message: 'too late', due_at: new Date(Date.now() - 60_000).toISOString(),
    }) as any;
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already passed/);
  });

  it('lists and cancels through the tools, owner-scoped', async () => {
    await executeAssistantTool(db, ctx(), 'schedule_reminder', { message: 'one', in_minutes: 10 });
    const listed = await executeAssistantTool(db, ctx(), 'list_reminders', {}) as any;
    expect(listed.reminders).toHaveLength(1);
    expect(listed.reminders[0].message).toBe('one');

    const cancelled = await executeAssistantTool(db, ctx(), 'cancel_reminder', {
      reminder_id: listed.reminders[0].reminder_id,
    }) as any;
    expect(cancelled.ok).toBe(true);

    // Another user's tools see none of it.
    const other = (await createUser(db, { email: 'y@ce.test', username: 'other2', role: 'member' })).id;
    const theirs = await executeAssistantTool(db, { userId: other, threadId: null }, 'list_reminders', {}) as any;
    expect(theirs.reminders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the worker

describe('the worker delivers reminders', () => {
  it('posts the reminder into the conversation it was asked in', async () => {
    await createReminder(db, {
      ownerUserId: owner, threadId, body: 'drink water', dueAt: new Date(Date.now() + 60_000),
    });
    await makeDue();
    const outcome = await processQueue(db, 'w1');
    expect(outcome).toMatchObject({ done: 1, failed: 0 });

    const messages = await db.query<{ direction: string; body: string }>(
      `select direction, body from messages where thread_id = $1`, [threadId],
    );
    expect(messages).toEqual([{ direction: 'out', body: 'Reminder: drink water' }]);
    const [row] = await db.query<{ status: string; delivered_at: string | null }>(
      `select status, delivered_at from reminders`,
    );
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('server delivery covers every capable device, including foreground, and remains revision-deduplicated', async()=>{
    const background=await upsertMobileDevice(db,KEY,owner,{deviceIdentity:'10101010-1010-4010-8010-101010101010',platform:'ios',expoToken:'ExpoPushToken[reminder_background]',appState:'background',privacyLocked:false,timezone:'UTC'});
    const foreground=await upsertMobileDevice(db,KEY,owner,{deviceIdentity:'11111111-1111-4111-8111-111111111111',platform:'ios',expoToken:'ExpoPushToken[reminder_foreground]',appState:'foreground',privacyLocked:false,timezone:'UTC'});
    const server=await createReminder(db,{ownerUserId:owner,threadId,body:'server owned',dueAt:new Date(Date.now()+60_000),timezone:'UTC'});
    await makeDue();await processQueue(db,'server-owner',10);
    const pushes=await db.query<{device_id:string;route_thread_id:string}>(`select device_id,route_thread_id from push_deliveries where event_key like $1`,[`reminder:${server.id}:%`]);
    expect(pushes).toEqual(expect.arrayContaining([{device_id:background.id,route_thread_id:threadId},{device_id:foreground.id,route_thread_id:threadId}]));
    expect(pushes).toHaveLength(2);
    await processQueue(db,'duplicate-server-owner',10);
    expect(await db.query(`select id from push_deliveries where event_key like $1`,[`reminder:${server.id}:%`])).toHaveLength(2);
  });

  it('does NOT deliver a cancelled reminder, even though its job still fires', async () => {
    const r = await createReminder(db, {
      ownerUserId: owner, threadId, body: 'never mind', dueAt: new Date(Date.now() + 60_000),
    });
    await cancelReminder(db, { ownerUserId: owner, reminderId: r.id });
    await makeDue();
    // The job completes quietly — a cancelled reminder is not a failure.
    expect(await processQueue(db, 'w1')).toMatchObject({ done: 1, failed: 0 });
    expect(await db.query(`select * from messages`)).toHaveLength(0);
    const [row] = await db.query<{ status: string }>(`select status from reminders`);
    expect(row.status).toBe('cancelled');
  });

  it('delivers to a fresh thread when the original conversation is gone', async () => {
    const r = await createReminder(db, {
      ownerUserId: owner, threadId, body: 'orphaned', dueAt: new Date(Date.now() + 60_000),
    });
    await db.query(`delete from threads where id = $1`, [threadId]);
    await makeDue();
    expect(await processQueue(db, 'w1')).toMatchObject({ done: 1, failed: 0 });

    const [msg] = await db.query<{ body: string; thread_id: string }>(
      `select body, thread_id from messages`,
    );
    expect(msg.body).toBe('Reminder: orphaned');
    expect(msg.thread_id).not.toBe(threadId);
    const [thread] = await db.query<{ owner_user_id: string }>(
      `select owner_user_id from threads where id = $1`, [msg.thread_id],
    );
    expect(thread.owner_user_id).toBe(owner);
    expect(r.id).toBeTruthy();
  });

  it('also sends to a linked Telegram chat, marked as a notice', async () => {
    // Config and link written directly: this is the worker's test, not the
    // admin screen's, and the shapes are the ones the migrations define.
    await db.query(
      `update telegram_config set enabled = true, bot_token_enc = $1, webhook_secret_enc = $1 where id = true`,
      [seal(KEY, { token: '123456789:AAHtestTOKENvaluethatislongenough00' })],
    );
    await db.query(
      `insert into telegram_links (user_id, chat_id, status) values ($1, 424242, 'active')`,
      [owner],
    );

    const sent: any[] = [];
    const telegramFetch: typeof fetch = async (url, init) => {
      sent.push({ method: String(url).split('/').pop(), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    await createReminder(db, {
      ownerUserId: owner, threadId, body: 'telegram too', dueAt: new Date(Date.now() + 60_000),
    });
    await makeDue();
    expect(await processQueue(db, 'w1', 5, { masterKey: KEY, telegramFetch }))
      .toMatchObject({ done: 1, failed: 0 });

    // Web delivery happened...
    expect(await db.query(`select id from messages where thread_id = $1`, [threadId])).toHaveLength(1);
    // ...and Telegram got the same text, escaped, with the disclosure attached.
    const sends = sent.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].body.chat_id).toBe(424242);
    expect(sends[0].body.text).toContain('telegram too');
    const [out] = await db.query<{ kind: string; state: string }>(
      `select kind, state from telegram_outbound`,
    );
    expect(out).toEqual({ kind: 'notice', state: 'sent' });
  });

  it('a Telegram failure does not fail a delivery that already happened', async () => {
    await db.query(
      `update telegram_config set enabled = true, bot_token_enc = $1, webhook_secret_enc = $1 where id = true`,
      [seal(KEY, { token: '123456789:AAHtestTOKENvaluethatislongenough00' })],
    );
    await db.query(
      `insert into telegram_links (user_id, chat_id, status) values ($1, 424242, 'active')`,
      [owner],
    );
    const telegramFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });

    await createReminder(db, {
      ownerUserId: owner, threadId, body: 'flaky channel', dueAt: new Date(Date.now() + 60_000),
    });
    await makeDue();
    expect(await processQueue(db, 'w1', 5, { masterKey: KEY, telegramFetch }))
      .toMatchObject({ done: 1, failed: 0 });
    expect(await db.query(`select id from messages where thread_id = $1`, [threadId])).toHaveLength(1);
    const [row] = await db.query<{ status: string }>(`select status from reminders`);
    expect(row.status).toBe('delivered');
  });
});
