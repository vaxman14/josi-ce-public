// The 2026-09 storage-sync diagnostic fix, assistant-facing half.
//
// search_documents and list_documents (execute.ts) used to answer purely from
// the `documents` table, with no idea whether the folders behind those rows
// were healthy, degraded, or had never synced a single file. Root-caused on a
// real installation from a real conversation (thread
// 1053d739-07eb-4bcc-9fa1-a4c08f0be6e5): a person asking "check my docs"
// while some connected folders had never completed a sync got a confident,
// differently-shaped answer on every check, because nothing in the tool
// result ever said "some of what you're asking about was never actually
// read". These tests prove the fix: both tools now attach a plain-language
// note plus a structured `folder_sync_health` / `degraded_folders` field
// whenever at least one connected folder is degraded, and say nothing extra
// when everything is healthy.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey } from '@josi-ce/core';
import { createMapping, setIndexing } from '@josi-ce/storage';
import { saveClient, setCapability, syncCloudMapping, upsertConnection, type ConnectionRow } from '@josi-ce/connectors';
import { executeAssistantTool } from '../src/execute.js';

let db: TestDb;
let alice: string;
let admin: string;
const key = new MasterKey(Buffer.alloc(32, 7));

beforeEach(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'ad@ce.test', username: 'admin', role: 'super_admin' })).id;
  alice = (await createUser(db, { email: 'a@ce.test', username: 'alice', role: 'member' })).id;
  await saveClient(db, key, {
    provider: 'google',
    clientId: 'client-id',
    clientSecret: 'CLIENT-SECRET-value',
    redirectUri: 'https://josi.example.test/api/connections/google/callback',
    actorUserId: admin,
  });
});

async function connect(user: string): Promise<ConnectionRow> {
  const connection = await upsertConnection(db, key, {
    ownerUserId: user,
    provider: 'google',
    tokens: {
      accessToken: 'access-token', refreshToken: 'refresh-token', expiresIn: 3600,
      grantedScopes: 'openid https://www.googleapis.com/auth/drive.readonly',
    },
    accountEmail: 'someone@gmail.test',
    providerAccountId: 'acct-1',
    requestedCapabilities: ['google.drive.read'],
  });
  await setCapability(db, { connection, capability: 'google.drive.read', enabled: true, actorUserId: user });
  return connection;
}

let folderCounter = 0;

async function mapFolder(user: string, connectionId: string, displayPath: string) {
  await db.query(
    `insert into storage_capabilities (user_id, may_map_cloud, may_index, granted_by)
     values ($1, true, true, $2)
     on conflict (user_id) do update set may_map_cloud = true, may_index = true`,
    [user, admin],
  );
  folderCounter += 1;
  // Google's own id shape (assertEntryId in providers/files.ts) is
  // [A-Za-z0-9_-] only — a display path with spaces and slashes is exactly
  // what displayPath is FOR, and exactly what remoteFolderId must never be.
  const mapping = await createMapping(db, {
    ownerUserId: user, provider: 'google_drive', connectionId,
    remoteFolderId: `folder-id-${folderCounter}`, displayPath, recursive: true,
  });
  await setIndexing(db, { mappingId: mapping.id, ownerUserId: user, enabled: true });
  return mapping;
}

function drive(files: Array<{ id: string; name: string; content: string }>) {
  const fetchImpl = (async (url: RequestInfo | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/files')) {
      return new Response(JSON.stringify({
        files: files.map((f) => ({ id: f.id, name: f.name, mimeType: 'text/plain', size: String(f.content.length), modifiedTime: '2026-09-01T00:00:00Z' })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const media = /\/files\/([^/?]+)/.exec(u.pathname)?.[1];
    const file = files.find((f) => f.id === media);
    if (file) return new Response(file.content, { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

// A function, not a module-level object literal: `alice` is reassigned fresh
// in every beforeEach, and a `const ctx = { userId: alice, ... }` evaluated
// once at module load would capture whatever `alice` was bound to at import
// time (undefined), not the current test's user.
function ctxFor(userId: string): { userId: string; threadId: null } {
  return { userId, threadId: null };
}

describe('search_documents: honest about degraded folders', () => {
  it('does not search partial rows from a cloud folder that has never completed a sync', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Partial');
    await db.query(
      `insert into sync_state (mapping_id, owner_user_id, consecutive_failures, last_error_category)
       values ($1, $2, 1, 'unknown')`,
      [mapping.id, alice],
    );
    const [doc] = await db.query<{ id: string }>(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
       values ($1, $2, 'partial.txt', 'partial.txt', 'indexed') returning id`,
      [mapping.id, alice],
    );
    await db.query(
      `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
       values ($1, $2, 0, 'page', '1', 'zebra should stay hidden')`,
      [doc.id, alice],
    );

    const result = await executeAssistantTool(db, ctxFor(alice), 'search_documents', { query: 'zebra' }) as Record<string, unknown>;
    expect(result.hits).toEqual([]);
    expect(result.message).toMatch(/No documents are indexed yet/);
    expect(result.message).toMatch(/has not synced successfully/i);
  });

  it('says nothing extra when every connected folder is healthy', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Reports');
    await syncCloudMapping(db, mapping.id, { masterKey: key, fetchImpl: drive([{ id: 't1', name: 'notes.txt', content: 'zebra migration plan' }]) });

    const result = await executeAssistantTool(db, ctxFor(alice), 'search_documents', { query: 'zebra' }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect((result.hits as unknown[]).length).toBe(1);
    expect(result.note).toBeUndefined();
    expect(result.degraded_folders).toBeUndefined();
  });

  it('flags a folder that has never synced, even when the other folder has real hits', async () => {
    const connection = await connect(alice);
    const goodMapping = await mapFolder(alice, connection.id, 'Google Drive/Working');
    await syncCloudMapping(db, goodMapping.id, { masterKey: key, fetchImpl: drive([{ id: 't1', name: 'notes.txt', content: 'zebra migration plan' }]) });
    // A second folder that has never synced: create it, but never call
    // syncCloudMapping on it at all — exactly "last_sync_at IS NULL" on the
    // real installation.
    await mapFolder(alice, connection.id, 'Google Drive/Never Synced');

    const result = await executeAssistantTool(db, ctxFor(alice), 'search_documents', { query: 'zebra' }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect((result.hits as unknown[]).length).toBe(1);
    expect(typeof result.note).toBe('string');
    expect(result.note as string).toContain('1 of 2');
    expect(result.note as string).toContain('Never Synced');
    const degraded = result.degraded_folders as Array<{ folder: string; ok: boolean; detail: string }>;
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.folder).toBe('Google Drive/Never Synced');
    expect(degraded[0]!.ok).toBe(false);
    expect(degraded[0]!.detail).toContain('never completed a sync');
  });

  it('a zero-hit search still says plainly that some folders never synced, not just "nothing matched"', async () => {
    const connection = await connect(alice);
    await mapFolder(alice, connection.id, 'Google Drive/Marketing 1');
    // Never synced. Zero documents indexed anywhere.
    const result = await executeAssistantTool(db, ctxFor(alice), 'search_documents', { query: 'anything' }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect((result.hits as unknown[]).length).toBe(0);
    expect(result.message as string).toContain('Marketing 1');
    // The exact wording is degradedFoldersNote's, appended after the ordinary
    // "no documents indexed" sentence — the point being tested is that the
    // FOLDER NAME and the fact that it never synced successfully both reach
    // the person, not the literal phrasing.
    expect(result.message as string).toMatch(/has not synced successfully/i);
  });

  it('a paused mapping (capability revoked mid-flight) is reported as paused, distinct from never-synced', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Reports');
    await syncCloudMapping(db, mapping.id, { masterKey: key, fetchImpl: drive([{ id: 't1', name: 'notes.txt', content: 'first sync worked' }]) });
    await setCapability(db, { connection, capability: 'google.drive.read', enabled: false, actorUserId: alice });
    await syncCloudMapping(db, mapping.id, { masterKey: key, fetchImpl: drive([]) });

    const result = await executeAssistantTool(db, ctxFor(alice), 'search_documents', { query: 'first' }) as Record<string, unknown>;
    // The one successful sync's content is still there and searchable — M78:
    // paused does not purge.
    expect((result.hits as unknown[]).length).toBe(1);
    const degraded = result.degraded_folders as Array<{ folder: string; ok: boolean; detail: string }>;
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.detail).toContain('paused');
    expect(degraded[0]!.detail).not.toContain('never completed a sync');
  });
});

describe('list_documents: honest about degraded folders', () => {
  it('does not name partial files from a cloud folder that has never completed a sync', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Partial');
    await db.query(
      `insert into sync_state (mapping_id, owner_user_id, consecutive_failures, last_error_category)
       values ($1, $2, 1, 'unknown')`,
      [mapping.id, alice],
    );
    await db.query(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
       values ($1, $2, 'partial.txt', 'partial.txt', 'indexed')`,
      [mapping.id, alice],
    );

    const result = await executeAssistantTool(db, ctxFor(alice), 'list_documents', {}) as Record<string, unknown>;
    expect(result.documents).toEqual([]);
    expect(result.note).toMatch(/has not synced successfully/i);
  });

  it('attaches folder_sync_health for every connected folder, healthy or not', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Reports');
    await syncCloudMapping(db, mapping.id, { masterKey: key, fetchImpl: drive([{ id: 't1', name: 'notes.txt', content: 'hello' }]) });
    await mapFolder(alice, connection.id, 'Google Drive/Never Synced');

    const result = await executeAssistantTool(db, ctxFor(alice), 'list_documents', {}) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    // Only a completed sync contributes authoritative file names. The second
    // folder remains visible through health, not partial inventory.
    expect((result.documents as unknown[]).length).toBe(1);
    const health = result.folder_sync_health as Array<{ folder: string; ok: boolean }>;
    expect(health).toHaveLength(2);
    expect(health.find((h) => h.folder === 'Google Drive/Reports')?.ok).toBe(true);
    expect(health.find((h) => h.folder === 'Google Drive/Never Synced')?.ok).toBe(false);
    expect(result.note).toContain('1 of 2');
  });

  it('a person with one working folder and nothing else connected gets no note at all', async () => {
    const connection = await connect(alice);
    const mapping = await mapFolder(alice, connection.id, 'Google Drive/Reports');
    await syncCloudMapping(db, mapping.id, { masterKey: key, fetchImpl: drive([{ id: 't1', name: 'notes.txt', content: 'hello' }]) });

    const result = await executeAssistantTool(db, ctxFor(alice), 'list_documents', {}) as Record<string, unknown>;
    expect(result.note).toBeUndefined();
    const health = result.folder_sync_health as Array<{ ok: boolean }>;
    expect(health.every((h) => h.ok)).toBe(true);
  });

  it('is owner-scoped: a second person’s degraded folders never appear in this person’s answer', async () => {
    const bob = (await createUser(db, { email: 'b@ce.test', username: 'bob', role: 'member' })).id;
    const bobConnection = await connect(bob);
    await mapFolder(bob, bobConnection.id, 'Google Drive/Bobs Broken Folder');
    // Alice has nothing connected at all.
    const result = await executeAssistantTool(db, ctxFor(alice), 'list_documents', {}) as Record<string, unknown>;
    expect(result.folder_sync_health).toEqual([]);
    expect(result.note).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Bobs Broken Folder');
  });
});
