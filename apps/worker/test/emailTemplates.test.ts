import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser } from '../../../packages/auth/src/users.js';
import { createThread, decideActionApproval, getTask, MasterKey, seal } from '@josi-ce/core';
import { setCapability, upsertConnection } from '@josi-ce/connectors';
import { saveEmailTemplate, deleteEmailTemplate } from '@josi-ce/mail';
import { executeAssistantTool } from '../../../packages/agent/src/execute.js';
import { runJob } from '../src/jobs.js';

let db:TestDb, owner:string, thread:string;
const key=new MasterKey(Buffer.alloc(32,9));
const template={name:'Invitation',subject:'For {{name}}',heading:'Invitation',body:'Meet {{recipient}} on {{date}} at {{time}}.',accentColor:'#2563eb',ctaLabel:'Details',ctaUrl:'https://example.test',footer:'Thanks'};
beforeEach(async()=>{db=await testDb();owner=(await createUser(db,{email:'worker@template.test',username:'worker',role:'super_admin'})).id;thread=(await createThread(db,{ownerUserId:owner})).id;});
async function connect(provider:'google'|'microsoft') {
  const capability=`${provider}.mail.send`;
  await db.query(`insert into oauth_clients(provider,client_id,client_secret_enc,redirect_uri,configured_by) values($1,'client',$2,'https://example.test/callback',$3)`,[provider,seal(key,{clientSecret:'test'}),owner]);
  const connection=await upsertConnection(db,key,{ownerUserId:owner,provider,providerAccountId:'test',accountEmail:'worker@template.test',tokens:{accessToken:'token',refreshToken:'refresh',expiresIn:3600,grantedScopes:provider==='google'?'https://www.googleapis.com/auth/gmail.send':'Mail.Send'},requestedCapabilities:[capability]});
  await setCapability(db,{connection,capability,enabled:true,actorUserId:owner});
}
async function draft() {
  const saved=await saveEmailTemplate(db,owner,template);
  const result=await executeAssistantTool(db,{userId:owner,threadId:thread},'draft_email',{recipient:'alex@example.test',template_id:saved.id,merge_values:{name:'Alex',date:'September 18',time:'10 AM PDT'}}) as any;
  expect(result.state,JSON.stringify(result)).toBe('prepared');
  expect(result.summary).toContain('Subject: For Alex');
  expect(result.summary).toContain('Details: https://example.test');
  return {saved,result};
}
async function wake(id:string,calls:RequestInit[]) {
  await runJob(db,{kind:'task.wake',payload:{taskId:id}} as any,{masterKey:key,connectorFetch:async(_url,init)=>{calls.push(init!);return new Response('{}',{status:200});}});
}
describe('approved template email delivery',()=>{
  it.each(['google','microsoft'] as const)('sends exact frozen alternatives through %s after template deletion',async provider=>{
    await connect(provider);
    const {saved,result}=await draft();const task=await getTask(db,result.task_id);const frozen=task.slots.rendered_email as any;
    await decideActionApproval(db,{approvalId:result.approval_id,decidedBy:owner,approve:true});
    await saveEmailTemplate(db,owner,{...template,body:'Changed after approval'},saved.id);await deleteEmailTemplate(db,owner,saved.id);
    const calls:RequestInit[]=[];await wake(task.id,calls);await wake(task.id,calls);
    expect(calls).toHaveLength(1);expect((await getTask(db,task.id)).state).toBe('confirmed');
    const raw=provider==='google'?Buffer.from(JSON.parse(String(calls[0].body)).raw,'base64url').toString():Buffer.from(String(calls[0].body),'base64').toString();
    const parts=[...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/g)].map(m=>Buffer.from(m[1],'base64').toString());
    expect(parts).toEqual([frozen.text,frozen.html]);
    expect(raw).toContain(Buffer.from(frozen.subject).toString('base64'));
  });
  it.each(['body','subject','rendered_email','recipient'])('blocks modified approved %s before any provider request',async field=>{
    await connect('google');const {result}=await draft();
    await decideActionApproval(db,{approvalId:result.approval_id,decidedBy:owner,approve:true});
    await db.query(`update tasks set slots=slots || $2::jsonb where id=$1`,[result.task_id,JSON.stringify({[field]:'tampered'})]);
    const calls:RequestInit[]=[];await wake(result.task_id,calls);expect(calls).toEqual([]);expect((await getTask(db,result.task_id)).state).toBe('failed');
  });
  it('refuses ambiguous names and unowned IDs without creating approvals',async()=>{
    await saveEmailTemplate(db,owner,template);await saveEmailTemplate(db,owner,template);
    const ctx={userId:owner,threadId:thread};
    const ambiguous=await executeAssistantTool(db,ctx,'draft_email',{recipient:'alex@example.test',template_name:'Invitation'}) as any;
    expect(ambiguous).toMatchObject({ok:false});expect(ambiguous.message).toContain('ambiguous');
    const stranger=(await createUser(db,{email:'other@template.test',username:'other',role:'member'})).id;
    const foreign=await saveEmailTemplate(db,stranger,template);
    expect(await executeAssistantTool(db,ctx,'draft_email',{template_id:foreign.id})).toMatchObject({ok:false});
    expect(await db.query('select id from approvals')).toHaveLength(0);
    expect(await executeAssistantTool(db,ctx,'draft_email',{body_html:'<b>raw</b>'})).toMatchObject({ok:false});
  });
  it('preserves plain-text sending without a selected template',async()=>{
    await connect('google');const result=await executeAssistantTool(db,{userId:owner,threadId:thread},'draft_email',{recipient:'alex@example.test',subject:'Plain',body:'Original body'}) as any;
    await decideActionApproval(db,{approvalId:result.approval_id,decidedBy:owner,approve:true});
    const calls:RequestInit[]=[];await wake(result.task_id,calls);
    expect(calls).toHaveLength(1);const raw=Buffer.from(JSON.parse(String(calls[0].body)).raw,'base64url').toString();
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8\r\n\r\nOriginal body');expect(raw).not.toContain('text/html');
  });
});
