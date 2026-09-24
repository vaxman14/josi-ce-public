import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { executeWorkspaceTool } from '../../agent/src/workspaceTools.js';
import { workspaceGrant } from '../src/localWorkspace.js';
import {
  WORKSPACE_MOUNT_PATH, reconcileWorkspaceMount, workspaceMountRootAllowed,
  type WorkspaceMountProbe,
} from '../src/workspaceMount.js';

let db: TestDb;
const mounted: WorkspaceMountProbe = { available: vi.fn(async () => true) };
const missing: WorkspaceMountProbe = { available: vi.fn(async () => false) };

beforeAll(async () => { db = await testDb(); }, 30_000);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.query('delete from folder_mappings');
  await db.query('delete from storage_roots');
  await db.query('delete from users');
  vi.mocked(mounted.available).mockClear();
  vi.mocked(missing.available).mockClear();
});

async function owner(email = 'owner@example.test') {
  return createUser(db, { email, username: email.split('@')[0]!, role: 'super_admin' });
}

describe('workspace mount bootstrap and reconciliation', () => {
  it('creates the fixed root and a read/write grant for the installation owner', async () => {
    const admin = await owner();
    const result = await reconcileWorkspaceMount(db, { enabled: true, writable: true }, mounted);
    expect(result).toMatchObject({ status: 'ready', ownerUserId: admin.id, writable: true });
    expect(mounted.available).toHaveBeenCalledWith(WORKSPACE_MOUNT_PATH, true);

    const [root] = await db.query<{ container_path: string; writable: boolean; enabled: boolean }>(
      'select container_path, writable, enabled from storage_roots',
    );
    expect(root).toEqual({ container_path: '/workspace', writable: true, enabled: true });
    const [mapping] = await db.query<Record<string, unknown>>(
      `select owner_user_id, relative_path, display_path, recursive,
              may_create, may_edit, may_move, may_delete, status
       from folder_mappings`,
    );
    expect(mapping).toMatchObject({
      owner_user_id: admin.id, relative_path: '', display_path: '/workspace', recursive: true,
      may_create: true, may_edit: true, may_move: true, may_delete: true, status: 'active',
    });
    const [capability] = await db.query<{ user_id: string; may_map_local: boolean }>(
      'select user_id, may_map_local from storage_capabilities',
    );
    expect(capability).toEqual({ user_id: admin.id, may_map_local: true });
    const discovery = await executeWorkspaceTool(db, admin.id, 'list_workspace_mappings', {}) as {
      mappings: Array<Record<string, unknown>>;
    };
    expect(discovery.mappings).toEqual([
      expect.objectContaining({ mapping_id: result.status === 'ready' ? result.mappingId : '', name: '/workspace' }),
    ]);
  });

  it('is idempotent on upgrade and reconciles mode without duplicating data', async () => {
    await owner();
    const first = await reconcileWorkspaceMount(db, { enabled: true, writable: true }, mounted);
    const second = await reconcileWorkspaceMount(db, { enabled: true, writable: false }, mounted);
    expect(second).toMatchObject({
      status: 'ready',
      rootId: first.status === 'ready' ? first.rootId : '',
      mappingId: first.status === 'ready' ? first.mappingId : '',
      writable: false,
    });
    expect(await db.query('select id from storage_roots where container_path = $1', ['/workspace'])).toHaveLength(1);
    expect(await db.query("select id from folder_mappings where display_path = '/workspace'")).toHaveLength(1);
    const [mapping] = await db.query<{ may_create: boolean; may_edit: boolean }>(
      "select may_create, may_edit from folder_mappings where display_path = '/workspace'",
    );
    expect(mapping).toEqual({ may_create: false, may_edit: false });
  });

  it('preserves explicit capability revocation and unmapping across restarts', async () => {
    const admin = await owner();
    const first = await reconcileWorkspaceMount(db, { enabled: true, writable: true }, mounted);
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;

    await db.query(`update storage_capabilities set may_map_local=false where user_id=$1`, [admin.id]);
    expect(await reconcileWorkspaceMount(db, { enabled: true, writable: true }, mounted))
      .toEqual({ status: 'revoked' });
    expect((await db.query<{ may_map_local: boolean }>(
      `select may_map_local from storage_capabilities where user_id=$1`, [admin.id],
    ))[0].may_map_local).toBe(false);

    await db.query(`update storage_capabilities set may_map_local=true where user_id=$1`, [admin.id]);
    await db.query(`delete from folder_mappings where id=$1`, [first.mappingId]);
    expect(await reconcileWorkspaceMount(db, { enabled: true, writable: true }, mounted))
      .toEqual({ status: 'awaiting_mapping' });
    expect(await db.query(`select id from folder_mappings where owner_user_id=$1`, [admin.id]))
      .toHaveLength(0);
  });

  it('assigns only the active super-admin and preserves other users and roots', async () => {
    const member = await createUser(db, {
      email: 'member@example.test', username: 'member', role: 'member',
    });
    const admin = await owner();
    const [otherRoot] = await db.query<{ id: string }>(
      `insert into storage_roots(container_path, label, writable)
       values('/data/roots/member', 'Member files', false) returning id`,
    );
    await db.query(
      `insert into storage_capabilities(user_id, may_map_local) values($1, true)`, [member.id],
    );
    await db.query(
      `insert into folder_mappings(owner_user_id, provider, root_id, display_path)
       values($1, 'local', $2, 'Member files')`, [member.id, otherRoot.id],
    );

    await reconcileWorkspaceMount(db, { enabled: true, writable: false }, mounted);
    const workspaceMappings = await db.query<{ owner_user_id: string }>(
      `select m.owner_user_id from folder_mappings m
       join storage_roots r on r.id = m.root_id where r.container_path = '/workspace'`,
    );
    expect(workspaceMappings).toEqual([{ owner_user_id: admin.id }]);
    expect(await db.query('select id from folder_mappings where owner_user_id = $1', [member.id])).toHaveLength(1);
    expect(await db.query('select id from storage_roots where id = $1', [otherRoot.id])).toHaveLength(1);
  });

  it('does nothing when disabled, unavailable, or still awaiting first-run owner creation', async () => {
    await owner();
    expect(await reconcileWorkspaceMount(db, { enabled: false, writable: true }, mounted))
      .toEqual({ status: 'disabled' });
    expect(mounted.available).not.toHaveBeenCalled();
    await db.query(
      `insert into storage_roots(container_path, label, enabled)
       values('/workspace', 'Stale workspace', true)`,
    );
    expect(await reconcileWorkspaceMount(db, { enabled: true, writable: true }, missing))
      .toEqual({ status: 'unavailable' });
    expect(await db.query("select id from storage_roots where container_path='/workspace' and enabled=true"))
      .toHaveLength(0);

    await db.query('delete from storage_roots');
    await db.query('delete from users');
    expect(await reconcileWorkspaceMount(db, { enabled: true, writable: false }, mounted))
      .toEqual({ status: 'awaiting_owner' });
    expect(await db.query('select id from storage_roots')).toHaveLength(0);
  });

  it('allows list/read authorization only for the configured fixed mount and its owner', async () => {
    const admin = await owner();
    const other = await createUser(db, {
      email: 'other@example.test', username: 'other', role: 'member',
    });
    const result = await reconcileWorkspaceMount(db, { enabled: true, writable: false }, mounted);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;

    vi.stubEnv('JOSI_WORKSPACE_ENABLED', '1');
    expect(workspaceMountRootAllowed('/workspace')).toBe(true);
    expect(workspaceMountRootAllowed('/home/roman/josi-workspace')).toBe(false);
    expect((await workspaceGrant(db, admin.id, result.mappingId)).container_path).toBe('/workspace');
    await expect(workspaceGrant(db, other.id, result.mappingId)).rejects.toThrow('unavailable');

    vi.stubEnv('JOSI_WORKSPACE_ENABLED', '0');
    await expect(workspaceGrant(db, admin.id, result.mappingId)).rejects.toThrow('unavailable');
  });
});
