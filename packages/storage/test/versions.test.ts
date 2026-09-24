// History, sharing controls, sync, and audit retention.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import {
  HISTORY_LIMIT, MANUAL_SYNC_MIN_SECONDS, RETENTION_DAYS, SharingDisabled,
  assertSharingAllowed, historyDisclosure, mayManualSync, recordSyncFailure,
  recordVersion, retentionNotice, runAuditRetention, runRecycleBin, sourceDeleted,
  syncHealth, versionsToUnlink,
  type HistoryPolicy,
} from '../src/versions.js';

let db: TestDb;
const ids: Record<string, string> = {};
let mappingId: string;
let cloudMappingId: string;
let documentId: string;

beforeAll(async () => {
  db = await testDb();
  for (const [name, role] of [['admin', 'super_admin'], ['alice', 'member']] as const) {
    const [u] = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ($1, $2, $3) returning id`,
      [`${name}@example.test`, name, role],
    );
    ids[name] = u.id;
  }
  const [root] = await db.query<{ id: string }>(
    `insert into storage_roots (container_path, label) values ('/data/roots/docs', 'Docs') returning id`,
  );
  const [m] = await db.query<{ id: string }>(
    `insert into folder_mappings (owner_user_id, provider, root_id, display_path)
     values ($1, 'local', $2, 'Docs') returning id`,
    [ids.alice, root.id],
  );
  mappingId = m.id;

  const [conn] = await db.query<{ id: string }>(
    `insert into connections (owner_user_id, provider, status)
     values ($1, 'google', 'active') returning id`,
    [ids.alice],
  );
  const [cm] = await db.query<{ id: string }>(
    `insert into folder_mappings (owner_user_id, provider, connection_id, remote_folder_id, display_path)
     values ($1, 'google_drive', $2, 'folder-1', 'Drive/Reports') returning id`,
    [ids.alice, conn.id],
  );
  cloudMappingId = cm.id;
});

beforeEach(async () => {
  await db.query(`delete from document_versions`);
  await db.query(`delete from sync_state`);
  await db.query(`delete from audit_retention_runs`);
  await db.query(`delete from documents`);
  await db.query(`update folder_mappings set status = 'active', paused_reason = null`);
  await db.query(`update storage_policy set
    history_mode = 'disabled', history_kind = 'snapshot', recycle_bin_days = 30,
    sharing_enabled = true, workspace_sharing_enabled = true,
    manual_sync_enabled = true, processing_paused = false, audit_retention = 'one_year'`);
  const [d] = await db.query<{ id: string }>(
    `insert into documents (mapping_id, owner_user_id, relative_path, filename)
     values ($1, $2, 'r.pdf', 'r.pdf') returning id`,
    [mappingId, ids.alice],
  );
  documentId = d.id;
});

const policy = (over: Partial<HistoryPolicy> = {}): HistoryPolicy => ({
  history_mode: 'two', history_kind: 'snapshot', recycle_bin_days: 30, ...over,
});

const addVersion = (p: HistoryPolicy, hash: string, storedPath?: string) =>
  recordVersion(db, {
    documentId, ownerUserId: ids.alice, contentHash: hash, byteSize: 100,
    policy: p, storedPath,
  });

describe('history is off by default — M60', () => {
  // Read from the SCHEMA, not from the row.
  //
  // The first version of this test selected from `storage_policy` — which
  // `beforeEach` had just reset to those exact values. It asserted its own
  // fixture and would have passed whatever the migration said. Mutation testing
  // found it: flipping both defaults in 0007 broke nothing.
  //
  // It matters concretely. These two defaults are the difference between an
  // installation that keeps nothing and one that silently begins storing
  // downloadable copies of every user's documents the moment history is turned
  // on.
  it('the schema itself defaults to keeping nothing', async () => {
    const cols = await db.query<{ column_name: string; column_default: string | null }>(
      `select column_name, column_default from information_schema.columns
       where table_name = 'storage_policy'
         and column_name in ('history_mode', 'history_kind', 'recycle_bin_days',
                             'processing_paused', 'semantic_enabled', 'ocr_enabled',
                             'clamav_enabled', 'archives_enabled', 'audit_retention')`,
    );
    const defaults = Object.fromEntries(cols.map((c) => [c.column_name, c.column_default ?? '']));

    expect(defaults.history_mode, 'history must default to disabled').toContain("'disabled'");
    // Even the KIND defaults to the one that stores no bytes, so an
    // administrator who turns history on without reading the wording gets
    // snapshots rather than copies of everyone's files.
    expect(defaults.history_kind, 'history must default to snapshots').toContain("'snapshot'");

    // The rest of the deny-by-default surface, asserted from the same place for
    // the same reason.
    expect(defaults.semantic_enabled).toContain('false');
    expect(defaults.ocr_enabled).toContain('false');
    expect(defaults.clamav_enabled).toContain('false');
    expect(defaults.archives_enabled).toContain('false');
    expect(defaults.processing_paused).toContain('false');
    expect(defaults.audit_retention).toContain("'one_year'");
    expect(defaults.recycle_bin_days).toContain('30');
  });

  it('records nothing while disabled', async () => {
    const out = await addVersion(policy({ history_mode: 'disabled' }), 'h1');
    expect(out.kept).toBe(false);
    expect(await db.query(`select 1 from document_versions`)).toHaveLength(0);
  });
});

describe('history depth is honoured on the way in — M60', () => {
  it('keeps one', async () => {
    const p = policy({ history_mode: 'one' });
    await addVersion(p, 'h1');
    await addVersion(p, 'h2');
    await addVersion(p, 'h3');
    const rows = await db.query<{ content_hash: string }>(
      `select content_hash from document_versions order by ordinal`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe('h3');
  });

  it('keeps two', async () => {
    const p = policy({ history_mode: 'two' });
    for (const h of ['h1', 'h2', 'h3', 'h4']) await addVersion(p, h);
    const rows = await db.query<{ content_hash: string }>(
      `select content_hash from document_versions order by ordinal`,
    );
    expect(rows.map((r) => r.content_hash)).toEqual(['h3', 'h4']);
  });

  // Trimming on the way in rather than on a sweep. "We deleted it eventually"
  // is not what "keep one previous version" says.
  it('trims immediately, not on some later sweep', async () => {
    const p = policy({ history_mode: 'two' });
    await addVersion(p, 'h1');
    await addVersion(p, 'h2');
    const third = await addVersion(p, 'h3');
    expect(third.trimmed).toBe(1);
    expect(await db.query(`select 1 from document_versions`)).toHaveLength(2);
  });
});

describe('snapshots and recovery copies are different things — M60, M62', () => {
  it('a snapshot stores no bytes', async () => {
    await addVersion(policy({ history_kind: 'snapshot' }), 'h1');
    const [row] = await db.query<{ kind: string; stored_path: string | null }>(
      `select kind, stored_path from document_versions`,
    );
    expect(row.kind).toBe('snapshot');
    expect(row.stored_path).toBeNull();
  });

  it('a recovery copy must say where it lives', async () => {
    await expect(addVersion(policy({ history_kind: 'recovery_copy' }), 'h1'))
      .rejects.toThrow(/somewhere to live/);
  });

  it('a recovery copy lives inside Josi, never in the mapped folder', async () => {
    await addVersion(policy({ history_kind: 'recovery_copy' }), 'h1', '/data/versions/a/b.bin');
    const [row] = await db.query<{ stored_path: string }>(`select stored_path from document_versions`);
    expect(row.stored_path).toBe('/data/versions/a/b.bin');

    // The database refuses anywhere else, so a bug in the caller cannot write a
    // copy of someone's document into a folder they share with colleagues.
    await expect(db.query(
      `insert into document_versions
         (document_id, owner_user_id, ordinal, content_hash, kind, stored_path)
       values ($1, $2, 99, 'x', 'recovery_copy', '/data/roots/docs/leak.bin')`,
      [documentId, ids.alice],
    )).rejects.toThrow();

    await expect(db.query(
      `insert into document_versions
         (document_id, owner_user_id, ordinal, content_hash, kind, stored_path)
       values ($1, $2, 98, 'x', 'recovery_copy', '/data/versions/../roots/docs/leak.bin')`,
      [documentId, ids.alice],
    )).rejects.toThrow();
  });
});

describe('the disclosure says what is actually happening — M61, M62', () => {
  it('says nothing is kept when history is off', () => {
    expect(historyDisclosure(policy({ history_mode: 'disabled' })))
      .toContain('keeps no previous versions');
  });

  it('distinguishes a snapshot from a copy', () => {
    const snap = historyDisclosure(policy({ history_kind: 'snapshot' }));
    expect(snap).toContain('does not keep a copy');
    expect(snap).toContain('nothing extra to download');
  });

  // M62 is the sentence people most need to see.
  it('says plainly that recovery copies are not encrypted by Josi', () => {
    const copy = historyDisclosure(policy({ history_kind: 'recovery_copy' }));
    expect(copy).toContain('NOT encrypted by Josi');
    expect(copy).toContain('full-disk or volume encryption');
    expect(copy).toContain('count towards your storage limit');
    expect(copy).toContain('deleted when you unmap');
  });

  it('counts correctly for one and two', () => {
    expect(historyDisclosure(policy({ history_mode: 'one', history_kind: 'recovery_copy' })))
      .toContain('the previous version');
    expect(historyDisclosure(policy({ history_mode: 'two', history_kind: 'recovery_copy' })))
      .toContain('the previous 2 versions');
    expect(HISTORY_LIMIT).toEqual({ disabled: 0, one: 1, two: 2 });
  });
});

describe('the source disappears — M79', () => {
  it('purges immediately without recovery copies', async () => {
    const out = await sourceDeleted(db, {
      documentId, policy: policy({ history_kind: 'snapshot' }),
    });
    expect(out.purged).toBe(true);
    expect(await db.query(`select 1 from documents where id = $1`, [documentId])).toHaveLength(0);
  });

  it('keeps a recovery copy in the bin for the administrator\'s window', async () => {
    const p = policy({ history_kind: 'recovery_copy', recycle_bin_days: 7 });
    await addVersion(p, 'h1', '/data/versions/a.bin');
    const out = await sourceDeleted(db, { documentId, policy: p });

    expect(out.recycled).toBe(1);
    expect(out.purged).toBe(false);
    const [row] = await db.query<{ purge_after: string; source_deleted_at: string }>(
      `select purge_after, source_deleted_at from document_versions`,
    );
    expect(row.source_deleted_at).toBeTruthy();
    const days = (new Date(row.purge_after).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('still removes the searchable text straight away', async () => {
    const p = policy({ history_kind: 'recovery_copy' });
    await addVersion(p, 'h1', '/data/versions/a.bin');
    await db.query(
      `insert into document_text (document_id, owner_user_id, content, char_count)
       values ($1, $2, 'gone', 4)`, [documentId, ids.alice],
    );
    await sourceDeleted(db, { documentId, policy: p });
    // Search must not offer a result the person cannot open.
    expect(await db.query(`select 1 from document_text`)).toHaveLength(0);
  });

  it('empties the bin when the window passes', async () => {
    const p = policy({ history_kind: 'recovery_copy', recycle_bin_days: 7 });
    await addVersion(p, 'h1', '/data/versions/a.bin');
    await sourceDeleted(db, { documentId, policy: p });
    await db.query(`update document_versions set purge_after = now() - interval '1 day'`);

    const { removed } = await runRecycleBin(db);
    expect(removed).toHaveLength(1);
    expect(removed[0].stored_path).toBe('/data/versions/a.bin');
    expect(await db.query(`select 1 from document_versions`)).toHaveLength(0);
  });

  // The distinction M79 draws, and the one that would be easy to get wrong.
  it('unmapping purges recovery copies now, with no recycle-bin window', async () => {
    // Its own mapping: this test deletes one, and the shared fixture is needed
    // by everything after it.
    const [root] = await db.query<{ id: string }>(`select id from storage_roots limit 1`);
    const [own] = await db.query<{ id: string }>(
      `insert into folder_mappings (owner_user_id, provider, root_id, relative_path, display_path)
       values ($1, 'local', $2, 'temp', 'Docs/temp') returning id`,
      [ids.alice, root.id],
    );
    const [doc] = await db.query<{ id: string }>(
      `insert into documents (mapping_id, owner_user_id, relative_path, filename)
       values ($1, $2, 'x.pdf', 'x.pdf') returning id`,
      [own.id, ids.alice],
    );
    await recordVersion(db, {
      documentId: doc.id, ownerUserId: ids.alice, contentHash: 'h1', byteSize: 10,
      policy: policy({ history_kind: 'recovery_copy', recycle_bin_days: 90 }),
      storedPath: '/data/versions/a.bin',
    });

    const paths = await versionsToUnlink(db, own.id);
    expect(paths).toEqual(['/data/versions/a.bin']);

    await db.query(`delete from folder_mappings where id = $1`, [own.id]);
    // Withdrawing permission must not leave copies of the documents for 90 days.
    expect(await db.query(`select 1 from document_versions where document_id = $1`, [doc.id]))
      .toHaveLength(0);
  });
});

describe('sharing controls — M69', () => {
  it('allows both by default', () => {
    const p = { sharing_enabled: true, workspace_sharing_enabled: true };
    expect(() => assertSharingAllowed(p, { workspace: false })).not.toThrow();
    expect(() => assertSharingAllowed(p, { workspace: true })).not.toThrow();
  });

  it('the administrator can turn sharing off entirely', () => {
    const p = { sharing_enabled: false, workspace_sharing_enabled: true };
    expect(() => assertSharingAllowed(p, { workspace: false })).toThrow(SharingDisabled);
    expect(() => assertSharingAllowed(p, { workspace: true })).toThrow(SharingDisabled);
  });

  // The useful half: colleagues can help each other, nobody can publish to
  // the whole company.
  it('can forbid workspace-wide sharing while allowing person-to-person', () => {
    const p = { sharing_enabled: true, workspace_sharing_enabled: false };
    expect(() => assertSharingAllowed(p, { workspace: false })).not.toThrow();
    expect(() => assertSharingAllowed(p, { workspace: true })).toThrow(/not with everyone/);
  });
});

describe('sync — M76, M77, M78', () => {
  const syncPolicy = (over = {}) => ({
    cloud_sync_minutes: 15, manual_sync_enabled: true, processing_paused: false, ...over,
  });
  const NOW = new Date('2026-08-31T12:00:00Z');

  it('allows a first manual sync', () => {
    expect(mayManualSync(syncPolicy(), { last_manual_sync_at: null }, NOW)).toEqual({ ok: true });
  });

  it('rate-limits a second one, and says how long to wait', () => {
    const res = mayManualSync(
      syncPolicy(), { last_manual_sync_at: '2026-08-31T11:59:30Z' }, NOW,
    );
    expect(res.ok).toBe(false);
    expect((res as any).retryAfterSeconds).toBeGreaterThan(0);
    expect((res as any).retryAfterSeconds).toBeLessThanOrEqual(MANUAL_SYNC_MIN_SECONDS);
  });

  it('allows it again after the window', () => {
    expect(mayManualSync(syncPolicy(), { last_manual_sync_at: '2026-08-31T11:58:00Z' }, NOW))
      .toEqual({ ok: true });
  });

  it('the administrator can turn manual sync off', () => {
    const res = mayManualSync(syncPolicy({ manual_sync_enabled: false }), { last_manual_sync_at: null }, NOW);
    expect(res).toMatchObject({ ok: false });
    expect((res as any).reason).toContain('turned off manual sync');
  });

  // M77: manual sync cannot bypass the global pause, and the pause is what the
  // person is told about — not the rate limit.
  it('cannot bypass the global pause', () => {
    const res = mayManualSync(
      syncPolicy({ processing_paused: true, manual_sync_enabled: false }),
      { last_manual_sync_at: '2026-08-31T11:59:59Z' },
      NOW,
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as any).reason).toContain('paused for the whole installation');
  });

  it('an expired token pauses the mapping and tells the owner — M78', async () => {
    const out = await recordSyncFailure(db, {
      mappingId: cloudMappingId, ownerUserId: ids.alice, category: 'token_expired',
    });
    expect(out.paused).toBe(true);

    const [row] = await db.query<{ status: string; paused_reason: string }>(
      `select status, paused_reason from folder_mappings where id = $1`, [cloudMappingId],
    );
    expect(row.status).toBe('paused');
    expect(row.paused_reason).toBe('token_expired');

    const [ev] = await db.query<{ p: string }>(
      `select payload::text as p from events where kind = 'storage.sync_paused'`,
    );
    expect(ev.p).toContain('token_expired');
    // Never the folder name.
    expect(ev.p).not.toContain('Reports');
  });

  it('a rate limit does not pause anything', async () => {
    const out = await recordSyncFailure(db, {
      mappingId: cloudMappingId, ownerUserId: ids.alice, category: 'rate_limited',
    });
    expect(out.paused).toBe(false);
    const [row] = await db.query<{ status: string }>(
      `select status from folder_mappings where id = $1`, [cloudMappingId],
    );
    expect(row.status).toBe('active');
  });

  it('the administrator sees connection health and no folder names — M78', async () => {
    await recordSyncFailure(db, {
      mappingId: cloudMappingId, ownerUserId: ids.alice, category: 'token_expired',
    });
    const health = await syncHealth(db);
    expect(health).toHaveLength(1);
    expect(health[0].username).toBe('alice');
    expect(health[0].last_error_category).toBe('token_expired');
    expect(JSON.stringify(health)).not.toContain('Reports');
  });
});

describe('audit retention — M73', () => {
  it('defaults to one year', async () => {
    const [row] = await db.query<{ audit_retention: string }>(
      `select audit_retention from storage_policy where id = true`,
    );
    expect(row.audit_retention).toBe('one_year');
    expect(RETENTION_DAYS.one_year).toBe(365);
  });

  it('warns that forever grows without limit', () => {
    expect(retentionNotice('forever')).toContain('grows without limit');
    expect(retentionNotice('forever')).toContain('fill the disk');
    expect(retentionNotice('30d')).toContain('30 days');
  });

  it('removes entries past the window and records the sweep', async () => {
    await db.query(
      `insert into events (actor, kind, payload, created_at)
       values ('system', 'test.old', '{}', now() - interval '400 days'),
              ('system', 'test.new', '{}', now())`,
    );
    const { removed } = await runAuditRetention(db);
    expect(removed).toBeGreaterThanOrEqual(1);

    const kinds = await db.query<{ kind: string }>(`select kind from events where kind like 'test.%'`);
    expect(kinds.map((k) => k.kind)).toEqual(['test.new']);

    const [run] = await db.query<{ policy: string; events_removed: number }>(
      `select policy, events_removed from audit_retention_runs`,
    );
    expect(run.policy).toBe('one_year');
    expect(run.events_removed).toBeGreaterThanOrEqual(1);
  });

  // The append-only guarantee is narrowed, not removed. Phase 1's trigger
  // refused this sweep, which is how the conflict surfaced; the fix lets the
  // database permit exactly one deletion — a row already past the window — and
  // nothing else. These assert the "nothing else".
  it('still refuses to delete a recent entry', async () => {
    await db.query(`insert into events (actor, kind, payload) values ('system', 'test.today', '{}')`);
    await expect(db.query(`delete from events where kind = 'test.today'`))
      .rejects.toThrow(/append-only/);
    expect(await db.query(`select 1 from events where kind = 'test.today'`)).toHaveLength(1);
  });

  it('still refuses every update', async () => {
    await db.query(`insert into events (actor, kind, payload) values ('system', 'test.upd', '{}')`);
    await expect(db.query(`update events set kind = 'tampered' where kind = 'test.upd'`))
      .rejects.toThrow(/append-only/);
  });

  it('refuses to delete anything at all under forever', async () => {
    await db.query(`update storage_policy set audit_retention = 'forever'`);
    await db.query(
      `insert into events (actor, kind, payload, created_at)
       values ('system', 'test.old2', '{}', now() - interval '4000 days')`,
    );
    await expect(db.query(`delete from events where kind = 'test.old2'`))
      .rejects.toThrow(/append-only/);
  });

  // The difference between "nothing was deleted" and "the sweep never ran".
  it('records a run even under forever, having deleted nothing', async () => {
    await db.query(`update storage_policy set audit_retention = 'forever'`);
    await db.query(
      `insert into events (actor, kind, payload, created_at)
       values ('system', 'test.ancient', '{}', now() - interval '4000 days')`,
    );
    const { removed } = await runAuditRetention(db);
    expect(removed).toBe(0);
    expect(await db.query(`select 1 from events where kind = 'test.ancient'`)).toHaveLength(1);

    const [run] = await db.query<{ policy: string }>(`select policy from audit_retention_runs`);
    expect(run.policy).toBe('forever');
  });
});
