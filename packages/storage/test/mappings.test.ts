// The grant: who may create one, what it starts as, and what ending it destroys.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import {
  MappingError, capabilityFor, consentText, createMapping, mappingsBlockingUserRemoval,
  pauseMapping, purgeDerived, registerRoot, setIndexing, setPermissions, unmapFolder,
} from '../src/mappings.js';
import { PathEscape } from '../src/paths.js';

let db: TestDb;
let base: string;
let rootPath: string;
const ids: Record<string, string> = {};
let rootId: string;
let roRootId: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'josi-map-'));
  rootPath = join(base, 'roots', 'docs');
  await mkdir(join(rootPath, 'reports'), { recursive: true });
  await mkdir(join(base, 'roots', 'ro'), { recursive: true });
  await mkdir(join(base, 'outside'), { recursive: true });
  await symlink(join(base, 'outside'), join(rootPath, 'escape'));

  db = await testDb();
  for (const [name, role] of [['admin', 'super_admin'], ['alice', 'member'], ['bob', 'member']] as const) {
    const [u] = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ($1, $2, $3) returning id`,
      [`${name}@example.test`, name, role],
    );
    ids[name] = u.id;
  }
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

beforeEach(async () => {
  await db.query(`delete from folder_mappings`);
  await db.query(`delete from storage_roots`);
  await db.query(`delete from storage_capabilities`);
  await db.query(`delete from resource_shares`);
  // Registered through the real function, against a base pointed at the
  // fixtures. Inserting rows by hand here would skip the containment rule that
  // `registerRoot` exists to apply.
  const rootsBase = join(base, 'roots');
  rootId = (await registerRoot(db, {
    containerPath: rootPath, label: 'Documents',
    purpose: 'shared reference material', writable: true, base: rootsBase,
  })).id;
  roRootId = (await registerRoot(db, {
    containerPath: join(rootsBase, 'ro'), label: 'Read only', writable: false, base: rootsBase,
  })).id;
});

const allow = (user: string, over: Record<string, boolean> = {}) =>
  db.query(
    `insert into storage_capabilities (user_id, may_map_local, may_map_cloud, may_index, granted_by)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update set may_map_local = excluded.may_map_local,
       may_map_cloud = excluded.may_map_cloud, may_index = excluded.may_index`,
    [ids[user], over.local ?? true, over.cloud ?? false, over.index ?? false, ids.admin],
  );

const mapDocs = (user = 'alice', over: Record<string, unknown> = {}) =>
  createMapping(db, {
    ownerUserId: ids[user], provider: 'local', rootId, relativePath: 'reports', ...over,
  });

describe('the dual gate — M47', () => {
  it('refuses without the administrator having enabled it', async () => {
    await expect(mapDocs()).rejects.toThrow(MappingError);
    const rows = await db.query(`select 1 from folder_mappings`);
    expect(rows).toHaveLength(0);
  });

  it('allows it once enabled', async () => {
    await allow('alice');
    const m = await mapDocs();
    expect(m.owner_user_id).toBe(ids.alice);
    expect(m.display_path).toBe('Documents/reports');
  });

  it('local and cloud are separate grants', async () => {
    await allow('alice', { local: true, cloud: false });
    await expect(createMapping(db, {
      ownerUserId: ids.alice, provider: 'google_drive',
      connectionId: '00000000-0000-4000-8000-000000000000', remoteFolderId: 'x',
    })).rejects.toThrow(/administrator has not enabled/);
  });

  it('says the same thing either way, so the refusal leaks nothing', async () => {
    const local = await mapDocs().catch((e) => (e as Error).message);
    await allow('alice', { local: true, cloud: false });
    const cloud = await createMapping(db, {
      ownerUserId: ids.alice, provider: 'onedrive', connectionId: 'x', remoteFolderId: 'y',
    }).catch((e) => (e as Error).message);
    expect(local).toBe(cloud);
  });
});

describe('what a mapping starts as — M47', () => {
  beforeEach(() => allow('alice'));

  it('is read-only and unindexed', async () => {
    const m = await mapDocs();
    expect(m.may_create).toBe(false);
    expect(m.may_edit).toBe(false);
    expect(m.may_move).toBe(false);
    expect(m.may_delete).toBe(false);
    expect(m.indexing_enabled).toBe(false);
  });

  // The COLUMN default, not the code path. `createMapping` always supplies a
  // value, so mutating the schema default broke no test — which means the
  // database's own safe default was unprotected. It matters because a later
  // phase inserting a mapping row directly (a migration, a transfer, a repair
  // script) would silently get whatever the schema says.
  it('the schema itself defaults to the safe settings', async () => {
    const [row] = await db.query<{
      recursive: boolean; may_create: boolean; may_edit: boolean;
      may_move: boolean; may_delete: boolean; indexing_enabled: boolean; status: string;
    }>(
      `insert into folder_mappings (owner_user_id, provider, root_id, relative_path, display_path)
       values ($1, 'local', $2, 'reports', 'Documents/reports') returning *`,
      [ids.bob, rootId],
    );
    expect(row.recursive).toBe(false);
    expect(row.may_create).toBe(false);
    expect(row.may_edit).toBe(false);
    expect(row.may_move).toBe(false);
    expect(row.may_delete).toBe(false);
    expect(row.indexing_enabled).toBe(false);
    expect(row.status).toBe('active');
  });

  it('is not recursive unless asked for', async () => {
    expect((await mapDocs()).recursive).toBe(false);
    await db.query(`delete from folder_mappings`);
    expect((await mapDocs('alice', { recursive: true })).recursive).toBe(true);
  });

  it('grants permissions one at a time', async () => {
    const m = await mapDocs();
    const after = await setPermissions(db, { mappingId: m.id, ownerUserId: ids.alice, edit: true });
    expect(after.may_edit).toBe(true);
    expect(after.may_create).toBe(false);
    expect(after.may_delete).toBe(false);
  });

  it('cannot be made writable when the operator declared the root read-only', async () => {
    const m = await createMapping(db, {
      ownerUserId: ids.alice, provider: 'local', rootId: roRootId, relativePath: '',
    });
    await expect(setPermissions(db, { mappingId: m.id, ownerUserId: ids.alice, edit: true }))
      .rejects.toThrow(/read-only/);
  });

  it('only the owner may change permissions', async () => {
    const m = await mapDocs();
    await expect(setPermissions(db, { mappingId: m.id, ownerUserId: ids.bob, edit: true }))
      .rejects.toThrow(/not found/);
    await expect(setPermissions(db, { mappingId: m.id, ownerUserId: ids.admin, edit: true }))
      .rejects.toThrow(/not found/);
  });
});

describe('containment at grant time — M45', () => {
  beforeEach(() => allow('alice'));

  it('refuses traversal in the mapped path', async () => {
    await expect(mapDocs('alice', { relativePath: '../outside' })).rejects.toThrow(PathEscape);
  });

  it('refuses a symlink that leaves the root', async () => {
    await expect(mapDocs('alice', { relativePath: 'escape' })).rejects.toThrow(PathEscape);
    expect(await db.query(`select 1 from folder_mappings`)).toHaveLength(0);
  });

  it('refuses an unregistered root', async () => {
    await expect(mapDocs('alice', { rootId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toThrow(/not available/);
  });

  it('refuses a root the administrator switched off', async () => {
    await db.query(`update storage_roots set enabled = false where id = $1`, [rootId]);
    await expect(mapDocs()).rejects.toThrow(/not available/);
  });

  it('refuses the same folder twice', async () => {
    await mapDocs();
    await expect(mapDocs()).rejects.toThrow(/already mapped/);
  });
});

describe('the consent sentence — M49, M50', () => {
  it('says a recursive scope covers folders added later', () => {
    const text = consentText({ displayPath: 'Documents/reports', recursive: true, indexing: false });
    expect(text).toContain('any subfolder added to it in future');
  });

  it('says plainly when it does not', () => {
    const text = consentText({ displayPath: 'Documents/reports', recursive: false, indexing: false });
    expect(text).toContain('not its subfolders');
    expect(text).not.toContain('in future');
  });

  it('distinguishes mapping from indexing', () => {
    const mapped = consentText({ displayPath: 'D', recursive: false, indexing: false });
    const indexed = consentText({ displayPath: 'D', recursive: false, indexing: true });
    expect(mapped).toContain('Nothing is copied or kept');
    // M49's warning: indexing means the text is kept AND sent to a model.
    expect(indexed).toContain('keep the extracted text');
    expect(indexed).toContain('language model');
  });
});

describe('indexing is a separate consent — M49', () => {
  beforeEach(() => allow('alice'));

  it('is refused when the administrator has not enabled indexing', async () => {
    const m = await mapDocs();
    await expect(setIndexing(db, { mappingId: m.id, ownerUserId: ids.alice, enabled: true }))
      .rejects.toThrow(/has not enabled indexing/);
  });

  it('turns on once both gates are open', async () => {
    await allow('alice', { index: true });
    const m = await mapDocs();
    const { mapping } = await setIndexing(db, { mappingId: m.id, ownerUserId: ids.alice, enabled: true });
    expect(mapping.indexing_enabled).toBe(true);
  });
});

describe('purge — M54', () => {
  beforeEach(() => allow('alice', { index: true }));

  const seedDocs = async (mappingId: string, n = 3) => {
    for (let i = 0; i < n; i += 1) {
      await db.query(
        `insert into documents (mapping_id, owner_user_id, relative_path, filename)
         values ($1, $2, $3, $4)`,
        [mappingId, ids.alice, `f${i}.txt`, `f${i}.txt`],
      );
    }
  };

  it('revoking indexing destroys the derived data immediately', async () => {
    const m = await mapDocs();
    await setIndexing(db, { mappingId: m.id, ownerUserId: ids.alice, enabled: true });
    await seedDocs(m.id);

    const { purged } = await setIndexing(db, { mappingId: m.id, ownerUserId: ids.alice, enabled: false });
    expect(purged).toEqual({ documents: 3 });
    expect(await db.query(`select 1 from documents where mapping_id = $1`, [m.id])).toHaveLength(0);
    // The mapping itself survives — revoking indexing is not unmapping.
    expect(await db.query(`select 1 from folder_mappings where id = $1`, [m.id])).toHaveLength(1);
  });

  it('unmapping destroys both', async () => {
    const m = await mapDocs();
    await seedDocs(m.id, 2);
    const purged = await unmapFolder(db, { mappingId: m.id, ownerUserId: ids.alice });
    expect(purged.documents).toBe(2);
    expect(await db.query(`select 1 from folder_mappings where id = $1`, [m.id])).toHaveLength(0);
    expect(await db.query(`select 1 from documents where mapping_id = $1`, [m.id])).toHaveLength(0);
  });

  it('counts each artefact type rather than trusting the cascade', async () => {
    // If a later phase adds a derived table and forgets to purge it, the count
    // is what makes that visible. Deleting the mapping row directly must not be
    // how derived data disappears.
    const m = await mapDocs();
    await seedDocs(m.id, 1);
    const counts = await purgeDerived(db, m.id);
    expect(Object.keys(counts)).toContain('documents');
    expect(counts.documents).toBe(1);
  });

  it('a colleague cannot unmap someone else\'s folder', async () => {
    const m = await mapDocs();
    await expect(unmapFolder(db, { mappingId: m.id, ownerUserId: ids.bob })).rejects.toThrow(/not found/);
    await expect(unmapFolder(db, { mappingId: m.id, ownerUserId: ids.admin })).rejects.toThrow(/not found/);
    expect(await db.query(`select 1 from folder_mappings where id = $1`, [m.id])).toHaveLength(1);
  });
});

describe('pausing is not revoking — M78', () => {
  beforeEach(() => allow('alice', { index: true }));

  it('keeps the derived data', async () => {
    const m = await mapDocs();
    await db.query(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename)
       values ($1, $2, 'a.txt', 'a.txt')`, [m.id, ids.alice],
    );
    await pauseMapping(db, { mappingId: m.id, reason: 'token_expired' });

    const [row] = await db.query<{ status: string; paused_reason: string }>(
      `select status, paused_reason from folder_mappings where id = $1`, [m.id],
    );
    expect(row.status).toBe('paused');
    expect(row.paused_reason).toBe('token_expired');
    expect(await db.query(`select 1 from documents where mapping_id = $1`, [m.id])).toHaveLength(1);
  });
});

describe('the audit trail is metadata only — M72', () => {
  beforeEach(() => allow('alice'));

  it('never records the folder name', async () => {
    const m = await mapDocs();
    await setPermissions(db, { mappingId: m.id, ownerUserId: ids.alice, edit: true });
    await unmapFolder(db, { mappingId: m.id, ownerUserId: ids.alice });

    const rows = await db.query<{ p: string }>(
      `select payload::text as p from events where subject_type = 'folder_mapping'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const r of rows) {
      expect(r.p).not.toContain('Documents');
      expect(r.p).not.toContain('reports');
    }
  });
});

describe('removing a user — M70', () => {
  beforeEach(() => allow('alice'));

  it('names the shared mappings that must be transferred or purged', async () => {
    const m = await mapDocs();
    expect(await mappingsBlockingUserRemoval(db, ids.alice)).toHaveLength(0);

    await db.query(
      `insert into resource_shares (resource_type, resource_id, owner_user_id, shared_with_user_id)
       values ('folder_mapping', $1, $2, $3)`,
      [m.id, ids.alice, ids.bob],
    );
    const blocking = await mappingsBlockingUserRemoval(db, ids.alice);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].shared_with).toBe(1);
  });

  it('private mappings and their derived data go with the user', async () => {
    const m = await mapDocs();
    await db.query(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename)
       values ($1, $2, 'a.txt', 'a.txt')`, [m.id, ids.alice],
    );
    const [u] = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ('tmp@example.test','tmp','member') returning id`,
    );
    await db.query(`update folder_mappings set owner_user_id = $1 where id = $2`, [u.id, m.id]);
    await db.query(`update documents set owner_user_id = $1 where mapping_id = $2`, [u.id, m.id]);

    await db.query(`delete from users where id = $1`, [u.id]);
    expect(await db.query(`select 1 from folder_mappings where id = $1`, [m.id])).toHaveLength(0);
    expect(await db.query(`select 1 from documents where mapping_id = $1`, [m.id])).toHaveLength(0);
  });
});

describe('registering a root — M45', () => {
  it('refuses a path outside the folder Josi mounts storage into', async () => {
    await expect(registerRoot(db, {
      containerPath: '/etc', label: 'Everything', base: join(base, 'roots'),
    })).rejects.toThrow(/under the folder/);
  });

  it('refuses a sibling whose name merely starts with the base', async () => {
    // The `startsWith` bug again, this time at registration.
    await expect(registerRoot(db, {
      containerPath: `${join(base, 'roots')}-private/docs`, label: 'Sneaky', base: join(base, 'roots'),
    })).rejects.toThrow(/under the folder/);
  });

  it('refuses traversal and relative paths', async () => {
    const rootsBase = join(base, 'roots');
    await expect(registerRoot(db, {
      containerPath: `${rootsBase}/../outside`, label: 'x', base: rootsBase,
    })).rejects.toThrow(/not in the expected form/);
    await expect(registerRoot(db, {
      containerPath: 'roots/docs', label: 'x', base: rootsBase,
    })).rejects.toThrow(/absolute/);
  });

  it('requires a label people will recognise', async () => {
    const rootsBase = join(base, 'roots');
    await expect(registerRoot(db, {
      containerPath: rootsBase, label: '   ', base: rootsBase,
    })).rejects.toThrow(/label/);
  });
});

describe('capabilities default to nothing — M45', () => {
  it('an unknown user has no capability at all', async () => {
    const cap = await capabilityFor(db, ids.bob);
    expect(cap).toEqual({
      may_map_local: false, may_map_cloud: false, may_index: false,
      max_files: null, max_bytes: null,
    });
  });
});
