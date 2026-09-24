// Search: what it finds, whose it finds, and what leaves the server.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import {
  SEMANTIC_DISCLOSURE, SemanticForbidden, SemanticNotConsented,
  assertSemanticAllowed, citationLabel, cosine, decodeVector, encodeVector,
  recordSemanticConsent, resolveCitations, revokeSemanticConsent, searchDocuments,
} from '../src/search.js';
import {
  blockedReason, claimNext, concurrencyFor, enqueue, finishJob, setGlobalPause,
} from '../src/queue.js';

let db: TestDb;
const ids: Record<string, string> = {};
const maps: Record<string, string> = {};

const ALICE_TEXT = 'The quarterly revenue projection for the northern region exceeded forecast.';
const BOB_TEXT = 'The quarterly revenue projection for the southern region fell short.';

beforeAll(async () => {
  db = await testDb();
  for (const [name, role] of [['admin', 'super_admin'], ['alice', 'member'], ['bob', 'member']] as const) {
    const [u] = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ($1, $2, $3) returning id`,
      [`${name}@example.test`, name, role],
    );
    ids[name] = u.id;
  }
  const [root] = await db.query<{ id: string }>(
    `insert into storage_roots (container_path, label) values ('/data/roots/docs', 'Docs') returning id`,
  );
  for (const who of ['alice', 'bob']) {
    const [m] = await db.query<{ id: string }>(
      `insert into folder_mappings (owner_user_id, provider, root_id, display_path)
       values ($1, 'local', $2, 'Docs') returning id`,
      [ids[who], root.id],
    );
    maps[who] = m.id;
  }
});

beforeEach(async () => {
  await db.query(`delete from message_citations`);
  await db.query(`delete from document_embeddings`);
  await db.query(`delete from semantic_consents`);
  await db.query(`delete from documents`);
  await db.query(`update storage_policy set semantic_enabled = false, processing_paused = false,
                    ocr_enabled = false, ocr_max_concurrency = 1,
                    ocr_hours_start = null, ocr_hours_end = null`);
  await db.query(`update security_policy set local_only = false`);
  await db.query(`update folder_mappings set status = 'active'`);
});

async function addDoc(who: 'alice' | 'bob', args: {
  filename?: string; text: string; locator?: string; locatorKind?: string; state?: string;
}): Promise<string> {
  const [doc] = await db.query<{ id: string }>(
    `insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
     values ($1, $2, $3, $3, $4) returning id`,
    [maps[who], ids[who], args.filename ?? `${who}-report.pdf`, args.state ?? 'indexed'],
  );
  await db.query(
    `insert into document_text (document_id, owner_user_id, content, char_count)
     values ($1, $2, $3, $4)`,
    [doc.id, ids[who], args.text, args.text.length],
  );
  await db.query(
    `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
     values ($1, $2, 0, $3, $4, $5)`,
    [doc.id, ids[who], args.locatorKind ?? 'page', args.locator ?? '4', args.text],
  );
  return doc.id;
}

describe('full-text search is owner-scoped — M68', () => {
  beforeEach(async () => {
    await addDoc('alice', { text: ALICE_TEXT });
    await addDoc('bob', { text: BOB_TEXT });
  });

  it('finds your own document', async () => {
    const hits = await searchDocuments(db, { ownerUserId: ids.alice, query: 'revenue projection' });
    expect(hits).toHaveLength(1);
    expect(hits[0].filename).toBe('alice-report.pdf');
  });

  // The most direct possible failure of M68 would be a search that crosses
  // owners, so it is asserted from both sides.
  it('never returns a colleague\'s document, however well it matches', async () => {
    const alice = await searchDocuments(db, { ownerUserId: ids.alice, query: 'southern region' });
    expect(alice).toHaveLength(0);

    const bob = await searchDocuments(db, { ownerUserId: ids.bob, query: 'northern region' });
    expect(bob).toHaveLength(0);
  });

  it('returns nothing for the administrator, who owns none of it', async () => {
    const hits = await searchDocuments(db, { ownerUserId: ids.admin, query: 'revenue' });
    expect(hits).toHaveLength(0);
  });

  it('takes what a person actually types without erroring', async () => {
    // `to_tsquery` raises a syntax error on ordinary punctuation, and an error
    // from a search box is a way to probe. `websearch_to_tsquery` does not.
    for (const q of ['q3 (draft)', 'revenue & !', '"northern region"', 'a|b', ':*']) {
      await expect(
        searchDocuments(db, { ownerUserId: ids.alice, query: q }),
        q,
      ).resolves.toBeDefined();
    }
  });

  it('does not search a blocked or skipped document', async () => {
    await db.query(`update documents set state = 'blocked' where owner_user_id = $1`, [ids.alice]);
    expect(await searchDocuments(db, { ownerUserId: ids.alice, query: 'revenue' })).toHaveLength(0);
  });

  it('does not search a revoked mapping, but does search a paused one', async () => {
    await db.query(`update folder_mappings set status = 'revoked' where id = $1`, [maps.alice]);
    expect(await searchDocuments(db, { ownerUserId: ids.alice, query: 'revenue' })).toHaveLength(0);

    // M78: pausing keeps the index usable. Losing search every time a token
    // lapses would be a far worse outcome than a paused folder.
    await db.query(`update folder_mappings set status = 'paused' where id = $1`, [maps.alice]);
    expect(await searchDocuments(db, { ownerUserId: ids.alice, query: 'revenue' })).toHaveLength(1);
  });

  it('can be narrowed to one folder without losing the owner scope', async () => {
    const hits = await searchDocuments(db, {
      ownerUserId: ids.alice, query: 'revenue', mappingId: maps.bob,
    });
    expect(hits).toHaveLength(0);
  });
});

describe('citations — M67', () => {
  it('name the file and the most precise locator', () => {
    expect(citationLabel({ filename: 'r.pdf', locator: '4', locatorKind: 'page' }))
      .toBe('r.pdf, page 4');
    expect(citationLabel({ filename: 'b.xlsx', locator: 'Sheet1!B12', locatorKind: 'sheet' }))
      .toBe('b.xlsx — Sheet1!B12');
    expect(citationLabel({ filename: 'd.pptx', locator: '9', locatorKind: 'slide' }))
      .toBe('d.pptx, slide 9');
    expect(citationLabel({ filename: 'n.txt', locator: '', locatorKind: 'none' }))
      .toBe('n.txt');
  });

  it('carry the locator through a search', async () => {
    await addDoc('alice', { text: ALICE_TEXT, locator: '12', locatorKind: 'page' });
    const [hit] = await searchDocuments(db, { ownerUserId: ids.alice, query: 'forecast' });
    expect(citationLabel(hit)).toContain('page 12');
  });
});

describe('revoking access makes citations unavailable without rewriting history — M71', () => {
  let messageId: string;
  let documentId: string;

  beforeEach(async () => {
    const [t] = await db.query<{ id: string }>(
      `insert into threads (owner_user_id, title) values ($1, 'T') returning id`, [ids.alice],
    );
    const [m] = await db.query<{ id: string }>(
      `insert into messages (thread_id, direction, body)
       values ($1, 'out', 'According to your report, revenue exceeded forecast.') returning id`,
      [t.id],
    );
    messageId = m.id;
    documentId = await addDoc('alice', { text: ALICE_TEXT });
    await db.query(
      `insert into message_citations
         (message_id, document_id, owner_user_id, filename_at_time, locator)
       values ($1, $2, $3, 'alice-report.pdf', '4')`,
      [messageId, documentId, ids.alice],
    );
  });

  it('offers to open the source while access remains', async () => {
    const [c] = await resolveCitations(db, { messageId, viewerUserId: ids.alice });
    expect(c.canOpen).toBe(true);
    expect(c.filename).toBe('alice-report.pdf');
  });

  it('stops offering it once the document is purged, and says what it was', async () => {
    await db.query(`delete from documents where id = $1`, [documentId]);
    const [c] = await resolveCitations(db, { messageId, viewerUserId: ids.alice });
    expect(c.canOpen).toBe(false);
    expect(c.documentId).toBeNull();
    // The citation still NAMES the file. M71 is explicit that already-sent
    // messages are not silently rewritten.
    expect(c.filename).toBe('alice-report.pdf');

    const [msg] = await db.query<{ body: string }>(
      `select body from messages where id = $1`, [messageId],
    );
    expect(msg.body).toContain('revenue exceeded forecast');
  });

  it('stops offering it when the mapping is revoked', async () => {
    await db.query(`update folder_mappings set status = 'revoked' where id = $1`, [maps.alice]);
    const [c] = await resolveCitations(db, { messageId, viewerUserId: ids.alice });
    expect(c.canOpen).toBe(false);
  });

  it('never offers it to somebody else', async () => {
    const [c] = await resolveCitations(db, { messageId, viewerUserId: ids.bob });
    expect(c.canOpen).toBe(false);
  });
});

describe('semantic search is opt-in and forbidden in Local-only — M51', () => {
  it('is refused when the administrator has not enabled it', async () => {
    await expect(assertSemanticAllowed(db, ids.alice)).rejects.toThrow(SemanticForbidden);
  });

  it('still needs the person to agree once enabled', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await expect(assertSemanticAllowed(db, ids.alice)).rejects.toThrow(SemanticNotConsented);
  });

  it('works when both are true', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await recordSemanticConsent(db, { userId: ids.alice, provider: 'openai' });
    await expect(assertSemanticAllowed(db, ids.alice)).resolves.toBeUndefined();
  });

  // The installation-wide promise beats an individual's consent. A person
  // cannot agree to send data out of an installation that says nothing does.
  it('is refused in Local-only even with the policy on and consent given', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await recordSemanticConsent(db, { userId: ids.alice, provider: 'openai' });
    await db.query(`update security_policy set local_only = true`);

    await expect(assertSemanticAllowed(db, ids.alice)).rejects.toThrow(SemanticForbidden);
    await expect(assertSemanticAllowed(db, ids.alice)).rejects.toThrow(/Local-only/);
  });

  it('will not even record consent in Local-only', async () => {
    await db.query(`update security_policy set local_only = true`);
    await expect(recordSemanticConsent(db, { userId: ids.alice, provider: 'openai' }))
      .rejects.toThrow(SemanticForbidden);
    expect(await db.query(`select 1 from semantic_consents`)).toHaveLength(0);
  });

  it('the disclosure says the text leaves the server', () => {
    expect(SEMANTIC_DISCLOSURE).toContain('leaves this server');
    expect(SEMANTIC_DISCLOSURE).toContain('Full-text search does not');
  });

  it('one person\'s consent is not another\'s', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await recordSemanticConsent(db, { userId: ids.alice, provider: 'openai' });
    await expect(assertSemanticAllowed(db, ids.bob)).rejects.toThrow(SemanticNotConsented);
  });

  it('withdrawing consent destroys the vectors', async () => {
    await db.query(`update storage_policy set semantic_enabled = true`);
    await recordSemanticConsent(db, { userId: ids.alice, provider: 'openai' });
    const docId = await addDoc('alice', { text: ALICE_TEXT });
    await db.query(
      `insert into document_embeddings (document_id, owner_user_id, model, dimensions, vector)
       values ($1, $2, 'm', 3, $3)`,
      [docId, ids.alice, encodeVector([1, 2, 3])],
    );

    const { embeddings } = await revokeSemanticConsent(db, ids.alice);
    expect(embeddings).toBe(1);
    expect(await db.query(`select 1 from document_embeddings`)).toHaveLength(0);
    await expect(assertSemanticAllowed(db, ids.alice)).rejects.toThrow(SemanticNotConsented);
  });
});

describe('vectors survive a database round trip', () => {
  it('encode and decode to the same numbers', async () => {
    const values = [0.5, -0.25, 1, 0];
    const [row] = await db.query<{ vector: Buffer }>(
      `insert into document_embeddings (document_id, owner_user_id, model, dimensions, vector)
       values ($1, $2, 'm', 4, $3) returning vector`,
      [await addDoc('alice', { text: 'x' }), ids.alice, encodeVector(values)],
    );
    expect([...decodeVector(row.vector)]).toEqual(values);
  });

  it('cosine is 1 for identical and 0 for orthogonal', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(cosine(a, new Float32Array([1, 0, 0]))).toBeCloseTo(1);
    expect(cosine(a, new Float32Array([0, 1, 0]))).toBeCloseTo(0);
    expect(cosine(a, new Float32Array([1, 0]))).toBe(0);
  });
});

describe('the queue — M52, M53, M75', () => {
  const POLICY = {
    processing_paused: false, ocr_enabled: true, ocr_max_concurrency: 1,
    ocr_hours_start: null, ocr_hours_end: null,
  };

  it('OCR is refused when disabled, with no way for a user to override', async () => {
    expect(blockedReason({ ...POLICY, ocr_enabled: false }, { kind: 'ocr', hour: 12 }))
      .toBe('unreadable');
    // M52: "users cannot override". The strongest available proof is that no
    // per-user OCR column exists to override with.
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'storage_capabilities'`,
    );
    expect(cols.map((c) => c.column_name).filter((c) => c.includes('ocr'))).toHaveLength(0);
  });

  it('honours the hour window', () => {
    const p = { ...POLICY, ocr_hours_start: 22, ocr_hours_end: 6 };
    expect(blockedReason(p, { kind: 'ocr', hour: 23 })).toBeNull();
    expect(blockedReason(p, { kind: 'ocr', hour: 12 })).toBe('out_of_hours');
    // Only OCR is restricted to hours; cheap work is not.
    expect(blockedReason(p, { kind: 'extract', hour: 12 })).toBeNull();
  });

  it('the global pause stops every kind of new work — M75', () => {
    const p = { ...POLICY, processing_paused: true };
    for (const kind of ['extract', 'ocr', 'scan', 'index'] as const) {
      expect(blockedReason(p, { kind, hour: 12 }), kind).toBe('paused');
    }
  });

  it('the global pause does not delete anything, and search still answers', async () => {
    await addDoc('alice', { text: ALICE_TEXT });
    await setGlobalPause(db, { paused: true, byUserId: ids.admin });

    const [policy] = await db.query<{ processing_paused: boolean }>(
      `select processing_paused from storage_policy where id = true`,
    );
    expect(policy.processing_paused).toBe(true);
    // The point of M75.
    expect(await searchDocuments(db, { ownerUserId: ids.alice, query: 'revenue' })).toHaveLength(1);
    expect(await db.query(`select 1 from document_text`)).toHaveLength(1);
  });

  it('OCR gets its own concurrency ceiling', () => {
    expect(concurrencyFor({ ...POLICY, ocr_max_concurrency: 1 }, 'ocr')).toBe(1);
    expect(concurrencyFor({ ...POLICY, ocr_max_concurrency: 4 }, 'ocr')).toBe(4);
  });

  it('refuses to queue the same work twice while it is live', async () => {
    const docId = await addDoc('alice', { text: 'x' });
    const first = await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'ocr' });
    const second = await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'ocr' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await db.query(`select 1 from processing_jobs`)).toHaveLength(1);
  });

  it('allows re-queueing once the first finished', async () => {
    const docId = await addDoc('alice', { text: 'x' });
    const first = await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'ocr' });
    await finishJob(db, { jobId: first.id, state: 'done' });
    const second = await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'ocr' });
    expect(second.created).toBe(true);
  });

  it('claims nothing while paused', async () => {
    const docId = await addDoc('alice', { text: 'x' });
    await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'extract' });
    const claimed = await claimNext(db, {
      policy: { ...POLICY, processing_paused: true }, kind: 'extract', hour: 12,
    });
    expect(claimed).toBeNull();
  });

  it('claims nothing beyond the concurrency ceiling', async () => {
    for (const name of ['a', 'b']) {
      const docId = await addDoc('alice', { filename: `${name}.pdf`, text: 'x' });
      await enqueue(db, { documentId: docId, ownerUserId: ids.alice, kind: 'ocr' });
    }
    const first = await claimNext(db, { policy: POLICY, kind: 'ocr', hour: 12 });
    expect(first).not.toBeNull();
    const second = await claimNext(db, { policy: POLICY, kind: 'ocr', hour: 12 });
    expect(second).toBeNull();
  });
});
