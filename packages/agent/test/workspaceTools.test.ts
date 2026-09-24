import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { executeWorkspaceTool, WORKSPACE_TOOLS, workspaceToolNames } from '../src/workspaceTools.js';

let db: TestDb;
let owner: string;
let other: string;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, {email:'workspace-owner@test.invalid',username:'workspaceowner',role:'member'})).id;
  other = (await createUser(db, {email:'workspace-other@test.invalid',username:'workspaceother',role:'member'})).id;
  await db.query(`insert into storage_capabilities(user_id,may_map_local) values($1,true),($2,true)`,[owner,other]);
  const [root] = await db.query<{id:string}>(`insert into storage_roots(label,container_path,purpose,writable) values('Josi Drive','/data/roots/private-host-path','documents',true) returning id`);
  await db.query(`insert into folder_mappings(owner_user_id,provider,root_id,relative_path,display_path,recursive,may_create,may_edit,may_move,may_delete)
    values($1,'local',$3,'','/workspace',true,true,true,true,true),($2,'local',$3,'secret','Other person',true,false,false,false,false)`,[owner,other,root.id]);
});

describe('workspace mapping discovery', () => {
  it('offers discovery whenever an authorized local mapping exists', async () => {
    expect(await workspaceToolNames(db,owner)).toContain('list_workspace_mappings');
  });

  it('returns only safe display metadata with the canonical mapping_id response key', async () => {
    const result = await executeWorkspaceTool(db,owner,'list_workspace_mappings',{}) as {mappings:Array<Record<string,unknown>>};
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]).toMatchObject({name:'/workspace',recursive:true,permissions:{create:true,edit:true,move:true,delete:true}});
    expect(result.mappings[0].mapping_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.mappings[0]).not.toHaveProperty('mappingId');
    expect(JSON.stringify(result)).not.toContain('private-host-path');
    expect(JSON.stringify(result)).not.toContain('Other person');
  });

  it('advertises canonical mapping_id requests and does not advertise the compatibility alias', () => {
    const read = WORKSPACE_TOOLS.find(tool => tool.def.name === 'workspace_read')!.def;
    expect(read.parameters.required).toContain('mapping_id');
    expect(read.parameters.properties).toHaveProperty('mapping_id');
    expect(read.parameters.properties).not.toHaveProperty('mappingId');
    expect(read.description).toContain('list_workspace_mappings');
  });
});
