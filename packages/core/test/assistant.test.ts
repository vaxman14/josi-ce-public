// The assistant's domain logic.
//
// The task-state-machine and gate tests are ported from the commercial engine
// (`packages/core/test/{engine,authority,metrics}.test.ts`) as the plan
// requires, so behaviour drift while removing `tenant_id` shows up as a red
// test rather than as a difference nobody noticed. Where a test could not port,
// it is noted here and in PHASE_5_EVIDENCE.md rather than quietly dropped.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  AuditContentError, appendEvent, assertMetadataOnly,
  DEFAULT_APPROVAL_LEVEL, MAX_ATTEMPTS, SENSITIVE_ACTIONS, TERMINAL_STATES,
  acquireLock, approvalHash, checkStepUp, consumeApproval, createContact, createTask,
  createThread, decideApproval, effectiveApprovalLevel, expireHolds, getApprovalLevel,
  getTask, isRiskyAction, isSensitiveAction, legalTransitions, listMessages, listTasksFor,
  missingSlots, needsApproval, placeHold, recordAttempt, recordExchange, releaseLock,
  requestApproval, setAdminApprovalCeiling, setSlots, setUserApprovalLevel, settleHold,
  taskMetrics, transition, verifyStepUp,
  claimJobs, completeJob, enqueue, failJob,
  type ApprovalLevel, type TaskState,
} from '../src/index.js';

let db: TestDb;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await testDb();
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'super_admin' })).id;
  bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
});

const newTask = (owner = alice, templateKey = 'follow_up', slots: Record<string, unknown> = {}) =>
  createTask(db, { ownerUserId: owner, templateKey, slots });

// ------------------------------------------------------------ state machine

describe('the task state machine', () => {
  it('starts in drafting and reports what is missing', async () => {
    const task = await newTask(alice, 'follow_up', { what: 'call the plumber' });
    expect(task.state).toBe('drafting');
    const [row] = await db.query<{ contract: any }>(
      `select contract from task_templates where key = 'follow_up'`,
    );
    expect(missingSlots(row.contract, task.slots)).toEqual(['when']);
  });

  it('permits exactly the transitions the engine allows and refuses the rest', async () => {
    // The edge set, asserted whole. A future edit that adds a shortcut — say
    // drafting straight to confirmed — fails here rather than in production.
    const expected: Record<TaskState, TaskState[]> = {
      drafting: ['awaiting_approval', 'ready', 'cancelled'],
      awaiting_approval: ['ready', 'cancelled'],
      ready: ['attempting', 'cancelled'],
      attempting: ['held', 'awaiting_owner', 'confirmed', 'ready', 'failed', 'cancelled'],
      held: ['attempting', 'awaiting_owner', 'confirmed', 'failed', 'cancelled'],
      awaiting_owner: ['ready', 'attempting', 'confirmed', 'cancelled', 'failed'],
      confirmed: ['closed'],
      failed: ['closed', 'ready'],
      cancelled: ['closed'],
      closed: [],
    };
    for (const [from, tos] of Object.entries(expected)) {
      expect(legalTransitions(from as TaskState), from).toEqual(tos);
    }
  });

  it('refuses an illegal transition rather than wandering', async () => {
    const task = await newTask();
    await expect(transition(db, task.id, 'confirmed')).rejects.toThrow(/illegal transition/);
    expect((await getTask(db, task.id)).state).toBe('drafting');
  });

  it('records a fail reason only when failing, and clears it on retry', async () => {
    const task = await newTask();
    await transition(db, task.id, 'ready');
    await transition(db, task.id, 'attempting');
    const failed = await transition(db, task.id, 'failed', { reason: 'nobody answered' });
    expect(failed.fail_reason).toBe('nobody answered');
    const retried = await transition(db, task.id, 'ready');
    expect(retried.state).toBe('ready');
  });

  it('closes only from a finished state', async () => {
    const task = await newTask();
    await expect(transition(db, task.id, 'closed')).rejects.toThrow();
    for (const state of TERMINAL_STATES) {
      if (state === 'closed') continue;
      expect(legalTransitions(state)).toContain('closed');
    }
  });

  it('counts attempts', async () => {
    const task = await newTask();
    await recordAttempt(db, { taskId: task.id, kind: 'owner_ask', outcome: 'reached' });
    await recordAttempt(db, { taskId: task.id, kind: 'owner_ask', outcome: 'no_answer' });
    expect((await getTask(db, task.id)).attempt_count).toBe(2);
  });

  it('refuses an unknown or disabled template', async () => {
    await expect(newTask(alice, 'nonexistent')).rejects.toThrow(/unknown template/);
    await db.query(`update task_templates set enabled = false where key = 'follow_up'`);
    await expect(newTask(alice, 'follow_up')).rejects.toThrow(/disabled/);
  });
});

// ------------------------------------------------------------- CE isolation

describe('a task belongs to one person', () => {
  it('does not appear in another member list', async () => {
    await newTask(alice);
    expect(await listTasksFor(db, { ownerUserId: alice })).toHaveLength(1);
    expect(await listTasksFor(db, { ownerUserId: bob })).toHaveLength(0);
  });

  it('is not visible to the super admin through the domain layer either', async () => {
    // alice IS the super admin here. Her own task is hers; bob's is not, and
    // being super admin does not change that.
    await newTask(bob);
    expect(await listTasksFor(db, { ownerUserId: alice })).toHaveLength(0);
  });
});

describe('a conversation belongs to one person', () => {
  it('keeps its messages out of the audit log', async () => {
    const thread = await createThread(db, { ownerUserId: alice });
    await recordExchange(db, {
      ownerUserId: alice, threadId: thread.id,
      inbound: 'SECRET-BUSINESS-DETAIL', reply: 'SECRET-REPLY-DETAIL',
    });

    // The words are in messages, where the thread's ownership governs them.
    const messages = await listMessages(db, { threadId: thread.id });
    expect(messages.map((m) => m.body)).toEqual(['SECRET-BUSINESS-DETAIL', 'SECRET-REPLY-DETAIL']);

    // And nowhere in the log the super admin reads.
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('SECRET-BUSINESS-DETAIL');
    expect(events).not.toContain('SECRET-REPLY-DETAIL');
    // The fact of the exchange is recorded, with sizes.
    expect(events).toContain('thread.exchange');
    expect(events).toContain('inboundChars');
  });

  it('keeps slot VALUES out of the audit log', async () => {
    const task = await newTask(alice, 'follow_up', { what: 'PRIVATE-SLOT-VALUE' });
    await setSlots(db, task.id, { when: 'ANOTHER-PRIVATE-VALUE' });
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('PRIVATE-SLOT-VALUE');
    expect(events).not.toContain('ANOTHER-PRIVATE-VALUE');
    // Key names are metadata and are useful; values are not recorded.
    expect(events).toContain('"keys":["when"]');
  });

  it('keeps contact details out of the audit log', async () => {
    await createContact(db, {
      ownerUserId: alice, name: 'PRIVATE-CONTACT-NAME', email: 'private@somewhere.test',
    });
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('PRIVATE-CONTACT-NAME');
    expect(events).not.toContain('private@somewhere.test');
  });
});

// --------------------------------------------------------- approval levels

describe('approval levels', () => {
  it('defaults to always ask', () => {
    expect(DEFAULT_APPROVAL_LEVEL).toBe('always_ask');
    expect(effectiveApprovalLevel(null, null)).toBe('always_ask');
  });

  /** M33's whole truth table. The direction is the point: an admin may tighten
   * and may never loosen. */
  it('takes the stricter of user choice and admin ceiling, always', () => {
    const levels: ApprovalLevel[] = ['always_ask', 'risky_only', 'automatic'];
    const rank = { always_ask: 0, risky_only: 1, automatic: 2 };
    for (const user of levels) {
      for (const admin of levels) {
        const effective = effectiveApprovalLevel(user, admin);
        expect(rank[effective], `${user} x ${admin}`).toBe(Math.min(rank[user], rank[admin]));
        // Never looser than what the user consented to.
        expect(rank[effective]).toBeLessThanOrEqual(rank[user]);
        // Never looser than what the admin permits.
        expect(rank[effective]).toBeLessThanOrEqual(rank[admin]);
      }
    }
  });

  it('lets an admin tighten a user who chose automatic', async () => {
    // Start from an open ceiling on purpose. Migration 0016 seeds `always_ask`,
    // so a user's `automatic` has no visible effect until the administrator has
    // deliberately allowed it — which is the hardened default, and is what
    // LB10.1 asserts. What this test is about is what happens NEXT.
    await setAdminApprovalCeiling(db, {
      actorUserId: alice, actionClass: 'email_send', maxLevel: 'automatic', confirmRelaxation: true,
    });
    await setUserApprovalLevel(db, { userId: bob, actionClass: 'email_send', level: 'automatic' });
    expect((await getApprovalLevel(db, { userId: bob, actionClass: 'email_send' })).level).toBe('automatic');

    await setAdminApprovalCeiling(db, { actorUserId: alice, actionClass: 'email_send', maxLevel: 'always_ask' });
    const after = await getApprovalLevel(db, { userId: bob, actionClass: 'email_send' });
    expect(after.level).toBe('always_ask');
    // The user's own choice is not overwritten — the ceiling is applied on top,
    // so lifting the ceiling restores what they actually chose.
    expect(after.userChoice).toBe('automatic');
  });

  it('does NOT let an admin loosen a user who chose always ask', async () => {
    await setUserApprovalLevel(db, { userId: bob, actionClass: 'email_send', level: 'always_ask' });
    // Loosening now needs saying so out loud. The point of the test is
    // unchanged: even with the ceiling wide open, the user's own always_ask wins.
    await setAdminApprovalCeiling(db, {
      actorUserId: alice, actionClass: 'email_send', maxLevel: 'automatic', confirmRelaxation: true,
    });
    expect((await getApprovalLevel(db, { userId: bob, actionClass: 'email_send' })).level).toBe('always_ask');
  });

  it('asks about a risky action even when the user allowed routine work', async () => {
    // The ceiling is seeded `always_ask` by migration 0016, so it has to be
    // opened deliberately before a user's `automatic` can take effect at all.
    // That is the hardened default doing its job; this test is about the
    // separate floor underneath it.
    await setAdminApprovalCeiling(db, {
      actorUserId: alice, actionClass: 'email_send', maxLevel: 'automatic', confirmRelaxation: true,
    });
    await setUserApprovalLevel(db, { userId: bob, actionClass: 'email_send', level: 'automatic' });
    expect(await needsApproval(db, { userId: bob, actionClass: 'email_send', action: 'send_email' })).toBe(false);
    // The map names these two outright: adding a recipient, and attachments.
    expect(isRiskyAction('add_recipient')).toBe(true);
    expect(isRiskyAction('send_attachment')).toBe(true);
    expect(await needsApproval(db, { userId: bob, actionClass: 'email_send', action: 'add_recipient' })).toBe(true);
    expect(await needsApproval(db, { userId: bob, actionClass: 'email_send', action: 'send_attachment' })).toBe(true);
  });
});

// ------------------------------------------------------- approval records

describe('an approval pins the exact action', () => {
  const payload = { to: 'client@example.test', subject: 'Thursday' };

  async function pending() {
    const task = await newTask(alice);
    const approval = await requestApproval(db, {
      taskId: task.id, ownerUserId: alice, actionClass: 'email_send', action: 'send_email',
      summary: 'Email client@example.test about Thursday', payload,
    });
    return { task, approval };
  }

  it('is spendable once approved, for that payload', async () => {
    const { approval } = await pending();
    await decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: true });
    expect(await consumeApproval(db, { approvalId: approval.id, payload })).toEqual({ ok: true });
  });

  it('refuses when the action changed after it was approved', async () => {
    // The attack this exists for: approve "email the client", then change the
    // recipient and send it anyway.
    const { approval } = await pending();
    await decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: true });
    const result = await consumeApproval(db, {
      approvalId: approval.id,
      payload: { ...payload, to: 'someone-else@example.test' },
    });
    expect(result).toEqual({ ok: false, reason: 'payload_changed' });
    const events = await db.query(`select kind from events where kind = 'approval.payload_mismatch'`);
    expect(events).toHaveLength(1);
  });

  it('hashes independently of key order', () => {
    expect(approvalHash({ a: 1, b: 2 })).toBe(approvalHash({ b: 2, a: 1 }));
    expect(approvalHash({ a: 1 })).not.toBe(approvalHash({ a: 2 }));
  });

  it('cannot be spent while pending or after denial', async () => {
    const { approval } = await pending();
    expect((await consumeApproval(db, { approvalId: approval.id, payload })).reason).toBe('not_approved');
    await decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: false });
    expect((await consumeApproval(db, { approvalId: approval.id, payload })).reason).toBe('not_approved');
  });

  it('cannot be decided by anyone but the person it is for', async () => {
    const { approval } = await pending();
    // bob is a member; alice is the super admin. Neither being a colleague nor
    // being an administrator is consent.
    await expect(
      decideApproval(db, { approvalId: approval.id, decidedBy: bob, approve: true }),
    ).rejects.toThrow(/only the person/);
  });

  it('cannot be decided twice', async () => {
    const { approval } = await pending();
    await decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: true });
    await expect(
      decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: false }),
    ).rejects.toThrow(/already approved/);
  });

  it('does not stack duplicate requests for the same action', async () => {
    const { task } = await pending();
    await requestApproval(db, {
      taskId: task.id, ownerUserId: alice, actionClass: 'email_send', action: 'send_email',
      summary: 'Email client@example.test about Thursday', payload,
    });
    const rows = await db.query(`select id from approvals where status = 'pending'`);
    expect(rows).toHaveLength(1);
  });

  it('keeps the summary out of the audit log', async () => {
    await pending();
    const events = JSON.stringify(await db.query(`select * from events`));
    expect(events).not.toContain('client@example.test');
    expect(events).toContain('approval.requested');
  });

  it('expires rather than lingering, and cannot be spent after', async () => {
    const task = await newTask(alice);
    const approval = await requestApproval(db, {
      taskId: task.id, ownerUserId: alice, actionClass: 'email_send', action: 'send_email',
      summary: 's', payload, ttlSeconds: 1,
    });
    await decideApproval(db, { approvalId: approval.id, decidedBy: alice, approve: true });
    await db.query(`update approvals set expires_at = now() - interval '1 minute' where id = $1`, [approval.id]);
    expect((await consumeApproval(db, { approvalId: approval.id, payload })).reason).toBe('expired');
  });
});

// --------------------------------------------------------------- step-up

describe('step-up re-authentication', () => {
  const yes = async () => true;
  const no = async () => false;

  it('classifies consequential actions, and only those', () => {
    expect(isSensitiveAction('cancel_task')).toBe(true);
    expect(isSensitiveAction('delete_data')).toBe(true);
    expect(isSensitiveAction('share_resource')).toBe(true);
    // Ordinary conversation stays frictionless — a gate met constantly is a
    // gate that gets turned off.
    expect(isSensitiveAction('create_task')).toBe(false);
    expect(isSensitiveAction('list_open_tasks')).toBe(false);
    expect(SENSITIVE_ACTIONS.length).toBeGreaterThan(0);
  });

  it('lets an unremarkable action through with no challenge', async () => {
    const d = await checkStepUp(db, { userId: alice, sessionKey: 'S1', action: 'create_task' });
    expect(d).toMatchObject({ allowed: true, reason: 'not_sensitive' });
  });

  it('refuses a consequential action on a session alone', async () => {
    const d = await checkStepUp(db, { userId: alice, sessionKey: 'S1', action: 'cancel_task' });
    expect(d).toMatchObject({ allowed: false, reason: 'needs_reauth' });
    const events = await db.query(`select kind from events where kind = 'stepup.required'`);
    expect(events).toHaveLength(1);
  });

  it('unlocks the session once the password is confirmed', async () => {
    expect(await verifyStepUp(db, {
      userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes,
    })).toEqual({ ok: true });
    const d = await checkStepUp(db, { userId: alice, sessionKey: 'S1', action: 'cancel_task' });
    expect(d).toMatchObject({ allowed: true, reason: 'verified', method: 'password' });
  });

  it('unlocks only that session', async () => {
    await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes });
    const other = await checkStepUp(db, { userId: alice, sessionKey: 'S2', action: 'cancel_task' });
    expect(other.allowed).toBe(false);
  });

  it('unlocks only that person', async () => {
    await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes });
    const other = await checkStepUp(db, { userId: bob, sessionKey: 'S1', action: 'cancel_task' });
    expect(other.allowed).toBe(false);
  });

  it('expires', async () => {
    await verifyStepUp(db, {
      userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes, ttlSeconds: 1,
    });
    await db.query(`update step_up_verifications set expires_at = now() - interval '1 minute'`);
    expect((await checkStepUp(db, { userId: alice, sessionKey: 'S1', action: 'cancel_task' })).allowed).toBe(false);
  });

  it('locks out after repeated failures, and still logs the attempts', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'w', verifyPassword: no });
      expect(r.ok).toBe(false);
    }
    const locked = await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'w', verifyPassword: no });
    expect(locked).toMatchObject({ ok: false, reason: 'locked_out' });

    const decision = await checkStepUp(db, { userId: alice, sessionKey: 'S1', action: 'cancel_task' });
    expect(decision.reason).toBe('locked_out');
    // The most suspicious case must not be the one that leaves no trace.
    const required = await db.query(`select kind from events where kind = 'stepup.required'`);
    expect(required.length).toBeGreaterThan(0);
  });

  /** The engine learned this the hard way: counting failures over all time
   * locked an owner out of their own assistant permanently, three typos in a
   * lifetime. A rate limit is a cool-down, not a life sentence. */
  it('forgets failures older than the cool-down window', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'w', verifyPassword: no });
    }
    expect((await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes })).reason)
      .toBe('locked_out');

    // The failures cannot be back-dated: `events` is append-only and the
    // trigger refuses an UPDATE, which is the Phase 1 guard doing its job. So
    // the aged-out failures are INSERTED as history instead — which is also a
    // more faithful simulation of what a real cool-down looks like.
    await db.query(`delete from step_up_verifications`);
    const fresh = 'S-AGED';
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await db.query(
        `insert into events (actor_user_id, actor, kind, payload, created_at)
         values ($1, 'user', 'stepup.failed', jsonb_build_object('sessionKey', $2::text), now() - interval '1 hour')`,
        [alice, fresh],
      );
    }
    expect(await verifyStepUp(db, { userId: alice, sessionKey: fresh, password: 'x', verifyPassword: yes }))
      .toEqual({ ok: true });
  });

  it('counts a success as clearing what came before it', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'w', verifyPassword: no });
    }
    await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'x', verifyPassword: yes });
    // Fresh failures start from zero rather than from four.
    const r = await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'w', verifyPassword: no });
    expect(r.reason).toBe('mismatch');
    expect(r.attemptsLeft).toBe(MAX_ATTEMPTS - 1);
  });

  it('never records the password, right or wrong', async () => {
    await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'testing-password', verifyPassword: no });
    await verifyStepUp(db, { userId: alice, sessionKey: 'S1', password: 'testing-password', verifyPassword: yes });
    const dump = JSON.stringify(await db.query(`select * from events`))
      + JSON.stringify(await db.query(`select * from step_up_verifications`));
    expect(dump).not.toContain('testing-password');
  });
});

// ----------------------------------------------------------- locks + holds

describe('locks and holds', () => {
  it('lets one task hold a resource and refuses the second', async () => {
    const a = await newTask(alice);
    const b = await newTask(bob);
    expect(await acquireLock(db, { resourceKey: 'calendar:thu-3pm', taskId: a.id })).toBe(true);
    // Deliberately installation-wide, not per user: two members reaching for
    // the same room at the same time is exactly the collision this prevents.
    expect(await acquireLock(db, { resourceKey: 'calendar:thu-3pm', taskId: b.id })).toBe(false);
    await releaseLock(db, { resourceKey: 'calendar:thu-3pm', taskId: a.id });
    expect(await acquireLock(db, { resourceKey: 'calendar:thu-3pm', taskId: b.id })).toBe(true);
  });

  it('reaps an expired lock so a crashed task cannot wedge a resource', async () => {
    const a = await newTask(alice);
    const b = await newTask(bob);
    await acquireLock(db, { resourceKey: 'r', taskId: a.id, ttlSeconds: 1 });
    await db.query(`update resource_locks set expires_at = now() - interval '1 minute'`);
    expect(await acquireLock(db, { resourceKey: 'r', taskId: b.id })).toBe(true);
  });

  it('expires a hold and hands back the external reference to clean up', async () => {
    const task = await newTask(alice);
    await placeHold(db, {
      taskId: task.id, resourceKey: 'calendar:primary',
      startsAt: new Date(), endsAt: new Date(Date.now() + 3600_000),
      ttlSeconds: 1, externalRef: 'gcal-event-123',
    });
    await db.query(`update holds set expires_at = now() - interval '1 minute'`);
    const expired = await expireHolds(db);
    expect(expired).toHaveLength(1);
    // Without the ref the calendar keeps a phantom block, which is worse than
    // no hold at all.
    expect(expired[0].external_ref).toBe('gcal-event-123');
  });

  it('settles a hold exactly once', async () => {
    const task = await newTask(alice);
    const hold = await placeHold(db, {
      taskId: task.id, resourceKey: 'r', startsAt: new Date(), endsAt: new Date(), ttlSeconds: 60,
    });
    await settleHold(db, hold.id, 'converted');
    await settleHold(db, hold.id, 'released');
    const [row] = await db.query<{ status: string }>(`select status from holds where id = $1`, [hold.id]);
    expect(row.status).toBe('converted');
  });
});

// ----------------------------------------------------------------- queue

describe('the job queue', () => {
  it('claims a due job once', async () => {
    await enqueue(db, { kind: 'task.wake', payload: { taskId: 'x' } });
    const first = await claimJobs(db, 'worker-1');
    expect(first).toHaveLength(1);
    expect(await claimJobs(db, 'worker-2')).toHaveLength(0);
    await completeJob(db, first[0].id);
  });

  it('does not claim a job scheduled for later', async () => {
    await enqueue(db, { kind: 'later', runAt: new Date(Date.now() + 3600_000) });
    expect(await claimJobs(db, 'w')).toHaveLength(0);
  });

  it('backs off on failure and dies after max attempts', async () => {
    await enqueue(db, { kind: 'flaky' });
    for (let i = 0; i < 5; i++) {
      const [job] = await claimJobs(db, 'w');
      if (!job) break;
      await failJob(db, job.id, 'nope');
      await db.query(`update job_queue set run_at = now() where id = $1`, [job.id]);
    }
    const [row] = await db.query<{ status: string; attempts: number }>(`select status, attempts from job_queue`);
    expect(row.status).toBe('dead');
  });
});

// --------------------------------------------------------------- metrics

describe('metrics', () => {
  it('reports zero rather than dividing by zero on an empty installation', async () => {
    const m = await taskMetrics(db, { ownerUserId: alice });
    expect(m).toMatchObject({ tasks: 0, interrupt_rate: 0, correction_rate: 0 });
  });

  it('counts a task that bounced back to its owner as an interrupt, even if it later finished', async () => {
    const task = await newTask(alice);
    await transition(db, task.id, 'ready');
    await transition(db, task.id, 'attempting');
    await transition(db, task.id, 'awaiting_owner');
    await transition(db, task.id, 'confirmed');

    const m = await taskMetrics(db, { ownerUserId: alice });
    expect(m.tasks).toBe(1);
    expect(m.interrupted).toBe(1);
    expect(m.interrupt_rate).toBe(1);
  });

  /** The denominator is what makes this honest: score corrections over every
   * task and an agent that never asks anything looks flawless. */
  it('scores corrections against what the owner reviewed, not against everything', async () => {
    const reviewed = await newTask(alice);
    await setSlots(db, reviewed.id, { what: 'x' }, { actor: 'user', actorUserId: alice });
    await newTask(alice); // never looked at

    const m = await taskMetrics(db, { ownerUserId: alice });
    expect(m.tasks).toBe(2);
    expect(m.reviewed).toBe(1);
    expect(m.corrected).toBe(1);
    expect(m.correction_rate).toBe(1); // 1 of 1 reviewed, not 1 of 2 tasks
  });

  it('scopes to one person, and can report installation-wide for the admin', async () => {
    await newTask(alice);
    await newTask(bob);
    expect((await taskMetrics(db, { ownerUserId: alice })).tasks).toBe(1);
    expect((await taskMetrics(db, { ownerUserId: bob })).tasks).toBe(1);
    // No owner = the whole installation. Counts of state transitions, which say
    // nothing about what any task was about.
    expect((await taskMetrics(db)).tasks).toBe(2);
  });

  it('breaks down by template', async () => {
    await newTask(alice, 'follow_up');
    await newTask(alice, 'schedule_appointment');
    const m = await taskMetrics(db, { ownerUserId: alice });
    expect(m.by_template.map((t) => t.template_key).sort()).toEqual(['follow_up', 'schedule_appointment']);
  });
});

// -------------------------------------------------- the audit content guard

/** Found by Phase 5 mutation M25: deleting `assertMetadataOnly` from
 * `appendEvent` left all 328 tests green.
 *
 * Every other audit test asserts that content does not APPEAR in the log — but
 * they do it with payloads that never carried a content key in the first place,
 * so they pass whether the guard exists or not. The backstop itself was
 * untested from Phase 1 until now, which means the next careless
 * `payload: { body: ... }` would have shipped.
 *
 * `events.ts` says the guard is "exported so tests can assert the guard itself
 * works". This is that test. */
describe('the audit-payload content guard', () => {
  it('refuses every key that looks like content or a credential', async () => {
    const forbidden = [
      'body', 'bodyText', 'body_text', 'content', 'text', 'message', 'subject',
      'snippet', 'preview', 'filename', 'file_name', 'path', 'extractedText',
      'password', 'token', 'access_token', 'refresh_token', 'secret', 'secrets',
      'apiKey', 'api_key', 'client_secret',
    ];
    for (const key of forbidden) {
      await expect(
        appendEvent(db, { actor: 'system', kind: 'test.guard', payload: { [key]: 'anything' } }),
        key,
      ).rejects.toThrow(AuditContentError);
    }
  });

  it('throws rather than writing the row, so a bad payload leaves no trace', async () => {
    await expect(
      appendEvent(db, { actor: 'system', kind: 'test.guard', payload: { body: 'LEAKED' } }),
    ).rejects.toThrow();
    const rows = await db.query(`select id from events where kind = 'test.guard'`);
    expect(rows).toHaveLength(0);
  });

  it('still allows ordinary metadata through', async () => {
    await appendEvent(db, {
      actor: 'system', kind: 'test.guard',
      payload: { count: 3, keys: ['a'], taskId: 'x', durationMs: 12 },
    });
    expect(await db.query(`select id from events where kind = 'test.guard'`)).toHaveLength(1);
  });

  it('is called by appendEvent, not merely available to call', async () => {
    // The distinction M25 exposed: a guard nothing invokes is decoration.
    expect(() => assertMetadataOnly({ subject: 'x' })).toThrow(AuditContentError);
    await expect(
      appendEvent(db, { actor: 'system', kind: 'test.guard', payload: { subject: 'x' } }),
    ).rejects.toThrow(AuditContentError);
  });
});
