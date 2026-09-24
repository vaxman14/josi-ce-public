import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { MasterKey } from '../../core/src/index.js';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { discoverWorkflows, executeWorkflowRun, previewWorkflowRun, recordWorkflowCallback, requestWorkflowRun, saveWorkflowIntegration, verifyWorkflowCallback, WorkflowError, type WorkflowIntegration } from '../src/index.js';

let db:TestDb; let admin:string; let member:string; const key=new MasterKey(Buffer.alloc(32,19));
const credentialOk=async(url:RequestInfo|URL,init?:RequestInit)=>new Response(String(url).includes('mcp.zapier.com')?JSON.stringify({jsonrpc:'2.0',id:JSON.parse(String(init?.body??'{}')).id,result:{tools:[],protocolVersion:'2025-03-26'}}):JSON.stringify({data:[],scenarios:[]}),{status:200,headers:{'content-type':'application/json'}});
beforeEach(async()=>{db=await testDb();admin=(await createUser(db,{email:'flow-admin@test.invalid',username:'flowadmin',role:'super_admin'})).id;member=(await createUser(db,{email:'flow-member@test.invalid',username:'flowmember',role:'member'})).id;});

describe('native workflow providers',()=>{
  it('does not let a Custom API host masquerade as Zapier or Make',async()=>{
    await expect(saveWorkflowIntegration(db,key,{provider:'zapier',name:'fake',baseUrl:'https://api.example.test',token:'x',actorUserId:admin,fetchImpl:credentialOk})).rejects.toThrow(/zapier\.com/i);
    await expect(saveWorkflowIntegration(db,key,{provider:'make',name:'fake',baseUrl:'https://api.example.test',token:'x',actorUserId:admin,fetchImpl:credentialOk})).rejects.toThrow(/make\.com/i);
  });
  it.each([['zapier',{results:[{id:'zap-1',name:'Send lead'}]}],['n8n',{data:[{id:'n8n-1',name:'Triage inbox',execution_ref:'triage'}]}],['make',{scenarios:[{id:'make-1',name:'Create invoice'}]}]] as const)('discovers %s workflows through its native protocol',async(provider,body)=>{
    const integration=await saveWorkflowIntegration(db,key,{provider,name:`${provider} main`,baseUrl:provider==='n8n'?'https://n8n.example.test':undefined,token:'provider-token',workspaceId:provider==='make'?'42':undefined,actorUserId:admin,fetchImpl:credentialOk});
    const providerBody=provider==='zapier'?{jsonrpc:'2.0',id:'x',result:{tools:[{name:'zap-1',description:'Send lead'}]}}:body;
    const fetchImpl=vi.fn(async(_url:any,init:any)=>new Response(JSON.stringify(String(_url).endsWith('/interface')?{interface:{input:[]}}:provider==='zapier'?{...providerBody,id:JSON.parse(init.body).id,result:{...providerBody.result,protocolVersion:'2025-03-26'}}:providerBody),{status:200,headers:{'content-type':'application/json'}}));
    const workflows=await discoverWorkflows(db,key,integration,fetchImpl as typeof fetch);
    expect(workflows).toHaveLength(1);expect(workflows[0].name).toBe(provider==='zapier'?'zap-1':(Object.values(body)[0] as any)[0].name);
    expect(String(fetchImpl.mock.calls[0][0])).toContain(provider==='zapier'?'/api/v1/connect':provider==='n8n'?'/api/v1/workflows':'/api/v2/scenarios');
  });
  it('pins approval to an owner and executes once',async()=>{
    const integration=await saveWorkflowIntegration(db,key,{provider:'n8n',name:'office',baseUrl:'https://n8n.example.test',token:'secret',actorUserId:admin,fetchImpl:credentialOk});
    const [workflow]=await discoverWorkflows(db,key,integration,async()=>new Response(JSON.stringify({data:[{id:'w1',name:'File report',execution_ref:'file-report'}]}),{status:200}) as any);await db.query(`update workflow_definitions set execution_ref='/webhook/file-report' where integration_id=$1 and external_id='w1'`,[integration.id]);workflow.execution_ref='/webhook/file-report';
    await db.query(`update workflow_integrations set enabled=true where id=$1`,[integration.id]);await db.query(`update workflow_definitions set exposed=true where integration_id=$1`,[integration.id]);const run=await requestWorkflowRun(db,key,{integration,workflow,ownerUserId:member,input:{case:'123'}});
    const stranger=(await createUser(db,{email:'stranger@test.invalid',username:'stranger',role:'member'})).id;
    await expect(executeWorkflowRun(db,key,{runId:run.id,ownerUserId:stranger,approve:true,fetchImpl:vi.fn() as any})).rejects.toMatchObject({status:404});
    const send=vi.fn(async()=>new Response(JSON.stringify({executionId:'exec-7'}),{status:200}));
    await expect(executeWorkflowRun(db,key,{runId:run.id,ownerUserId:member,approve:true,fetchImpl:send as any})).resolves.toMatchObject({status:'running',externalRunId:'exec-7'});
    await expect(executeWorkflowRun(db,key,{runId:run.id,ownerUserId:member,approve:true,fetchImpl:send as any})).rejects.toBeInstanceOf(WorkflowError);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('authenticates callbacks and rejects unknown runs',async()=>{
    const saved=await saveWorkflowIntegration(db,key,{provider:'make',name:'ops',token:'token',workspaceId:'42',actorUserId:admin,fetchImpl:credentialOk});const raw=JSON.stringify({runId:'run-1'});const timestamp=String(Math.floor(Date.now()/1000));const sig=createHmac('sha256',saved.callbackSecret).update(`${timestamp}.${raw}`).digest('hex');
    expect(await verifyWorkflowCallback(db,key,saved as WorkflowIntegration,raw,`sha256=${sig}`,timestamp)).toBe(true);expect(await verifyWorkflowCallback(db,key,saved as WorkflowIntegration,raw,'sha256='+'0'.repeat(64),timestamp)).toBe(false);
    await expect(recordWorkflowCallback(db,{integrationId:saved.id,externalRunId:'missing',status:'succeeded'})).rejects.toMatchObject({status:404});
  });
  it('requires deliberate LAN access and validates structured input before preview or approval',async()=>{
    await expect(saveWorkflowIntegration(db,key,{provider:'n8n',name:'lan',baseUrl:'https://192.168.1.20',token:'x',actorUserId:admin,fetchImpl:credentialOk})).rejects.toThrow(/deliberate LAN/i);
    await expect(saveWorkflowIntegration(db,key,{provider:'n8n',name:'lan',baseUrl:'https://192.168.1.20',token:'x',actorUserId:admin,allowPrivateNetwork:true,fetchImpl:credentialOk})).resolves.toBeTruthy();
    const workflow:any={external_id:'w',name:'Typed',input_schema:{type:'object',required:['email'],properties:{email:{type:'string'}},additionalProperties:false}};
    expect(()=>previewWorkflowRun(workflow,{email:'a@example.test'})).not.toThrow();
    expect(()=>previewWorkflowRun(workflow,{email:42,extra:true})).toThrow(/invalid/i);
  });
  it('uses official provider authentication and execution contracts',async()=>{
    const makeCalls:any[]=[];const makeFetch=async(url:any,init:any={})=>{makeCalls.push([String(url),init]);return new Response(String(url).endsWith('/interface')?JSON.stringify({interface:{input:[{name:'invoice',type:'text',required:true}]}}):String(url).includes('/run')?JSON.stringify({executionId:'mk-1',status:'success'}):JSON.stringify({scenarios:[{id:7,name:'Invoice'}]}),{status:200});};
    const make=await saveWorkflowIntegration(db,key,{provider:'make',name:'official',token:'t',workspaceId:'42',workspaceType:'team',actorUserId:admin,fetchImpl:makeFetch as any});
    const [flow]=await discoverWorkflows(db,key,make,makeFetch as any);await db.query(`update workflow_integrations set enabled=true where id=$1`,[make.id]);await db.query(`update workflow_definitions set exposed=true where integration_id=$1`,[make.id]);const run=await requestWorkflowRun(db,key,{integration:make,workflow:flow,ownerUserId:member,input:{invoice:'1'}});await executeWorkflowRun(db,key,{runId:run.id,ownerUserId:member,approve:true,fetchImpl:makeFetch as any});
    expect(makeCalls[0][0]).toContain('teamId=42');expect(makeCalls[0][1].headers.Authorization).toBe('Token t');expect(JSON.parse(makeCalls.at(-1)[1].body)).toEqual({data:{invoice:'1'},responsive:true});
    const zapCalls:any[]=[];const zapFetch=async(url:any,init:any)=>{zapCalls.push([String(url),init]);const req=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:req.method==='initialize'?{protocolVersion:'2025-03-26'}:req.method==='tools/list'?{tools:[{name:'send_email',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'done'}]}}),{status:200});};
    const zap=await saveWorkflowIntegration(db,key,{provider:'zapier',name:'mcp',token:'z',actorUserId:admin,fetchImpl:zapFetch as any});const [tool]=await discoverWorkflows(db,key,zap,zapFetch as any);await db.query(`update workflow_integrations set enabled=true where id=$1`,[zap.id]);await db.query(`update workflow_definitions set exposed=true where integration_id=$1`,[zap.id]);const zapRun=await requestWorkflowRun(db,key,{integration:zap,workflow:tool,ownerUserId:member,input:{}});await executeWorkflowRun(db,key,{runId:zapRun.id,ownerUserId:member,approve:true,fetchImpl:zapFetch as any});expect(JSON.parse(zapCalls.at(-1)[1].body).method).toBe('tools/call');expect(zapCalls.at(-1)[1].headers.Authorization).toBe('Bearer z');
  });
});

import {initializeVault,openSealed} from '../../core/src/index.js';
import {disconnectWorkflowIntegration,validateWorkflowInput,registerN8nWebhook} from '../src/workflows.js';
it('stores provider and callback credentials in the Vault and revokes both slots immediately',async()=>{
 await initializeVault(db,key,admin);
 const integration=await saveWorkflowIntegration(db,key,{provider:'n8n',name:'vault-backed',baseUrl:'https://n8n.example.test',token:'credential-fixture',actorUserId:admin,fetchImpl:credentialOk});
 expect(openSealed<any>(key,integration.credentials_enc).vaultItemId).toBeTruthy();
 expect(openSealed<any>(key,integration.callback_secret_enc).vaultItemId).toBeTruthy();
 expect((await db.query(`select id from vault_items where service='workflow.n8n'`))).toHaveLength(2);
 await disconnectWorkflowIntegration(db,integration.id);
 expect((await db.query(`select id from vault_items where service='workflow.n8n'`))).toHaveLength(0);
 const [row]=await db.query<any>(`select * from workflow_integrations where id=$1`,[integration.id]);expect(row.enabled).toBe(false);expect(row.credentials_enc).toBe('');
});
it('rejects stale, missing, modified-timestamp and malformed callback signatures',async()=>{
 const integration=await saveWorkflowIntegration(db,key,{provider:'make',name:'signature',token:'fixture',workspaceId:'42',actorUserId:admin,fetchImpl:credentialOk});
 const raw='{}',timestamp=String(Math.floor(Date.now()/1000));const sig=createHmac('sha256',integration.callbackSecret).update(`${timestamp}.${raw}`).digest('hex');
 expect(await verifyWorkflowCallback(db,key,integration,raw,sig,timestamp)).toBe(true);
 expect(await verifyWorkflowCallback(db,key,integration,raw,sig)).toBe(false);
 expect(await verifyWorkflowCallback(db,key,integration,raw,sig,String(Number(timestamp)-400))).toBe(false);
 expect(await verifyWorkflowCallback(db,key,integration,raw,sig,String(Number(timestamp)+1))).toBe(false);
 expect(await verifyWorkflowCallback(db,key,integration,raw,'é'.repeat(64),timestamp)).toBe(false);
});
it('validates schema constraints rather than only primitive input types',()=>{
 const schema={type:'object',required:['count','name'],properties:{count:{type:'integer',minimum:1,maximum:5},name:{type:'string',minLength:2,maxLength:5}},additionalProperties:false};
 expect(()=>validateWorkflowInput(schema,{count:3,name:'okay'})).not.toThrow();
 for(const input of [{count:0,name:'okay'},{count:2,name:'x'},{count:4,name:'okay',extra:true}])expect(()=>validateWorkflowInput(schema,input)).toThrow();
});
it('keeps registered n8n webhook and schema on rediscovery and withdraws exposure on reconnect',async()=>{
 const options={provider:'n8n' as const,name:'reconnect',baseUrl:'https://n8n.example.test',token:'fixture',actorUserId:admin,fetchImpl:credentialOk};
 const integration=await saveWorkflowIntegration(db,key,options);
 const discover=async()=>new Response(JSON.stringify({data:[{id:'flow',name:'Workflow'}]}));
 await discoverWorkflows(db,key,integration,discover as any);
 const schema={type:'object',required:['name'],properties:{name:{type:'string'}}};
 await registerN8nWebhook(db,integration.id,'flow','/webhook/real',schema);
 await db.query(`update workflow_definitions set exposed=true where integration_id=$1`,[integration.id]);
 const [flow]=await discoverWorkflows(db,key,integration,discover as any);expect(flow.execution_ref).toBe('/webhook/real');expect(flow.input_schema).toEqual(schema);
 await saveWorkflowIntegration(db,key,{...options,token:'replacement'});
 expect((await db.query<any>(`select exposed from workflow_definitions where integration_id=$1`,[integration.id]))[0].exposed).toBe(false);
});
