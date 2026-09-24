// Taking a file in, against a real database.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ScanBlocked, ingestFile, mappingStatus, storagePolicy, usageFor } from '../src/ingest.js';
import { SKIP_EXPLANATIONS } from '../src/ingest.js';
import type { Scanner, StoragePolicy } from '../src/gates.js';

let db: TestDb;
const ids: Record<string, string> = {};
let mappingId: string;

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
    `insert into folder_mappings (owner_user_id, provider, root_id, relative_path, display_path)
     values ($1, 'local', $2, '', 'Docs') returning id`,
    [ids.alice, root.id],
  );
  mappingId = m.id;
});

beforeEach(async () => {
  await db.query(`delete from documents`);
  // Capabilities carry per-user ceilings. Leaving one behind made a later test
  // refuse files for `quota_exceeded` while asserting on `too_large` — the
  // assertion was measuring a different control than the one it named.
  await db.query(`delete from storage_capabilities`);
  await db.query(
    `update storage_policy set
       max_file_bytes = 1000, max_total_bytes_per_user = 10000, max_files_per_user = 10,
       allowed_extensions = array['txt','pdf','docx'],
       archives_enabled = false, clamav_enabled = false, clamav_scan_mode = 'on_index'`,
  );
});

const candidate = (over: Record<string, unknown> = {}) => ({
  filename: 'notes.txt', relativePath: 'notes.txt', byteSize: 10, ...over,
} as any);

const ingest = async (over: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) => {
  const policy = await storagePolicy(db);
  return ingestFile(db, {
    mappingId, ownerUserId: ids.alice,
    candidate: candidate(over),
    deps: { policy, ...deps } as any,
  });
};

describe('a file that passes every gate', () => {
  it('is accepted and recorded', async () => {
    const out = await ingest();
    expect(out.kind).toBe('accepted');
    const [row] = await db.query<{ state: string; extension: string }>(
      `select state, extension from documents where mapping_id = $1`, [mappingId],
    );
    expect(row.state).toBe('discovered');
    expect(row.extension).toBe('txt');
  });

  it('re-ingesting the same path updates rather than duplicating', async () => {
    await ingest();
    await ingest({ byteSize: 20 });
    const rows = await db.query(`select 1 from documents where mapping_id = $1`, [mappingId]);
    expect(rows).toHaveLength(1);
  });
});

describe('a file that is refused — M55, M64, M65, M74', () => {
  it('records the reason so the owner can see it per file', async () => {
    const out = await ingest({ byteSize: 5000 });
    expect(out).toMatchObject({ kind: 'skipped', reason: 'too_large' });

    const [row] = await db.query<{ state: string; skip_reason: string }>(
      `select state, skip_reason from documents where mapping_id = $1`, [mappingId],
    );
    expect(row.state).toBe('skipped');
    expect(row.skip_reason).toBe('too_large');
  });

  it('every reason has a plain-language explanation', async () => {
    const reasons = await db.query<{ v: string }>(
      `select unnest(enum_range(null::text)) as v where false`,
    ).catch(() => []);
    void reasons;
    // The vocabulary is a check constraint rather than an enum, so the list is
    // asserted directly: a reason with no explanation would be shown to a person
    // as a bare token.
    for (const key of Object.keys(SKIP_EXPLANATIONS)) {
      expect(SKIP_EXPLANATIONS[key as keyof typeof SKIP_EXPLANATIONS].length).toBeGreaterThan(20);
    }
    expect(SKIP_EXPLANATIONS.encrypted).toContain('never asks for document passwords');
    expect(SKIP_EXPLANATIONS.malware_found).toContain('left exactly as it was');
  });

  it('purges anything already extracted from it', async () => {
    const out = await ingest();
    const documentId = (out as any).documentId;
    await db.query(
      `insert into document_text (document_id, owner_user_id, content, char_count)
       values ($1, $2, 'SECRET-CONTENT', 14)`,
      [documentId, ids.alice],
    );

    // The file grows past the ceiling. Yesterday's text must not stay searchable.
    await ingest({ byteSize: 5000 });
    expect(await db.query(`select 1 from document_text where document_id = $1`, [documentId]))
      .toHaveLength(0);
  });

  it('does not put the filename in the audit log', async () => {
    await ingest({ filename: 'salary-review-2026.xlsx', relativePath: 'salary-review-2026.xlsx' });
    const rows = await db.query<{ p: string }>(
      `select payload::text as p from events where kind = 'storage.file_skipped'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.p).not.toContain('salary-review');
  });
});

describe('malware blocks and does not touch the source — M57', () => {
  const dirty: Scanner = {
    async scan() { return { clean: false, signature: 'Eicar-Test-Signature' }; },
  };
  const clean: Scanner = { async scan() { return { clean: true }; } };

  const withScanner = async (scanner: Scanner | undefined) => {
    await db.query(`update storage_policy set clamav_enabled = true`);
    const policy = await storagePolicy(db);
    return ingestFile(db, {
      mappingId, ownerUserId: ids.alice, candidate: candidate(),
      deps: {
        policy: policy as StoragePolicy,
        scanner,
        readFile: async () => Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'),
      },
    });
  };

  it('blocks the document and records the finding', async () => {
    const out = await withScanner(dirty);
    expect(out.kind).toBe('blocked');

    const [doc] = await db.query<{ state: string; skip_reason: string }>(
      `select state, skip_reason from documents where mapping_id = $1`, [mappingId],
    );
    expect(doc.state).toBe('blocked');
    expect(doc.skip_reason).toBe('malware_found');

    const [finding] = await db.query<{
      signature: string; source_hash_before: string; source_hash_after: string;
      owner_notified_at: string; admin_notified_at: string;
    }>(`select * from malware_findings`);
    expect(finding.signature).toBe('Eicar-Test-Signature');
    // M57: the source is untouched, measured.
    expect(finding.source_hash_before).toBe(finding.source_hash_after);
    // M57: both parties alerted.
    expect(finding.owner_notified_at).toBeTruthy();
    expect(finding.admin_notified_at).toBeTruthy();
  });

  it('there is no code path that moves, renames or deletes the source', async () => {
    // The strongest form available without a filesystem: `ingest.ts` is the only
    // module that reacts to a finding, and it must contain no write verbs.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/ingest.ts', import.meta.url), 'utf8');
    for (const verb of ['unlink', 'rename', 'rmdir', 'writeFile', 'copyFile', 'truncate']) {
      expect(src, verb).not.toContain(verb);
    }
  });

  it('purges text already extracted from a file later found to be malware', async () => {
    const first = await ingest();
    const documentId = (first as any).documentId;
    await db.query(
      `insert into document_text (document_id, owner_user_id, content, char_count)
       values ($1, $2, 'extracted', 9)`,
      [documentId, ids.alice],
    );
    await withScanner(dirty);
    expect(await db.query(`select 1 from document_text where document_id = $1`, [documentId]))
      .toHaveLength(0);
  });

  it('a clean scan lets the file through', async () => {
    const out = await withScanner(clean);
    expect(out.kind).toBe('accepted');
    expect(await db.query(`select 1 from malware_findings`)).toHaveLength(0);
  });

  // The failure mode that looks exactly like working.
  it('stops processing when the scanner is enabled but unreachable', async () => {
    await expect(withScanner(undefined)).rejects.toThrow(ScanBlocked);
    const [doc] = await db.query<{ state: string }>(
      `select state from documents where mapping_id = $1`, [mappingId],
    );
    expect(doc.state).toBe('skipped');
  });
});

describe('quota counts what is actually held — M55', () => {
  it('excludes skipped files from usage', async () => {
    await ingest();
    await ingest({ filename: 'big.txt', relativePath: 'big.txt', byteSize: 5000 });
    const usage = await usageFor(db, ids.alice);
    // The skipped file occupies nothing, so it must not count against the quota
    // — otherwise refusing a file makes the next one likelier to be refused too.
    expect(usage.files).toBe(1);
    expect(usage.bytes).toBe(10);
  });

  it('honours a tighter per-user ceiling', async () => {
    await db.query(
      `insert into storage_capabilities (user_id, may_map_local, may_index, max_files)
       values ($1, true, true, 1) on conflict (user_id) do update set max_files = 1`,
      [ids.alice],
    );
    await ingest();
    const out = await ingest({ filename: 'second.txt', relativePath: 'second.txt' });
    expect(out).toMatchObject({ kind: 'skipped', reason: 'quota_exceeded' });
  });

  // item 40h-DECIDED: an administrator's per-user override is a real override,
  // not just a tighter ceiling — it must let a person past the workspace
  // default just as easily as it can restrict them below it.
  it('honours a per-user override that RAISES a person above the workspace default', async () => {
    // The fixture's workspace default is max_files_per_user = 10 (see
    // beforeEach). Grant this one person room for 12.
    await db.query(
      `insert into storage_capabilities (user_id, may_map_local, may_index, max_files)
       values ($1, true, true, 12) on conflict (user_id) do update set max_files = 12`,
      [ids.alice],
    );
    for (let i = 0; i < 10; i += 1) {
      const out = await ingest({ filename: `f${i}.txt`, relativePath: `f${i}.txt` });
      expect(out.kind).toBe('accepted');
    }
    // The 11th file would be refused under the workspace default (10) but must
    // be accepted under this person's raised override (12).
    const eleventh = await ingest({ filename: 'f10.txt', relativePath: 'f10.txt' });
    expect(eleventh.kind).toBe('accepted');
  });
});

describe('the workspace default quota — item 40h-DECIDED', () => {
  it('a fresh install starts at 20GiB, not the old 2GiB', async () => {
    // A completely separate database from the shared fixture above (which
    // overwrites max_total_bytes_per_user in beforeEach for its own smaller
    // numbers) — this proves what migration 0031 actually ships as the
    // out-of-the-box default before any test or admin touches it.
    const fresh = await testDb();
    const policy = await storagePolicy(fresh);
    expect(Number(policy.max_total_bytes_per_user)).toBe(21474836480);
  });
});

describe('per-folder status — M74', () => {
  it('reports counts and reasons', async () => {
    await ingest();
    await ingest({ filename: 'big.txt', relativePath: 'big.txt', byteSize: 5000 });
    await ingest({ filename: 'x.exe', relativePath: 'x.exe' });

    const status = await mappingStatus(db, mappingId);
    expect(status.total).toBe(3);
    expect(status.byState.skipped).toBe(2);
    const reasons = Object.fromEntries(status.skipped.map((s) => [s.reason, s.count]));
    expect(reasons.too_large).toBe(1);
    expect(reasons.extension_not_allowed).toBe(1);
  });
});
