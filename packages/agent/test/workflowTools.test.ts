import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, TOOL_SPECS_BY_NAME } from '../src/tools.js';

describe('native workflow assistant tools', () => {
  it('registers every offered workflow tool in the execution policy catalogue', () => {
    expect(ALL_TOOLS.map((tool) => tool.def.name)).toContain('list_native_workflows');
    expect(ALL_TOOLS.map((tool) => tool.def.name)).toContain('run_native_workflow');
    expect(TOOL_SPECS_BY_NAME.get('list_native_workflows')?.actionClass).toBeNull();
    expect(TOOL_SPECS_BY_NAME.get('run_native_workflow')?.actionClass).toBe('external_write');
  });
});

import {MasterKey} from '@josi-ce/core';
import {testDb} from '../../core/test/helpers.js';
import {createUser} from '../../auth/src/users.js';
import {executeWorkflowTool,workflowToolAvailability} from '../src/workflowTools.js';
it('enforces assistant exposure and revocation and only prepares an owner approval',async()=>{
 const db=await testDb(),key=new MasterKey(Buffer.alloc(32,29));
 const owner=await createUser(db,{email:'workflow-owner@example.test',username:'workflowowner',role:'member'});
 const [integration]=await db.query<{id:string}>(`insert into workflow_integrations(provider,name,base_url,credentials_enc,callback_secret_enc,created_by,enabled,status) values('n8n','Office','https://n8n.example.test','synthetic-sealed-placeholder','synthetic-callback-placeholder',$1,true,'active') returning id`,[owner.id]);
 await db.query(`insert into workflow_definitions(integration_id,external_id,name,input_schema,execution_ref,active,exposed) values($1,'report','Report','{"type":"object","properties":{"lead":{"type":"string"}},"required":["lead"]}','/webhook/report',true,false)`,[integration.id]);
 const ctx={userId:owner.id,threadId:null,masterKey:()=>key};
 const input={integration_id:integration.id,workflow_id:'report',input:{lead:'Reviewed input'}};
 expect(await workflowToolAvailability(db)).toEqual([]);
 expect(await executeWorkflowTool(db,ctx,'run_native_workflow',input)).toMatchObject({ok:false});
 expect(await db.query('select id from workflow_runs')).toHaveLength(0);
 await db.query(`update workflow_definitions set exposed=true where integration_id=$1`,[integration.id]);
 expect(await workflowToolAvailability(db)).toHaveLength(2);
 expect(await executeWorkflowTool(db,ctx,'run_native_workflow',input)).toMatchObject({ok:true,status:'pending'});
 const runs=await db.query<{status:string;owner_user_id:string;external_run_id:string|null}>('select status,owner_user_id,external_run_id from workflow_runs');
 expect(runs).toEqual([{status:'pending',owner_user_id:owner.id,external_run_id:null}]);
 await db.query(`update workflow_integrations set enabled=false,status='disconnected' where id=$1`,[integration.id]);
 expect(await workflowToolAvailability(db)).toEqual([]);
 expect(await executeWorkflowTool(db,ctx,'list_native_workflows',{})).toEqual({workflows:[]});
 expect(await executeWorkflowTool(db,ctx,'run_native_workflow',input)).toMatchObject({ok:false});
 expect(await db.query('select id from workflow_runs')).toHaveLength(1);
});
