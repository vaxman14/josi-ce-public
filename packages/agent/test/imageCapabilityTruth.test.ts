import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { addMessage, createThread, listMessages } from '@josi-ce/core';
import { runAssistantTurn, IMAGE_GENERATION_UNAVAILABLE, classifyImageIntent, immediatePriorMediaResult } from '../src/index.js';
import type { SpawnRunner } from '@josi-ce/llm';

let db: TestDb;
let owner: string;
let other: string;
let threadId: string;
let codexCalls: number;
let calendarCalls: number;

const runner: SpawnRunner = async () => {
  codexCalls += 1;
  return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ type: 'agent_message', message: 'wrong domain' }) };
};
const connectorFetch = (async () => {
  calendarCalls += 1;
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'image-owner@ce.test', username: 'image-owner', role: 'super_admin' })).id;
  other = (await createUser(db, { email: 'image-other@ce.test', username: 'image-other', role: 'member' })).id;
  threadId = (await createThread(db, { ownerUserId: owner })).id;
  codexCalls = 0;
  calendarCalls = 0;
  // A working ChatGPT subscription is still only a chat/vision provider. It
  // is deliberately not treated as an image-generation backend.
  await db.query(`insert into llm_providers
    (role,provider,model,external_acknowledged,activated_at,probed_at,
     cap_chat,cap_structured_output,cap_tool_calling,cap_vision,cap_context_tokens)
    values('primary','openai_subscription','',true,now(),now(),true,false,true,true,8000)`);
});

async function persistedTurn(inbound: string, actingOwner = owner, actingThread = threadId) {
  const message = await addMessage(db, { threadId: actingThread, direction: 'in', body: inbound });
  const result = await runAssistantTurn({
    db, userId: actingOwner, threadId: actingThread, history: [], inbound,
    inboundMessageId: message.id,
    registry: { db, masterKey: null, codexRunner: runner },
    connectorFetch,
  });
  if (result.mediaRequest) await db.query(
    `update messages set meta=meta || $2::jsonb where id=$1`,
    [message.id, JSON.stringify({ media_request: result.mediaRequest })],
  );
  if (!result.refusal) await addMessage(db, {
    threadId: actingThread, direction: 'out', body: result.reply,
    meta: result.mediaResult ? { media_result: result.mediaResult } : undefined,
  });
  return result;
}

describe('image capability truth and immediate follow-up binding', () => {
  it('classifies common image deliverables without requiring the word image', () => {
    expect(classifyImageIntent('Make me a logo')).toBe('generate');
    expect(classifyImageIntent('Create an avatar')).toBe('generate');
    expect(classifyImageIntent('Design a banner')).toBe('generate');
    expect(classifyImageIntent('Edit this icon')).toBe('edit');
  });

  it('locks the exact transcript to truthful unavailable results with no model, image, calendar, or attachment action', async () => {
    const capability = await persistedTurn('can you generate images?');
    expect(capability.reply).toBe(IMAGE_GENERATION_UNAVAILABLE);
    expect(capability.actions).toEqual([]);

    const request = await persistedTurn('create an image of pretty castle');
    expect(request.reply).toBe(IMAGE_GENERATION_UNAVAILABLE);
    expect(request.reply).not.toMatch(/\bdone\b/i);
    expect(request.actions).toEqual([]);

    const followup = await persistedTurn('where is it?');
    expect(followup.reply).toBe(IMAGE_GENERATION_UNAVAILABLE);
    expect(followup.actions).toEqual([]);
    expect(followup.mediaRequest).toMatchObject({ media: 'image', intent: 'status' });
    expect(followup.mediaRequest?.refers_to).toBe(request.mediaResult?.request_id);

    expect(codexCalls).toBe(0);
    expect(calendarCalls).toBe(0);
    expect(await db.query(`select id from chat_attachments`)).toHaveLength(0);

    const messages = await listMessages(db, { threadId });
    expect(messages).toHaveLength(6);
    expect(messages.filter((m) => Array.isArray(m.meta.attachments) && m.meta.attachments.length)).toHaveLength(0);
    expect(messages[2].meta.media_request).toMatchObject({ media: 'image', intent: 'generate' });
    expect(messages[3].meta.media_result).toMatchObject({ media: 'image', status: 'unavailable' });
    expect(JSON.stringify(messages.map((m) => m.meta))).not.toContain('pretty castle');

    const audits = await db.query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind,payload from events where kind='agent.unsupported_capability_attempt' order by created_at`,
    );
    expect(audits).toHaveLength(3);
    expect(audits.every((event) => !JSON.stringify(event.payload).includes('castle'))).toBe(true);
  });

  it('does not bind status across a different thread or owner', async () => {
    await persistedTurn('create an image of pretty castle');
    const otherThread = (await createThread(db, { ownerUserId: owner })).id;

    expect(await immediatePriorMediaResult(db, {
      ownerUserId: owner, threadId: otherThread,
    })).toBeNull();
    expect(await immediatePriorMediaResult(db, {
      ownerUserId: other, threadId,
    })).toBeNull();
  });
});
