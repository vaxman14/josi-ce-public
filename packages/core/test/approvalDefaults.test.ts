import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  ACTION_CLASSES, ApprovalError, DEFAULT_ADMIN_CEILING,
  actionClassSpec, effectiveApprovalLevel, getApprovalLevel,
  isHighImpactClass, isRiskyAction, needsApproval,
  setAdminApprovalCeiling, setUserApprovalLevel,
  type ApprovalLevel,
} from '../src/index.js';

let db: TestDb;
let admin: string;
let member: string;

beforeEach(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin' })).id;
  member = (await createUser(db, { email: 'm@ce.test', username: 'member', role: 'member' })).id;
});

describe('explicit user approval preference', () => {
  it('does not treat "no policy" as "no ceiling"', async () => {
    expect(DEFAULT_ADMIN_CEILING).toBeNull();
    expect(effectiveApprovalLevel(null, null)).toBe('always_ask');
    const level = await getApprovalLevel(db, { userId: member, actionClass: 'calendar_write' });
    expect(level).toMatchObject({ level: 'always_ask', userChoice: 'always_ask', adminCeiling: null, managedPolicy: false });
    expect(await needsApproval(db, { userId: member, actionClass: 'calendar_write', action: 'create' })).toBe(true);
  });

  it('makes an explicit automatic preference effective when no managed policy exists', async () => {
    await setUserApprovalLevel(db, { userId: member, actionClass: 'calendar_write', level: 'automatic' });
    expect(await getApprovalLevel(db, { userId: member, actionClass: 'calendar_write' }))
      .toMatchObject({ level: 'automatic', userChoice: 'automatic', adminCeiling: null, managedPolicy: false });
    expect(await needsApproval(db, { userId: member, actionClass: 'calendar_write', action: 'create' })).toBe(false);
  });

  it('asks only for risky work when the user selects risky-only',async()=>{
    await setUserApprovalLevel(db,{userId:member,actionClass:'calendar_write',level:'risky_only'});
    expect(await needsApproval(db,{userId:member,actionClass:'calendar_write',action:'create'})).toBe(false);
    expect(await needsApproval(db,{userId:member,actionClass:'calendar_write',action:'invite_external'})).toBe(true);
  });

  it('does not retain migration-seeded built-in ceilings as managed policy', async () => {
    expect((await db.query(`select action_class,max_level from admin_approval_policy`)).length).toBeGreaterThan(0);
    expect(await db.query(`select 1 from admin_approval_policy where managed_explicitly is true`)).toEqual([]);
    expect(await getApprovalLevel(db,{userId:member,actionClass:'calendar_write'}))
      .toMatchObject({adminCeiling:null,managedPolicy:false});
    expect(await db.query(`select 1 from approval_policy_migration where acknowledged_at is null`)).toEqual([]);
  });
});

describe('explicit managed policy', () => {
  it('is opt-in, audited, and can tighten an existing user choice', async () => {
    await setUserApprovalLevel(db, { userId: member, actionClass: 'calendar_write', level: 'automatic' });
    await setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'calendar_write', maxLevel: 'always_ask' });
    expect(await getApprovalLevel(db, { userId: member, actionClass: 'calendar_write' }))
      .toMatchObject({ level: 'always_ask', userChoice: 'automatic', adminCeiling: 'always_ask', managedPolicy: true });
    const [event] = await db.query<{actor_user_id:string;payload:Record<string,string>}>(`select actor_user_id,payload from events where kind='approval.ceiling_set'`);
    expect(event.actor_user_id).toBe(admin);
    expect(event.payload).toMatchObject({ actionClass: 'calendar_write', maxLevel: 'always_ask' });
    expect((await db.query<{managed_explicitly:boolean}>(`select managed_explicitly from admin_approval_policy where action_class='calendar_write'`))[0].managed_explicitly).toBe(true);
  });

  it('refuses to save a choice the effective managed policy would ignore', async () => {
    await setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'calendar_write', maxLevel: 'risky_only' });
    await expect(setUserApprovalLevel(db, { userId: member, actionClass: 'calendar_write', level: 'automatic' }))
      .rejects.toBeInstanceOf(ApprovalError);
    expect(await db.query(`select 1 from user_approval_prefs where user_id=$1 and action_class='calendar_write'`,[member])).toEqual([]);
  });

  it('removes rather than disguises a managed policy when control returns to users', async () => {
    await setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'calendar_write', maxLevel: 'always_ask' });
    await setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'calendar_write', maxLevel: 'automatic', confirmRelaxation: true });
    expect(await db.query(`select 1 from admin_approval_policy where action_class='calendar_write'`)).toEqual([]);
    const [event] = await db.query<{actor_user_id:string}>(`select actor_user_id from events where kind='approval.ceiling_removed'`);
    expect(event.actor_user_id).toBe(admin);
  });

  it('refuses a relaxation that was not confirmed', async () => {
    await setAdminApprovalCeiling(db,{actorUserId:admin,actionClass:'calendar_write',maxLevel:'always_ask'});
    await expect(setAdminApprovalCeiling(db,{actorUserId:admin,actionClass:'calendar_write',maxLevel:'risky_only'}))
      .rejects.toBeInstanceOf(ApprovalError);
  });

  it('always uses the stricter explicit choice', () => {
    const levels: ApprovalLevel[] = ['always_ask', 'risky_only', 'automatic'];
    const rank = { always_ask: 0, risky_only: 1, automatic: 2 };
    for (const user of levels) for (const ceiling of levels) {
      expect(rank[effectiveApprovalLevel(user, ceiling)]).toBe(Math.min(rank[user], rank[ceiling]));
    }
  });
});

describe('fail-closed policy boundaries and migration',()=>{
  it('fails closed for unknown classes and malformed runtime levels',async()=>{
    await db.query(`insert into user_approval_prefs(user_id,action_class,level) values($1,'future_unreviewed_class','automatic')`,[member]);
    expect(await needsApproval(db,{userId:member,actionClass:'future_unreviewed_class',action:'new_action'})).toBe(true);
    await expect(setUserApprovalLevel(db,{userId:member,actionClass:'another_unknown',level:'automatic'})).rejects.toBeInstanceOf(ApprovalError);
    expect(effectiveApprovalLevel('broken' as ApprovalLevel,null)).toBe('always_ask');
    expect(effectiveApprovalLevel('automatic','broken' as ApprovalLevel)).toBe('always_ask');
  });

  it('can re-run migration 0060 without changing explicit policy or action authorization',async()=>{
    await setAdminApprovalCeiling(db,{actorUserId:admin,actionClass:'calendar_write',maxLevel:'risky_only'});
    const sql=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../../db/migrations/0060_explicit_managed_approval_policy.sql'),'utf8');
    await db.exec(sql);
    await db.exec(sql);
    expect(await getApprovalLevel(db,{userId:member,actionClass:'calendar_write'}))
      .toMatchObject({adminCeiling:'risky_only',managedPolicy:true});
    expect(await db.query(`select column_name from information_schema.columns
      where table_name='assistant_action_states' and column_name='authorization_kind'`)).toHaveLength(1);
  });
});

describe('irreducible high-impact protections', () => {
  it('keeps every high-impact class and named risky action gated', async () => {
    const high = ['delete_data','cancel_commitment','invite_external','publish_public','spend_money','sign_agreement','change_access'];
    for (const key of high) {
      expect(actionClassSpec(key)).toBeTruthy();
      expect(isHighImpactClass(key)).toBe(true);
      await setUserApprovalLevel(db, { userId: member, actionClass: key, level: 'automatic' });
      expect(await needsApproval(db, { userId: member, actionClass: key, action: 'new_verb' })).toBe(true);
    }
    for (const action of ['add_recipient','send_attachment','delete_data','spend_money','cancel_commitment','invite_external','publish_public','sign_agreement','change_access']) {
      expect(isRiskyAction(action), action).toBe(true);
    }
    expect(ACTION_CLASSES.length).toBeGreaterThan(high.length);
  });
});
