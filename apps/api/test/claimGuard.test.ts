// Claims require receipts — round-2 item 12.
//
// The assistant told Roman "Done — reminder set… fires at 03:51 UTC" without
// ever calling the scheduling tool, then posted a fake "Reminder:" message.
// The guard under test intercepts exactly that: a reply claiming a completed
// action in a turn where zero tools ran. It re-prompts the model once (call
// the tool or restate honestly) and, if the model doubles down, replaces the
// fabrication with an honest correction.
//
// Two layers: the pattern matcher alone (where conservatism is asserted —
// honest prose must NOT match), and the full in-process loop against a fake
// provider (where the re-prompt/replace behavior is asserted). The
// subscription CLI harness path shares the same interception because its
// out-of-process executions land in `actions` before the guard reads it —
// asserted here by feeding executedToolCalls through the same seam.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { MasterKey, createThread, seal } from '@josi-ce/core';
import {
  ARTIFACT_CLAIM_GUARD_FALLBACK, CLAIM_GUARD_FALLBACK,
  claimsArtifactCompletion, claimsCompletedAction, runAssistantTurn,
} from '@josi-ce/agent';

// ------------------------------------------------------------- the matcher

describe('claimsCompletedAction', () => {
  const fabrications = [
    'Done — reminder set for 5 minutes from now. It fires at 03:51 UTC.',
    'Reminder set. I will nudge you then.',
    'Your reminder is set for 3pm.',
    "I've scheduled the reminder for tomorrow morning.",
    'I have set up a reminder for you.',
    'I just sent the email to the whole team.',
    'The email has been sent.',
    'Task created — you can see it on the Tasks page.',
    'The meeting has been cancelled as you asked.',
    'All set — it goes off at 6am.',
    'I already cancelled that reminder.',
    "Done — here's your image.",
    "Done — here's your logo.",
    'I generated the image and attached it below.',
    'The report is ready for download.',
  ];
  for (const text of fabrications) {
    it(`matches: "${text.slice(0, 50)}"`, () => {
      expect(claimsCompletedAction(text)).toBe(true);
    });
  }

  // The conservative half. Blocking honest prose is worse than a miss, so
  // every phrasing here must pass untouched.
  const honest = [
    "I can't schedule reminders yet — that isn't connected on this installation.",
    'I could not set the reminder: the time you gave has already passed.',
    "The reminder wasn't created because the scheduler refused the date.",
    'No reminder has been created yet — tell me a time and I will set one.',
    "I'll set a reminder for 3pm — does that work?",
    'Do you want me to send the email now?',
    'Should I schedule the meeting for Tuesday?',
    'Your meeting is scheduled for 3pm tomorrow.', // describing state, not claiming an act
    'If you like, I can create a task for that.',
    'Reminders let you get a nudge at a chosen time.',
    'The sunset is beautiful today.',
    '',
  ];
  for (const text of honest) {
    it(`ignores: "${(text || '(empty)').slice(0, 50)}"`, () => {
      expect(claimsCompletedAction(text)).toBe(false);
    });
  }

  it('distinguishes artifact completion from ordinary action completion', () => {
    expect(claimsArtifactCompletion("Done — here's your image.")).toBe(true);
    expect(claimsArtifactCompletion('Done — reminder set.')).toBe(false);
    expect(claimsArtifactCompletion('Image generation is unavailable. No image was created or attached.')).toBe(false);
  });
});

// ------------------------------------------------------------- the loop

let db: TestDb;
let userId: string;
let threadId: string;
const KEY = new MasterKey(Buffer.alloc(32, 7));

beforeEach(async () => {
  db = await testDb();
  userId = (await createUser(db, { email: 'g@ce.test', username: 'guard-owner', role: 'super_admin' })).id;
  threadId = (await createThread(db, { ownerUserId: userId })).id;
  await db.query(
    `insert into llm_providers
       (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
        cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
     values ('primary','openai','gpt-test',$1,true,now(),now(),true,true,true,8000)`,
    [seal(KEY, { apiKey: 'k' })],
  );
});

/** A provider that answers with a scripted sequence and records what it saw. */
function scripted(replies: Array<{ content?: string; tool_calls?: unknown[] }>) {
  const seen: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    const next = replies.shift() ?? { content: 'ok' };
    return new Response(
      JSON.stringify({ choices: [{ message: next }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const registry = (fetchImpl: typeof fetch) =>
  ({ db, masterKey: KEY, fetchImpl, resolve: async () => ['203.0.113.5'] });

const turn = (fetchImpl: typeof fetch, inbound = 'remind me to call in 5 minutes') =>
  runAssistantTurn({ db, registry: registry(fetchImpl), userId, threadId, history: [], inbound });

describe('the fabrication guard in the loop', () => {
  it('re-prompts once, and an honest rewrite passes through', async () => {
    const { fetchImpl, seen } = scripted([
      { content: 'Done — reminder set. It fires at 03:51 UTC.' },
      { content: 'I have not set that reminder yet. Want me to schedule it for 5 minutes from now?' },
    ]);
    const result = await turn(fetchImpl);
    expect(result.reply).toMatch(/not set that reminder yet/);
    expect(result.actions).toHaveLength(0);
    // The correction happened between the two model calls, invisibly.
    expect(seen).toHaveLength(2);
    const lastUser = seen[1].messages.at(-1);
    expect(lastUser?.role).toBe('user');
    expect(lastUser?.content).toMatch(/no tool ran this turn/);
  });

  it('re-prompting may also produce a REAL tool call, which then counts as a receipt', async () => {
    const { fetchImpl } = scripted([
      { content: 'Reminder set for five minutes from now.' },
      {
        content: null as unknown as string,
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'schedule_reminder', arguments: JSON.stringify({ message: 'call', in_minutes: 5 }) },
        }],
      },
      { content: 'Done — reminder set, it fires in 5 minutes.' },
    ]);
    const result = await turn(fetchImpl);
    // Now the claim is TRUE: a tool ran, the reply stands.
    expect(result.reply).toMatch(/reminder set/i);
    expect(result.actions.map((a) => a.tool)).toContain('schedule_reminder');
    expect(await db.query(`select id from reminders`)).toHaveLength(1);
  });

  it('replaces the reply when the model fabricates twice', async () => {
    const { fetchImpl } = scripted([
      { content: 'Done — reminder set. It fires at 03:51 UTC.' },
      { content: 'Reminder set! It goes off at 03:51.' },
    ]);
    const result = await turn(fetchImpl);
    expect(result.reply).toBe(CLAIM_GUARD_FALLBACK);
    expect(result.actions).toHaveLength(0);
    // And the interception is auditable.
    const events = await db.query<{ kind: string }>(
      `select kind from events where kind = 'agent.claim_without_receipt'`,
    );
    expect(events).toHaveLength(1);
  });

  it('leaves ordinary honest replies alone — one model call, no correction', async () => {
    const { fetchImpl, seen } = scripted([
      { content: 'I can help with reminders — what time would you like?' },
    ]);
    const result = await turn(fetchImpl);
    expect(result.reply).toMatch(/what time/);
    expect(seen).toHaveLength(1);
  });

  it('blocks an artifact-less completion even when an unrelated tool receipt exists', async () => {
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_open_tasks', arguments: '{}' } }],
      },
      { content: "Done — here's your image." },
      { content: 'Image generation is unavailable. No image was created or attached.' },
    ]);
    const result = await turn(fetchImpl, 'continue');
    expect(result.reply).toMatch(/unavailable/i);
    expect(result.actions.map((action) => action.tool)).toEqual(['list_open_tasks']);
    expect(seen).toHaveLength(3);
    expect(seen[2].messages.at(-1)?.content).toMatch(/no artifact receipt or attachment/i);
    const events = await db.query<{ payload: Record<string, unknown> }>(
      `select payload from events where kind='agent.artifact_claim_without_receipt'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ receiptCount: 1 });
  });

  it('replaces a doubled-down artifact claim with an artifact-specific correction', async () => {
    const { fetchImpl } = scripted([
      { content: "Done — here's your image." },
      { content: 'The image is ready for download.' },
    ]);
    const result = await turn(fetchImpl, 'continue');
    expect(result.reply).toBe(ARTIFACT_CLAIM_GUARD_FALLBACK);
  });

  it('a claim WITH a real tool receipt is never touched', async () => {
    const { fetchImpl, seen } = scripted([
      {
        content: null as unknown as string,
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'schedule_reminder', arguments: JSON.stringify({ message: 'call', in_minutes: 5 }) },
        }],
      },
      { content: 'Done — reminder set, it fires in 5 minutes.' },
    ]);
    const result = await turn(fetchImpl);
    expect(result.reply).toMatch(/Done — reminder set/);
    expect(seen).toHaveLength(2); // no corrective third call
  });
});
