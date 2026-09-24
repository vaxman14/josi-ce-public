import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { addMessage, claimDurableTurn, createThread, markActionsPresented, MasterKey, submitDurableTurn } from '@josi-ce/core';
import { setCapability, upsertConnection } from '@josi-ce/connectors';
import { runAssistantTurn } from '../src/assistantAgent.js';
import { buildCore } from '../src/mcp/server.js';
import type { SpawnRunner } from '@josi-ce/llm';

let db:TestDb;let userId:string;let threadId:string;let oldServer:string|undefined;
const privateReceipt='123e4567-e89b-42d3-a456-426614174000';
const key=new MasterKey(Buffer.alloc(32,11));

function contextPath(args:string[]):string{
  const override=args.find(value=>value.includes('JOSI_MCP_CONTEXT'))!;
  return JSON.parse(override.slice(override.indexOf('"'),override.lastIndexOf('"')+1));
}

beforeEach(async()=>{
  db=await testDb();
  userId=(await createUser(db,{email:'subscription-turn@ce.test',username:'subscription-turn',role:'super_admin'})).id;
  threadId=(await createThread(db,{ownerUserId:userId})).id;
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_context_tokens) values('primary','openai_subscription','',true,now(),now(),true,false,true,8000)`);
  const dir=mkdtempSync(join(tmpdir(),'josi-subscription-turn-'));
  const server=join(dir,'server.js');writeFileSync(server,'// test seam');
  oldServer=process.env.JOSI_MCP_SERVER;process.env.JOSI_MCP_SERVER=server;
});
afterEach(()=>{if(oldServer===undefined)delete process.env.JOSI_MCP_SERVER;else process.env.JOSI_MCP_SERVER=oldServer;});

describe('subscription turn receipts',()=>{
  it('propagates the private real-result handoff through grounding and presentation without exposing it',async()=>{
    const runner:SpawnRunner=async({args})=>{
      const ctx=JSON.parse(readFileSync(contextPath(args),'utf8'));
      expect(ctx.tools).toContain('get_provider_status');
      const result={ok:true,providers:[{name:'Google Calendar',state:'connected'}],receipt:privateReceipt,observed_at:'2026-09-18T04:05:00Z'};
      writeFileSync(ctx.callsPath,`${JSON.stringify({id:'status-1',name:'get_provider_status',input:{},result})}\n`,{mode:0o600});
      return {code:0,timedOut:false,stderr:'',stdout:JSON.stringify({type:'agent_message',message:`Google Calendar is connected. Receipt ID: ${privateReceipt}`})};
    };
    const result=await runAssistantTurn({db,userId,threadId,history:[],inbound:'Is my calendar connected?',registry:{db,masterKey:null,codexRunner:runner}});
    expect(result.actions).toEqual([{tool:'get_provider_status',result:expect.objectContaining({ok:true,providers:[{name:'Google Calendar',state:'connected'}]})}]);
    expect(result.reply).toContain('Google Calendar is connected');
    expect(result.reply).not.toContain(privateReceipt);
    expect(result.reply).not.toMatch(/receipt id/i);
  });

  it('carries a real MCP approval result into exact presentation and a following yes',async()=>{
    const connection=await upsertConnection(db,key,{
      ownerUserId:userId,provider:'google',providerAccountId:'subscription-action',accountEmail:'subscription-action@ce.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/gmail.send'},
      requestedCapabilities:['google.mail.send'],
    });
    await setCapability(db,{connection,capability:'google.mail.send',enabled:true,actorUserId:userId});
    const session=await createSession(db,{userId});
    const accepted=await submitDurableTurn(db,{ownerUserId:userId,sessionId:session.sessionId,threadId,clientMessageId:'subscription-durable',message:'Email the exact note'});
    const durable=await claimDurableTurn(db,accepted.turn.id);
    expect(durable).not.toBeNull();
    const runner:SpawnRunner=async({args})=>{
      const ctx=JSON.parse(readFileSync(contextPath(args),'utf8'));
      expect(ctx.tools).toContain('draft_email');
      expect(ctx.durableTurnId).toBe(durable!.id);expect(ctx.durableLeaseToken).toBe(durable!.lease_token);
      const core=buildCore(ctx,async()=>db);
      const outcome=await core.execute('draft_email',{
        recipient:'recipient@example.test',subject:'Subscription approval',body:'Exact body',
      },'draft-1');
      expect(JSON.parse(outcome.text)).toMatchObject({ok:true,state:'prepared',task_id:expect.any(String),approval_id:expect.any(String)});
      return {code:0,timedOut:false,stderr:'',stdout:JSON.stringify({type:'agent_message',message:'I prepared it.'})};
    };
    const prepared=await runAssistantTurn({db,userId,threadId,history:[],inbound:'Email the exact note',inboundMessageId:durable!.inbound_message_id,durableTurnId:durable!.id,durableLeaseToken:durable!.lease_token,registry:{db,masterKey:key,codexRunner:runner}});
    expect(await db.query(`select id from assistant_turn_effects where turn_id=$1 and tool_name='draft_email' and state='completed'`,[durable!.id])).toHaveLength(1);
    expect(prepared.actions).toEqual([{tool:'draft_email',result:expect.objectContaining({ok:true,state:'prepared',task_id:expect.any(String),approval_id:expect.any(String)})}]);
    expect(prepared.reply).toBe('Send email\nTo: recipient@example.test\nSubject: Subscription approval\nBody: Exact body\n\nApprove this exact action? Reply yes or no.');

    const message=await addMessage(db,{threadId,direction:'out',body:prepared.reply});
    const taskId=(prepared.actions[0].result as {task_id:string}).task_id;
    await markActionsPresented(db,{ownerUserId:userId,threadId,taskIds:[taskId],messageId:message.id});
    const approved=await runAssistantTurn({db,userId,threadId,history:[],inbound:'yes',registry:{db,masterKey:key,codexRunner:runner}});
    expect(approved.reply).toMatch(/queued the exact email/i);
    expect(approved.actions).toEqual([{tool:'assistant_action_state',result:expect.objectContaining({task_id:taskId,status:'approved'})}]);
  });
});
