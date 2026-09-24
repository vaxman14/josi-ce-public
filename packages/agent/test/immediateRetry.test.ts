import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  addMessage, attachCollectingAction, createTask, createThread, getTask, markActionsPresented,
  prepareAction, resolveConversationalAction, settleActionForTask,
} from '@josi-ce/core';
import { runAssistantTurn } from '../src/assistantAgent.js';
import { retryTargetFor } from '../src/retry.js';

let db: TestDb;
let userId: string;
let threadId: string;

beforeEach(async () => {
  db = await testDb();
  userId = (await createUser(db, {
    email: 'immediate-retry@ce.test', username: 'immediate-retry', role: 'super_admin',
  })).id;
  threadId = (await createThread(db, { ownerUserId: userId })).id;
});

const turn = (inbound = 'retry', inboundMessageId?: string) => runAssistantTurn({
  db, userId, threadId, history: [], inbound, inboundMessageId,
  registry: { db, masterKey: null },
});

async function succeededCalendarAction(): Promise<string> {
  const task = await createTask(db, {
    ownerUserId: userId,
    threadId,
    templateKey: 'schedule_appointment',
    slots: {
      title: 'Succeeded calendar action',
      start: '2026-09-18T15:00:00-07:00',
      end: '2026-09-18T15:30:00-07:00',
      calendar_source: { source_id: 'source', provider: 'google', account_id: 'account', calendar_id: 'primary', calendar_name: 'Main' },
    },
  });
  const collecting = await attachCollectingAction(db, {
    ownerUserId: userId, threadId, domain: 'calendar', operation: 'create', taskId: task.id,
  });
  const prepared = await prepareAction(db, {
    actionState: collecting,
    task,
    summary: 'calendar preview',
    actionClass: 'calendar_write',
    action: 'create',
  });
  const message = await addMessage(db, { threadId, direction: 'out', body: 'Approve the calendar action?' });
  await markActionsPresented(db, { ownerUserId: userId, threadId, taskIds: [task.id], messageId: message.id });
  const approved = await resolveConversationalAction(db, { ownerUserId: userId, threadId, inbound: 'yes' });
  expect(approved.action?.status).toBe('approved');
  await settleActionForTask(db, task.id, 'succeeded');
  expect((await getTask(db, task.id)).state).toBe('ready');
  expect(prepared.approval.id).toBeTruthy();
  return task.id;
}

describe('deterministic immediate-turn retry', () => {
  it('reruns failed workspace discovery after a succeeded calendar action without cross-domain contamination', async () => {
    const taskId = await succeededCalendarAction();
    const target = retryTargetFor('list_workspace_mappings', {})!;
    await addMessage(db, {
      threadId,
      direction: 'out',
      body: 'Workspace discovery failed.',
      meta: { retry: target },
    });

    const result = await turn();

    expect(result.actions).toEqual([{ tool: 'list_workspace_mappings', result: { mappings: [] } }]);
    expect(result.retry).toEqual(target);
    expect(result.reply).toMatch(/retried workspace discovery/i);
    expect((await db.query<{ status: string }>(
      `select status from assistant_action_states where task_id=$1`, [taskId],
    ))[0].status).toBe('succeeded');
    expect(await db.query(
      `select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`, [taskId],
    )).toHaveLength(1);
  });

  it('repeats only the same idempotent read and never duplicates an older approved action', async () => {
    const taskId = await succeededCalendarAction();
    const target = retryTargetFor('list_workspace_mappings', {})!;
    await addMessage(db, { threadId, direction: 'out', body: 'Discovery failed.', meta: { retry: target } });

    const first = await turn();
    await addMessage(db, { threadId, direction: 'out', body: first.reply, meta: { retry: first.retry! } });
    const second = await turn('try again');

    expect(first.actions.map((action) => action.tool)).toEqual(['list_workspace_mappings']);
    expect(second.actions.map((action) => action.tool)).toEqual(['list_workspace_mappings']);
    expect(second.retry).toEqual(target);
    expect(await db.query(
      `select id from job_queue where kind='task.wake' and payload->>'taskId'=$1`, [taskId],
    )).toHaveLength(1);
  });

  it('asks what to retry when the immediately preceding assistant turn has no typed target', async () => {
    await addMessage(db, {
      threadId,
      direction: 'out',
      body: 'Workspace discovery failed. The calendar action was already approved and queued.',
    });

    const result = await turn();

    expect(result.reply).toMatch(/what exactly.*retry/i);
    expect(result.actions).toEqual([]);
  });

  it('does not skip an intervening inbound message to recover an older retry target', async () => {
    const target = retryTargetFor('list_workspace_mappings', {})!;
    await addMessage(db, { threadId, direction: 'out', body: 'Discovery failed.', meta: { retry: target } });
    await addMessage(db, { threadId, direction: 'in', body: 'Tell me something else first.' });
    const current = await addMessage(db, { threadId, direction: 'in', body: 'retry' });

    const result = await turn('retry', current.id);

    expect(result.reply).toMatch(/what exactly.*retry/i);
    expect(result.actions).toEqual([]);
  });

  it('rejects forged consequential retry metadata instead of replaying it', async () => {
    await addMessage(db, {
      threadId,
      direction: 'out',
      body: 'Prepared a calendar event.',
      meta: {
        retry: {
          version: 1,
          kind: 'read_tool',
          domain: 'calendar',
          tool: 'draft_calendar_event',
          input: { title: 'duplicate me' },
        },
      },
    });

    const result = await turn();

    expect(result.reply).toMatch(/what exactly.*retry/i);
    expect(result.actions).toEqual([]);
    expect(await db.query(`select id from tasks where thread_id=$1`, [threadId])).toHaveLength(0);
  });
});
