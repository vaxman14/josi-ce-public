import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { developerIntegrationToolAvailability, executeDeveloperIntegrationTool } from '../src/developerIntegrationTools.js';
import { TOOL_SPECS_BY_NAME } from '../src/tools.js';

let db:TestDb;let owner:string;let other:string;
beforeEach(async()=>{db=await testDb();owner=(await createUser(db,{email:'native-owner@test.invalid',username:'nativeowner',role:'member'})).id;other=(await createUser(db,{email:'native-other@test.invalid',username:'nativeother',role:'member'})).id;await db.query(`insert into developer_connections(owner_user_id,service,credentials_enc,account_label,status,last_check_at,last_check_ok) values($1,'gitlab','sealed-never-return','git-user','active',now(),true),($2,'notion','other-secret','other workspace','active',now(),true)`,[owner,other]);});

describe('native integration assistant status',()=>{
  it('is offered only to an owner with a connection and is registered read-only',async()=>{
    expect(await developerIntegrationToolAvailability(db,owner)).toHaveLength(2);
    expect(TOOL_SPECS_BY_NAME.get('list_native_integrations')?.actionClass).toBeNull();
    expect(TOOL_SPECS_BY_NAME.get('list_native_resources')?.actionClass).toBeNull();
  });
  it('returns provider identity and capability without credentials or another user',async()=>{
    const result=await executeDeveloperIntegrationTool(db,owner);
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]).toMatchObject({provider:'gitlab',account:'git-user',healthy:true});
    expect(JSON.stringify(result)).not.toContain('sealed-never-return');
    expect(JSON.stringify(result)).not.toContain('other workspace');
  });
});
