import { beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import { ACTIONABLE_PENDING_APPROVAL_SQL, decideApproval, pendingApprovalSnapshot, requestApproval } from '../src/approvals.js';
import type { Db } from '../src/db.js';

let db: Db;
beforeAll(async () => { db = await testDb(); });
let sequence = 0;
async function fixture() {
  const n = ++sequence;
  const owner = (await createUser(db, { email: `pending${n}@example.test`, username: `pending${n}`, role: 'member' })).id;
  const [thread] = await db.query<{id:string}>(`insert into threads(owner_user_id) values($1) returning id`, [owner]);
  async function pending(action = false) {
    const [task] = await db.query<{id:string}>(`insert into tasks(owner_user_id,template_key,state) values($1,'follow_up','awaiting_approval') returning id`, [owner]);
    const approval = await requestApproval(db, { taskId: task.id, ownerUserId: owner, actionClass: 'email_send', action: 'send', summary: 'Same visible summary', payload: {} });
    if (action) await db.query(`insert into assistant_action_states(owner_user_id,thread_id,domain,operation,status,task_id,approval_id,payload_hash)
      values($1,$2,'email','send','prepared',$3,$4,$5)`, [owner, thread.id, task.id, approval.id, approval.payload_hash]);
    return { task, approval };
  }
  return { owner, pending };
}
async function rawIds(owner: string) {
  return (await db.query<{id:string}>(`select a.id from approvals a where a.owner_user_id=$1 and (${ACTIONABLE_PENDING_APPROVAL_SQL})`, [owner])).map(r => r.id);
}

describe('canonical actionable pending approvals', () => {
  it.each(['approved','denied','expired'])('excludes approval status %s without rewriting history', async status => {
    const {owner,pending} = await fixture(); const {approval} = await pending();
    await db.query(`update approvals set status=$2 where id=$1`, [approval.id,status]);
    expect(await rawIds(owner)).toEqual([]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe(status);
  });
  it.each(['ready','attempting','held','awaiting_owner','confirmed','failed','cancelled','closed'])('excludes non-actionable task %s', async state => {
    const {owner,pending} = await fixture(); const {task} = await pending();
    await db.query(`update tasks set state=$2 where id=$1`,[task.id,state]);
    expect(await rawIds(owner)).toEqual([]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
  });
  it.each(['collecting','approved','executing','succeeded','failed','denied','expired','superseded'])('excludes action status %s', async status => {
    const {owner,pending} = await fixture(); const {approval} = await pending(true);
    await db.query(`update assistant_action_states set status=$2 where approval_id=$1`,[approval.id,status]);
    expect(await rawIds(owner)).toEqual([]);
    expect((await pendingApprovalSnapshot(db,owner)).approvals).toEqual([]);
  });
  it.each(['approval_expiry','action_expiry','wrong_pin','wrong_payload','executed','user_policy','missing_target','wrong_owner'])('excludes and safely reconciles %s', async reason => {
    const {owner,pending} = await fixture(); const {approval,task} = await pending(true);
    if (reason==='approval_expiry') await db.query(`update approvals set expires_at=now() where id=$1`,[approval.id]);
    if (reason==='action_expiry') await db.query(`update assistant_action_states set expires_at=now() where approval_id=$1`,[approval.id]);
    if (reason==='wrong_pin') await db.query(`update assistant_action_states set approval_id=null where approval_id=$1`,[approval.id]);
    if (reason==='wrong_payload') await db.query(`update assistant_action_states set payload_hash='changed' where approval_id=$1`,[approval.id]);
    if (reason==='executed') await db.query(`update assistant_action_states set executed_at=now() where approval_id=$1`,[approval.id]);
    if (reason==='user_policy') await db.query(`update assistant_action_states set authorization_kind='user_policy' where approval_id=$1`,[approval.id]);
    if (reason==='missing_target') await db.query(`delete from tasks where id=$1`,[task.id]);
    if (reason==='wrong_owner') { const other=await fixture(); await db.query(`update tasks set owner_user_id=$2 where id=$1`,[task.id,other.owner]); }
    expect(await rawIds(owner)).toEqual([]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
    expect(await db.query(`select id from approvals where id=$1`,[approval.id])).toHaveLength(1);
    await expect(decideApproval(db,{approvalId:approval.id,decidedBy:owner,approve:true})).rejects.toThrow();
  });
  it('preserves valid old, legacy and prepared approvals and decides only the exact ID', async () => {
    const {owner,pending} = await fixture();
    const first=await pending(true); const second=await pending(true); const legacy=await pending();
    await db.query(`update approvals set created_at=now()-interval '1 year' where id=$1`,[first.approval.id]);
    await db.query(`update tasks set state='drafting' where id=$1`,[legacy.task.id]);
    const snapshot=await pendingApprovalSnapshot(db,owner);
    expect(snapshot.count).toBe(3);
    expect(snapshot.approvals.map(a=>a.id).sort()).toEqual([first.approval.id,second.approval.id,legacy.approval.id].sort());
    await decideApproval(db,{approvalId:second.approval.id,decidedBy:owner,approve:false});
    await decideApproval(db,{approvalId:first.approval.id,decidedBy:owner,approve:true});
    expect((await pendingApprovalSnapshot(db,owner)).approvals.map(a=>a.id)).toEqual([legacy.approval.id]);
    expect(await db.query(`select id from events where kind='approval.reconciled' and actor_user_id=$1`,[owner])).toHaveLength(0);
  });
  it('reconciles once, preserves audit history and does not rewrite an owner decision', async () => {
    const {owner,pending}=await fixture(); const {approval}=await pending();
    await db.query(`update approvals set expires_at=now() where id=$1`,[approval.id]);
    await pendingApprovalSnapshot(db,owner); await pendingApprovalSnapshot(db,owner);
    expect(await db.query(`select id from events where kind='approval.reconciled' and payload->>'approvalId'=$1`,[approval.id])).toHaveLength(1);
    expect(await db.query(`select id from events where kind='approval.requested' and payload->>'approvalId'=$1`,[approval.id])).toHaveLength(1);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe('expired');
  });
  it.each(['email_thread','folder_mapping','document'] as const)('preserves valid %s targets and excludes unavailable, foreign and missing targets', async subject => {
    const {owner}=await fixture();
    const [root]=await db.query<{id:string}>(`insert into storage_roots(container_path,label) values($1,'Test') returning id`,[`/test/pending-${owner}`]);
    const [mapping]=await db.query<{id:string}>(`insert into folder_mappings(owner_user_id,provider,root_id,display_path)
      values($1,'local',$2,'Test') returning id`,[owner,root.id]);
    let target=mapping.id;
    if(subject==='document') target=(await db.query<{id:string}>(`insert into documents(mapping_id,owner_user_id,relative_path,filename)
      values($1,$2,'test.txt','test.txt') returning id`,[mapping.id,owner]))[0].id;
    if(subject==='email_thread') target=(await db.query<{id:string}>(`insert into email_threads(owner_user_id,subject,routing_token)
      values($1,'Test',$2) returning id`,[owner,owner]))[0].id;
    const approval=await requestApproval(db,{ownerUserId:owner,actionClass:'change_access',action:'test',summary:'Test',payload:{},
      ...(subject==='document'?{documentId:target}:subject==='email_thread'?{threadId:target}:{mappingId:target})});
    expect((await pendingApprovalSnapshot(db,owner)).approvals.map(a=>a.id)).toEqual([approval.id]);
    if(subject==='email_thread') await db.query(`update email_threads set deleted_at=now() where id=$1`,[target]);
    else await db.query(`update folder_mappings set status='paused' where id=$1`,[mapping.id]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe('pending');
    if(subject==='email_thread') await db.query(`update email_threads set deleted_at=null where id=$1`,[target]);
    else await db.query(`update folder_mappings set status='active' where id=$1`,[mapping.id]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(1);
    const other=await fixture();
    // Table names come only from this fixed test matrix.
    const table=subject==='document'?'documents':subject==='email_thread'?'email_threads':'folder_mappings';
    await db.query(`update ${table} set owner_user_id=$2 where id=$1`,[target,other.owner]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
    await db.query(`delete from ${table} where id=$1`,[target]);
    expect(await rawIds(owner)).toEqual([]);
    expect((await pendingApprovalSnapshot(db,owner)).count).toBe(0);
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe('expired');
  });
  it('rolls reconciliation back if audit recording fails', async () => {
    const {owner,pending}=await fixture(); const {approval}=await pending();
    await db.query(`update approvals set expires_at=now() where id=$1`,[approval.id]);
    const failing:Db={query:db.query,transaction:work=>db.transaction!(tx=>work({
      query:async<T>(sql:string,params?:unknown[])=>{
        if (/insert into events/i.test(sql)) throw new Error('audit unavailable');
        return tx.query<T>(sql,params);
      },
    }))};
    await expect(pendingApprovalSnapshot(failing,owner)).rejects.toThrow('audit unavailable');
    expect((await db.query<{status:string}>(`select status from approvals where id=$1`,[approval.id]))[0].status).toBe('pending');
  });
  it('counts the full eligible set before applying the list limit', async () => {
    const {owner}=await fixture();
    await db.query(`with targets as (insert into tasks(owner_user_id,template_key,state)
      select $1,'follow_up','awaiting_approval' from generate_series(1,101) returning id)
      insert into approvals(subject_type,subject_id,owner_user_id,action_class,action,summary,payload_hash)
      select 'task',id,$1,'email_send','send','Review','h' from targets`,[owner]);
    const snapshot=await pendingApprovalSnapshot(db,owner);
    expect(snapshot.count).toBe(101); expect(snapshot.approvals).toHaveLength(100);
  });
});
