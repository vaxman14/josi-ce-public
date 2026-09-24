// Approval gates.
//
// Two separate mechanisms live here and it matters that they stay separate:
//
//   1. HOW MUCH may Josi do without asking? A per-user preference per action
//      class, with an admin ceiling that can only tighten. That is
//      `effectiveApprovalLevel`.
//   2. Did the owner agree to THIS EXACT ACTION? A pinned, hashed approval
//      record. That is `requestApproval` / `decideApproval`.
//
// The first without the second is a policy nobody enforced; the second without
// the first means asking about everything forever, which trains people to click
// yes without reading.
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { appendEvent } from './events.js';

/** How much autonomy the owner granted for a class of action.
 *
 * Ordered from strictest to loosest — `STRICTNESS` below depends on this
 * ordering, and `min` of two levels is what makes admin policy deny-only. */
export type ApprovalLevel = 'always_ask' | 'risky_only' | 'automatic';

const STRICTNESS: Record<ApprovalLevel, number> = {
  always_ask: 0,
  risky_only: 1,
  automatic: 2,
};

/** M33: the default is Always ask. A default of anything else would mean an
 * installation nobody configured is one where Josi acts unasked. */
export const DEFAULT_APPROVAL_LEVEL: ApprovalLevel = 'always_ask';

/** No managed administrator ceiling exists until one is explicitly set. */
export const DEFAULT_ADMIN_CEILING: ApprovalLevel | null = null;

export type ApprovalErrorCode =
  | 'invalid_policy'
  | 'policy_conflict'
  | 'not_found'
  | 'not_owner'
  | 'already_decided'
  | 'expired'
  | 'race';

export class ApprovalError extends Error {
  constructor(message: string, readonly code: ApprovalErrorCode = 'invalid_policy') {
    super(message);
  }
}

// ------------------------------------------------------------ action classes

/** How much damage the class of action can do outside this installation. */
export type ActionImpact = 'routine' | 'high';

export interface ActionClassSpec {
  key: string;
  /** What the administrator is deciding, in their words. */
  label: string;
  description: string;
  impact: ActionImpact;
}

/** Every class of action an approval level can be set for. Unknown classes are refused. */
export const ACTION_CLASSES: readonly ActionClassSpec[] = Object.freeze([
  {
    key: 'email_send',
    label: 'Sending email',
    description: 'Sending a message to somebody on your behalf.',
    impact: 'routine',
  },
  {
    key: 'calendar_write',
    label: 'Creating and changing calendar events',
    description: 'Adding, moving or editing an event, including ones other people attend.',
    impact: 'routine',
  },
  {
    key: 'contacts_write',
    label: 'Creating and changing contacts',
    description: 'Adding or editing a person in a connected address book.',
    impact: 'routine',
  },
  {
    key: 'task_management',
    label: 'Creating and changing tasks',
    description: 'Work Josi tracks for you. Nothing leaves this installation.',
    impact: 'routine',
  },
  {
    key: 'delete_data',
    label: 'Deleting anything',
    description: 'Removing a message, event, document or record. The one a mistake cannot be talked back from.',
    impact: 'high',
  },
  {
    key: 'cancel_commitment',
    label: 'Cancelling a commitment',
    description: 'Calling off a meeting, booking or arrangement other people are relying on.',
    impact: 'high',
  },
  {
    key: 'invite_external',
    label: 'Involving people outside the organisation',
    description: 'Adding an outside address to a thread, meeting or shared item.',
    impact: 'high',
  },
  {
    key: 'publish_public',
    label: 'Publishing anything publicly',
    description: 'Making something visible outside this installation.',
    impact: 'high',
  },
  {
    key: 'spend_money',
    label: 'Spending money',
    description: 'Any action that incurs a charge.',
    impact: 'high',
  },
  {
    key: 'sign_agreement',
    label: 'Signing or accepting terms',
    description: 'Agreeing to anything on your behalf.',
    impact: 'high',
  },
  {
    key: 'change_access',
    label: 'Changing who can see or do what',
    description: 'Sharing, permissions, connected accounts and account access.',
    impact: 'high',
  },
]);

const BY_KEY = new Map(ACTION_CLASSES.map((c) => [c.key, c]));

export function isApprovalLevel(value: unknown): value is ApprovalLevel {
  return value === 'always_ask' || value === 'risky_only' || value === 'automatic';
}

export function actionClassSpec(key: string): ActionClassSpec | null {
  return BY_KEY.get(key) ?? null;
}

export function isHighImpactClass(key: string): boolean {
  return BY_KEY.get(key)?.impact === 'high';
}

/** The stricter of what the user consented to and what the admin permits.
 *
 * This is the whole of M33 in one expression, and the direction is the point:
 * an admin who sets `automatic` cannot make a user's `always_ask` any looser,
 * because the user's choice is consent and consent is not an administrator's to
 * widen. An admin who sets `always_ask` CAN override a user's `automatic`,
 * because that is a restriction.
 *
 * Written as `min` rather than a branch on role: there is no role in this
 * function, so there is nowhere for a "but the admin can..." to be added. */
export function effectiveApprovalLevel(
  userChoice: ApprovalLevel | null | undefined,
  adminCeiling: ApprovalLevel | null | undefined,
): ApprovalLevel {
  // TypeScript cannot protect this boundary from malformed legacy rows or a
  // manually changed database. Unknown values must become the strictest level,
  // never flow through STRICTNESS as `undefined` and accidentally widen access.
  const user = isApprovalLevel(userChoice) ? userChoice : DEFAULT_APPROVAL_LEVEL;
  // A ceiling exists only when an administrator explicitly configured one.
  // The user's own missing preference remains fail-closed above.
  const admin = adminCeiling === null || adminCeiling === undefined
    ? DEFAULT_ADMIN_CEILING
    : isApprovalLevel(adminCeiling) ? adminCeiling : DEFAULT_APPROVAL_LEVEL;
  if (!admin) return user;
  return STRICTNESS[user] <= STRICTNESS[admin] ? user : admin;
}

/** Is `next` looser than `current`? The question every relaxation guard asks. */
export function isRelaxation(
  current: ApprovalLevel | null | undefined,
  next: ApprovalLevel,
): boolean {
  return current ? STRICTNESS[next] > STRICTNESS[current] : false;
}

/** Only a row explicitly marked by an administrator change is managed policy.
 * Migration 0060 marks historical rows only when matching audit evidence
 * exists. Runtime policy no longer depends on event retention or a JSON scan. */
async function explicitAdminCeiling(db:Db,actionClass:string):Promise<ApprovalLevel|null>{
  const [policy]=await db.query<{max_level:unknown}>(`select max_level from admin_approval_policy
    where action_class=$1 and managed_explicitly is true limit 1`,[actionClass]);
  if(!policy)return null;
  return isApprovalLevel(policy.max_level) ? policy.max_level : DEFAULT_APPROVAL_LEVEL;
}

export async function getApprovalLevel(
  db: Db,
  args: { userId: string; actionClass: string },
): Promise<{ level: ApprovalLevel; userChoice: ApprovalLevel; adminCeiling: ApprovalLevel | null; managedPolicy: boolean }> {
  if (!BY_KEY.has(args.actionClass)) {
    return { level: DEFAULT_APPROVAL_LEVEL, userChoice: DEFAULT_APPROVAL_LEVEL, adminCeiling: null, managedPolicy: false };
  }
  const [pref] = await db.query<{ level: unknown }>(
    `select level from user_approval_prefs where user_id = $1 and action_class = $2`,
    [args.userId, args.actionClass],
  );
  const userChoice = isApprovalLevel(pref?.level) ? pref.level : DEFAULT_APPROVAL_LEVEL;
  const adminCeiling = await explicitAdminCeiling(db,args.actionClass);
  return {
    level: effectiveApprovalLevel(userChoice, adminCeiling), userChoice, adminCeiling,
    managedPolicy: adminCeiling !== null,
  };
}

export async function setUserApprovalLevel(
  db: Db,
  args: { userId: string; actionClass: string; level: ApprovalLevel },
): Promise<void> {
  if (!BY_KEY.has(args.actionClass) || !isApprovalLevel(args.level)) {
    throw new ApprovalError(`there is no valid approval policy for "${args.actionClass}"`, 'invalid_policy');
  }
  if(!db.transaction)throw new ApprovalError('approval preference changes require transaction support','policy_conflict');
  await db.transaction(async tx=>{
  // Serialize preference and managed-policy writers with automatic
  // authorization. A preference can therefore never commit just after a
  // ceiling it did not see and become a silently ignored choice.
  await tx.query(`lock table admin_approval_policy, user_approval_prefs in share row exclusive mode`);
  const ceiling = await explicitAdminCeiling(tx,args.actionClass);
  if (ceiling && effectiveApprovalLevel(args.level, ceiling) !== args.level) {
    throw new ApprovalError(`the managed workspace policy permits at most ${ceiling}`,'policy_conflict');
  }
  await tx.query(
    `insert into user_approval_prefs (user_id, action_class, level) values ($1, $2, $3)
     on conflict (user_id, action_class) do update set level = excluded.level`,
    [args.userId, args.actionClass, args.level],
  );
  await appendEvent(tx, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'approval.level_set',
    payload: { actionClass: args.actionClass, level: args.level },
  });
  });
}

/** Set the loosest level anybody on this installation may choose.
 *
 * Tightening is an ordinary administrative act. **Loosening is not**, and the
 * asymmetry is deliberate: relaxing a ceiling is the change that lets Josi act
 * on somebody's behalf without asking, and it is the change nobody remembers
 * making. So a relaxation must say so — `confirmRelaxation` — and the event
 * records what it was before, what it became, and who did it.
 *
 * The guard is here rather than in the route because the route is not the only
 * caller, and a second caller added later would otherwise bypass it silently. */
export async function setAdminApprovalCeiling(
  db: Db,
  args: {
    actorUserId: string;
    actionClass: string;
    maxLevel: ApprovalLevel;
    /** Required when the new ceiling is looser than the current one. */
    confirmRelaxation?: boolean;
  },
): Promise<{ previous: ApprovalLevel | null; relaxed: boolean }> {
  if(!db.transaction)throw new ApprovalError('managed policy changes require transaction support');
  return db.transaction(tx=>setAdminApprovalCeilingInTransaction(tx,args));
}

async function setAdminApprovalCeilingInTransaction(
  db:Db,
  args:{actorUserId:string;actionClass:string;maxLevel:ApprovalLevel;confirmRelaxation?:boolean},
):Promise<{previous:ApprovalLevel|null;relaxed:boolean}>{
  await db.query(`lock table admin_approval_policy, user_approval_prefs in share row exclusive mode`);
  if (!BY_KEY.has(args.actionClass) || !isApprovalLevel(args.maxLevel)) {
    // An unknown class would store a row nothing reads and no screen shows.
    throw new ApprovalError(`there is no valid managed policy for "${args.actionClass}"`,'invalid_policy');
  }

  const previous = await explicitAdminCeiling(db,args.actionClass);
  const relaxed = isRelaxation(previous, args.maxLevel);

  if (relaxed && args.confirmRelaxation !== true) {
    throw new ApprovalError(
      'loosening an approval ceiling has to be confirmed explicitly, because it lets Josi '
      + 'act without asking first',
      'policy_conflict',
    );
  }

  // `automatic` means the administrator is returning control to each person,
  // not installing a managed policy that happens to have no effect.
  if (args.maxLevel === 'automatic') {
    await db.query(`delete from admin_approval_policy where action_class = $1`, [args.actionClass]);
    await appendEvent(db, {
      actorUserId: args.actorUserId,
      actor: 'super_admin',
      kind: 'approval.ceiling_removed',
      payload: { actionClass: args.actionClass, previousMaxLevel: previous },
    });
    return { previous, relaxed };
  }

  await db.query(
    `insert into admin_approval_policy (action_class, max_level, managed_explicitly) values ($1, $2, true)
     on conflict (action_class) do update set max_level = excluded.max_level, managed_explicitly = true`,
    [args.actionClass, args.maxLevel],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    // A relaxation is its own event kind so it can be found in an audit without
    // reading the payload of every ceiling change ever made.
    kind: relaxed ? 'approval.ceiling_relaxed' : 'approval.ceiling_set',
    payload: {
      actionClass: args.actionClass,
      maxLevel: args.maxLevel,
      previousMaxLevel: previous,
      impact: BY_KEY.get(args.actionClass)?.impact ?? 'routine',
    },
  });
  return { previous, relaxed };
}

/** What migration 0016 changed, and whether the administrator has seen it.
 *
 * M-LB10.7: an existing installation must not be silently broadened OR silently
 * narrowed. The migration seeds a fail-closed ceiling for every class that had
 * none, which IS a narrowing, so it records each one and the admin is shown the
 * list rather than discovering it when Josi stops doing something. */
export interface PolicyMigrationRow {
  action_class: string;
  previous_max_level: ApprovalLevel | null;
  new_max_level: ApprovalLevel;
  reason: string;
  migrated_at: string;
  acknowledged_at: string | null;
}

export async function pendingPolicyMigration(db: Db): Promise<PolicyMigrationRow[]> {
  return db.query<PolicyMigrationRow>(
    `select action_class, previous_max_level, new_max_level, reason, migrated_at, acknowledged_at
     from approval_policy_migration where acknowledged_at is null order by action_class`,
  );
}

export async function acknowledgePolicyMigration(db: Db, actorUserId: string): Promise<number> {
  const rows = await db.query<{ action_class: string }>(
    `update approval_policy_migration set acknowledged_at = now()
     where acknowledged_at is null returning action_class`,
  );
  if (rows.length) {
    await appendEvent(db, {
      actorUserId,
      actor: 'super_admin',
      kind: 'approval.migration_acknowledged',
      payload: { classes: rows.length },
    });
  }
  return rows.length;
}

// --------------------------------------------------------------- decisions

/** Actions that are asked about even when the owner chose `risky_only`.
 *
 * The map names two of these outright — adding a recipient to an existing
 * thread, and sending any attachment — and says both require approval "even if
 * routine email sending is otherwise allowed automatically". Deleting is here
 * for the same reason: it is the one a mistake cannot be talked back from. */
export const ALWAYS_RISKY = [
  'add_recipient',
  'send_attachment',
  'delete_data',
  'spend_money',
  // The rest of the high-impact set. Each one changes something outside this
  // installation that an apology does not undo, so `risky_only` still asks.
  'cancel_commitment',
  'invite_external',
  'publish_public',
  'sign_agreement',
  'change_access',
] as const;

export function isRiskyAction(action: string): boolean {
  return (ALWAYS_RISKY as readonly string[]).includes(action);
}

/** Does this specific action need the owner to agree before it happens?
 *
 * Two independent floors, and both matter. The action list catches a named
 * action inside an otherwise routine class — adding a recipient to an email.
 * The class impact catches an action nobody thought to name: a new verb added
 * to `change_access` next year is asked about by default rather than by
 * somebody remembering to extend a list. */
export async function needsApproval(
  db: Db,
  args: { userId: string; actionClass: string; action: string },
): Promise<boolean> {
  if (!BY_KEY.has(args.actionClass)) return true;
  if (isRiskyAction(args.action)) return true;
  if (isHighImpactClass(args.actionClass)) return true;
  const { level } = await getApprovalLevel(db, { userId: args.userId, actionClass: args.actionClass });
  // A risky_only preference is a real middle setting: routine actions run,
  // while the explicit risky-action and high-impact-class floors above still
  // ask. Treating it like always_ask makes the saved choice ineffective.
  return level === 'always_ask';
}

/** Binds an approval to exactly what was described.
 *
 * An approval that does not pin the action is a rubber stamp: approve "send the
 * email", change the recipient, send it anyway. The hash covers whatever the
 * caller says the action is, and `consumeApproval` refuses when it no longer
 * matches. */
export function approvalHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** Key order must not change the hash, or an approval could be invalidated by
 * a JSON round-trip that changed nothing. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** What an approval can be about.
 *
 * Phase 5 keyed on a task; Phase 8 added threads as a second nullable column
 * with a two-way XOR; Phase 9 needs document deletes. Three nullable columns and
 * a three-way XOR is a shape that gets worse every time it is extended, so the
 * subject is polymorphic. The MECHANISM is untouched — the payload hash still
 * pins an approval to one exact action, and there is still one live request per
 * subject and action. */
export type ApprovalSubject = 'task' | 'email_thread' | 'folder_mapping' | 'document';

export interface Approval {
  id: string;
  subject_type: ApprovalSubject;
  subject_id: string;
  owner_user_id: string;
  action_class: string;
  action: string;
  summary: string;
  payload_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  created_at: string;
  expires_at: string | null;
}

export async function requestApproval(
  db: Db,
  args: {
    /** Exactly one subject. The named forms are kept because callers read
     * better for it, and because changing every call site would have been a
     * larger change than the schema itself. */
    taskId?: string | null;
    threadId?: string | null;
    mappingId?: string | null;
    documentId?: string | null;
    ownerUserId: string;
    actionClass: string;
    action: string;
    /** Shown to the owner. Content — theirs, and never copied into the audit log. */
    summary: string;
    payload: unknown;
    ttlSeconds?: number;
  },
): Promise<Approval> {
  const hash = approvalHash(args.payload);
  const subjects: Array<[ApprovalSubject, string | null | undefined]> = [
    ['task', args.taskId],
    ['email_thread', args.threadId],
    ['folder_mapping', args.mappingId],
    ['document', args.documentId],
  ];
  const given = subjects.filter(([, id]) => id);
  if (given.length !== 1) {
    throw new ApprovalError('an approval belongs to exactly one subject','invalid_policy');
  }
  const [subjectType, subjectId] = given[0] as [ApprovalSubject, string];

  const rows = await db.query<Approval>(
    `insert into approvals
       (subject_type, subject_id, owner_user_id, action_class, action, summary, payload_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, case when $8::int is null then null else now() + make_interval(secs => $8::int) end)
     on conflict (subject_type, subject_id, action, payload_hash) where status = 'pending'
       do update set summary = excluded.summary
     returning *`,
    [
      subjectType, subjectId, args.ownerUserId, args.actionClass, args.action,
      args.summary, hash, args.ttlSeconds ?? null,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'agent',
    kind: 'approval.requested',
    subjectType,
    subjectId,
    // The summary is what the action WOULD say. It stays out of the log.
    payload: { action: args.action, actionClass: args.actionClass, approvalId: rows[0].id },
  });
  return rows[0];
}

/** The owner's answer.
 *
 * `decidedBy` must be the owner. A colleague with write access to a shared task
 * may edit it; agreeing on the owner's behalf to something done in their name is
 * a different act, and this is the line. */
export async function decideApproval(
  db: Db,
  args: { approvalId: string; decidedBy: string; approve: boolean },
): Promise<Approval> {
  const [existing] = await db.query<Approval>(`select * from approvals where id = $1`, [args.approvalId]);
  if (!existing) throw new ApprovalError('no such approval','not_found');
  if (existing.owner_user_id !== args.decidedBy) {
    throw new ApprovalError('only the person the action would be taken for can approve it','not_owner');
  }
  if (existing.status !== 'pending') {
    throw new ApprovalError(`that request was already ${existing.status}`,existing.status==='expired'?'expired':'already_decided');
  }
  const rows = await db.query<Approval>(
    `update approvals a set status = $2, decided_at = now(), decided_by = $3
     where a.id = $1 and (${ACTIONABLE_PENDING_APPROVAL_SQL}) returning a.*`,
    [args.approvalId, args.approve ? 'approved' : 'denied', args.decidedBy],
  );
  if (!rows.length) throw new ApprovalError('that request was decided by someone else first','race');
  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: args.approve ? 'approval.granted' : 'approval.denied',
    subjectType: existing.subject_type,
    subjectId: existing.subject_id,
    payload: { action: existing.action, approvalId: existing.id },
  });
  return rows[0];
}

/** Spend an approval, exactly once, for exactly the action it described.
 *
 * Returns false rather than throwing on every "no" so the caller cannot forget
 * to handle one of them — but the reasons are distinguishable through the event
 * log, which is where an unexplained refusal gets investigated from. */
export async function consumeApproval(
  db: Db,
  args: { approvalId: string; payload: unknown },
): Promise<{ ok: boolean; reason?: 'not_found' | 'not_approved' | 'payload_changed' | 'expired' }> {
  const [row] = await db.query<Approval>(`select * from approvals where id = $1`, [args.approvalId]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'approved') return { ok: false, reason: 'not_approved' };
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    await db.query(`update approvals set status = 'expired' where id = $1`, [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.payload_hash !== approvalHash(args.payload)) {
    // The thing about to happen is not the thing that was agreed to.
    await appendEvent(db, {
      actorUserId: row.owner_user_id,
      actor: 'system',
      kind: 'approval.payload_mismatch',
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      payload: { approvalId: row.id, action: row.action },
    });
    return { ok: false, reason: 'payload_changed' };
  }
  return { ok: true };
}

/** Canonical dashboard predicate. Alias `a` always denotes the approval.
 * Legacy task approvals can be requested while drafting; prepared actions must
 * also pin this exact approval, owner and payload, and still await a decision.
 * No presentation/"latest message" heuristic may hide another valid request. */
export const ACTIONABLE_PENDING_APPROVAL_SQL = `
  a.status = 'pending' and (a.expires_at is null or a.expires_at > now())
  and case a.subject_type
    when 'task' then exists (
      select 1 from tasks t where t.id=a.subject_id and t.owner_user_id=a.owner_user_id
        and t.state in ('drafting','awaiting_approval')
        and not exists (
          select 1 from assistant_action_states s where s.task_id=t.id
          and not (s.status='prepared' and s.approval_id is not distinct from a.id
            and s.owner_user_id=a.owner_user_id and s.payload_hash is not distinct from a.payload_hash
            and s.authorization_kind='approval' and s.executed_at is null
            and (s.expires_at is null or s.expires_at>now()) and t.state='awaiting_approval')
        )
    )
    when 'email_thread' then exists (
      select 1 from email_threads t where t.id=a.subject_id
        and t.owner_user_id=a.owner_user_id and t.deleted_at is null
    )
    when 'folder_mapping' then exists (
      select 1 from folder_mappings m where m.id=a.subject_id
        and m.owner_user_id=a.owner_user_id and m.status='active'
    )
    when 'document' then exists (
      select 1 from documents d join folder_mappings m on m.id=d.mapping_id
      where d.id=a.subject_id and d.owner_user_id=a.owner_user_id
        and m.owner_user_id=a.owner_user_id and m.status='active'
    )
    else false end`;

/** Retire only conclusively stale pending rows. Paused mappings and actions
 * being prepared are hidden but not expired: those can become actionable again.
 * A single conditional UPDATE cannot overwrite a concurrent owner decision.
 * Keep the original row, payload and decision fields, plus an audit event. */
async function reconcilePendingApprovals(db: Db, ownerUserId: string): Promise<number> {
  const rows = await db.query<Approval>(`
    update approvals a set status='expired'
    where a.owner_user_id=$1 and a.status='pending' and (
      a.expires_at<=now()
      or (a.subject_type='task' and (
        not exists (select 1 from tasks t where t.id=a.subject_id)
        or exists (select 1 from tasks t where t.id=a.subject_id
          and t.state in ('confirmed','failed','cancelled','closed'))
        or exists (select 1 from assistant_action_states s where s.task_id=a.subject_id
          and (s.status in ('approved','executing','succeeded','failed','denied','expired','superseded')
            or (s.status='prepared' and (s.expires_at<=now() or s.approval_id<>a.id))))
      ))
      or (a.subject_type='email_thread' and not exists (select 1 from email_threads t where t.id=a.subject_id))
      or (a.subject_type='folder_mapping' and not exists (select 1 from folder_mappings m where m.id=a.subject_id))
      or (a.subject_type='document' and not exists (select 1 from documents d where d.id=a.subject_id))
    ) returning a.*`, [ownerUserId]);
  for (const row of rows) await appendEvent(db, {
    actor: 'system', actorUserId: ownerUserId, kind: 'approval.reconciled',
    subjectType: row.subject_type, subjectId: row.subject_id,
    payload: { approvalId: row.id, reason: 'no_longer_actionable' },
  });
  return rows.length;
}

export async function pendingApprovalSnapshot(db: Db, ownerUserId: string): Promise<{
  approvals: Approval[]; count: number; refreshAfterMs: number;
}> {
  // Reconciliation and its audit evidence commit together. The read remains
  // independently correct even before reconciliation or worker expiry runs.
  if (!db.transaction) throw new Error('approval reconciliation requires transaction support');
  return db.transaction(async tx => {
    await reconcilePendingApprovals(tx, ownerUserId);
    const rows = await tx.query<Approval & { total: string }>(`
      select a.*, count(*) over ()::text as total from approvals a
      where a.owner_user_id=$1 and (${ACTIONABLE_PENDING_APPROVAL_SQL})
      order by a.created_at desc, a.id desc limit 100`, [ownerUserId]);
    return {
      approvals: rows.map(({ total: _total, ...approval }) => approval),
      count: Number(rows[0]?.total ?? 0), refreshAfterMs: 2000,
    };
  });
}

export async function listPendingApprovals(db: Db, ownerUserId: string): Promise<Approval[]> {
  return (await pendingApprovalSnapshot(db, ownerUserId)).approvals;
}

/** Expire approvals nobody answered. Run by the worker. */
export async function expireApprovals(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update approvals set status = 'expired'
     where status = 'pending' and expires_at is not null and expires_at < now()
     returning id`,
  );
  return rows.length;
}
