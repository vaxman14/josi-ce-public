// Memory: durable facts the person curates.
//
// Kept apart from conversation history and from document recall on purpose,
// because the three have different lifetimes and different deletion rules. A
// message is a thing that was said and stays said. A document's text is derived
// data that dies with access to the document. A memory is a fact somebody chose
// to keep, and it dies when they say so.
//
// Two rules do the work:
//
//   1. DELETE MEANS DELETE. There is no `deleted_at` on `memories`. A product
//      whose delete button hides a row is a product that will one day have to
//      explain that. The audit log records that a deletion happened, without
//      the content.
//
//   2. A MEMORY DERIVED FROM A SOURCE DIES WITH THAT SOURCE. Revoking access to
//      a document purges what was learned from it — otherwise "I revoked that"
//      and "it can still tell you what was in it" are both true, which is the
//      worst possible combination.
import { createHash } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export type SourceKind = 'manual' | 'conversation' | 'document' | 'email' | 'contact' | 'calendar';

export class MemoryError extends Error {}

export interface Memory {
  id: string;
  owner_user_id: string;
  content: string;
  source_kind: SourceKind;
  source_id: string | null;
  provenance: string;
  confidence: number;
  pinned: boolean;
  confirmed_at: string | null;
  created_at: string;
}

/** Things a memory must never contain, checked before it is stored.
 *
 * The plan: "Never retain raw passwords, tokens, payment data, or
 * connected-source content by default." The first three are patterns; the
 * fourth is handled by `source_kind`, which is why derived memories are
 * purgeable at all.
 *
 * A refusal here is not a judgement about the person — it is that a durable
 * store of facts is the worst place for a credential, because it is designed to
 * be recalled and repeated. */
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'a password', re: /\b(pass(word|wd)|passphrase)\s*[:=]\s*\S+/i },
  // The same thing said in a sentence. "I always use the password hunter2" has
  // no delimiter, and the pattern above missed it entirely — found by the
  // live-turn test, where a person says such a thing in conversation rather
  // than pasting a config line.
  { name: 'a password', re: /\b(pass(word|wd)|passphrase|api key|secret key|access key)\b[\s:=]+\S{6,}/i },
  { name: 'an API key', re: /\b(sk|pk|api[_-]?key|token)[-_:=]\s*[A-Za-z0-9_-]{16,}/i },
  { name: 'a bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i },
  { name: 'a card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a sealed credential', re: /\bv1\.[A-Za-z0-9+/=]{8,}\./ },
];

export function refuseSecret(content: string): string | null {
  for (const { name, re } of FORBIDDEN) {
    if (re.test(content)) return name;
  }
  return null;
}

/** Stable owner-scoped duplicate key shared with migration imports. */
export function memoryFingerprint(content: string): string {
  // PostgreSQL's built-in md5(text) lets schema upgrades backfill the same key
  // without reading private memories through application code. This is a
  // duplicate key, not a security digest.
  return createHash('md5').update(content.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex');
}

function duplicateMemory(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') return false;
  const constraint = ('constraint' in error && typeof error.constraint === 'string') ? error.constraint
    : ('constraint_name' in error && typeof error.constraint_name === 'string') ? error.constraint_name : '';
  return constraint === 'memories_owner_content_fingerprint';
}

export async function addMemory(
  db: Db,
  args: {
    ownerUserId: string;
    content: string;
    sourceKind?: SourceKind;
    sourceId?: string | null;
    provenance?: string;
    confidence?: number;
  },
): Promise<Memory> {
  const content = args.content.trim();
  if (!content) throw new MemoryError('a memory needs something in it');
  if (content.length > 2000) throw new MemoryError('that is too long to keep as a memory');

  const secret = refuseSecret(content);
  if (secret) {
    throw new MemoryError(
      `that looks like ${secret}. Josi does not keep credentials in memory — they are `
      + 'meant to be recalled and repeated, which is the opposite of what a secret needs.',
    );
  }

  let row: Memory;
  try {
    [row] = await db.query<Memory>(
      `insert into memories
         (owner_user_id, content, source_kind, source_id, provenance, confidence, confirmed_at, content_fingerprint)
       values ($1, $2, $3, $4, $5, $6, case when $3 = 'manual' then now() else null end, $7)
       returning *`,
      [
        args.ownerUserId, content, args.sourceKind ?? 'manual',
        args.sourceKind === 'manual' || !args.sourceKind ? null : args.sourceId ?? null,
        args.provenance ?? 'You added this',
        Math.min(1, Math.max(0, args.confidence ?? 1)), memoryFingerprint(content),
      ],
    );
  } catch (error) {
    // Keep the private memory text out of the generic database-error logger.
    // This exact constraint is the expected result of a normalized duplicate;
    // every other database error still follows the ordinary failure path.
    if (duplicateMemory(error)) {
      throw new MemoryError('that memory already exists');
    }
    throw error;
  }

  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'memory.added',
    subjectType: 'memory',
    subjectId: row.id,
    // The fact that one was added, and where it came from. Never the content —
    // a memory is the person's own private note about themselves.
    payload: { sourceKind: row.source_kind, confidence: row.confidence },
  });
  return row;
}

/** Words too common to say anything about relevance. Deliberately short: a
 * long stop list starts discarding terms that matter in somebody's own
 * vocabulary. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'are', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'can', 'should', 'would', 'could',
  'this', 'that', 'these', 'those', 'with', 'from', 'about', 'into', 'have',
  'has', 'had', 'not', 'but', 'any', 'all', 'get', 'got', 'let', 'now',
  'please', 'thanks', 'tell', 'give', 'want', 'need', 'make', 'does', 'did',
]);

export async function listMemories(db: Db, ownerUserId: string): Promise<Memory[]> {
  return db.query<Memory>(
    `select * from memories where owner_user_id = $1
     order by pinned desc, created_at desc`,
    [ownerUserId],
  );
}

/** Only the owner's, and only what is relevant to this turn.
 *
 * Pinned memories always come; the rest are matched on the request. The plan is
 * explicit that the whole file must not be stuffed into every turn — a memory
 * store that grows without bound would otherwise quietly consume the context
 * window and the person's money. */
export async function relevantMemories(
  db: Db,
  args: { ownerUserId: string; request: string; limit?: number },
): Promise<Memory[]> {
  const limit = Math.min(20, Math.max(1, args.limit ?? 8));
  const query = args.request.trim();

  const pinned = await db.query<Memory>(
    `select * from memories where owner_user_id = $1 and pinned = true
     order by created_at desc limit $2`,
    [args.ownerUserId, limit],
  );
  if (!query || pinned.length >= limit) return pinned.slice(0, limit);

  // ANY salient term, ranked — not every term.
  //
  // `websearch_to_tsquery` ANDs what it is given, so the natural request "where
  // should I go sailing?" becomes `go & sail` and fails to match a memory about
  // sailing that does not also mention going. A question is not a search query,
  // and requiring every word of one is why the first version of this retrieved
  // nothing in a live turn.
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 8);
  if (!terms.length) return pinned.slice(0, limit);

  const anyOf = terms.join(' or ');
  const matched = await db.query<Memory>(
    `select * from memories
     where owner_user_id = $1
       and pinned = false
       and to_tsvector('english', content) @@ websearch_to_tsquery('english', $2)
     order by ts_rank(to_tsvector('english', content),
                      websearch_to_tsquery('english', $2)) desc,
              created_at desc
     limit $3`,
    [args.ownerUserId, anyOf, limit - pinned.length],
  ).catch(() => [] as Memory[]);

  return [...pinned, ...matched];
}

export async function updateMemory(
  db: Db,
  args: { id: string; ownerUserId: string; content?: string; pinned?: boolean },
): Promise<Memory> {
  if (args.content !== undefined) {
    const secret = refuseSecret(args.content);
    if (secret) throw new MemoryError(`that looks like ${secret}, so it was not saved.`);
  }
  let row: Memory;
  try {
    [row] = await db.query<Memory>(
      `update memories set
         content = coalesce($3, content),
         pinned = coalesce($4, pinned),
         content_fingerprint = case when $3 is null then content_fingerprint else $5 end
       where id = $1 and owner_user_id = $2
       returning *`,
      [args.id, args.ownerUserId, args.content ?? null, args.pinned ?? null,
        args.content === undefined ? null : memoryFingerprint(args.content)],
    );
  } catch (error) {
    if (duplicateMemory(error)) throw new MemoryError('that memory already exists');
    throw error;
  }
  // 404, not 403 — the Phase 1 rule. Somebody else's memory is not theirs to
  // know exists.
  if (!row) throw new MemoryError('not found');
  return row;
}

/** Confirming says "this is still true", which is what makes confidence mean
 * something over time rather than being a number set once. */
export async function confirmMemory(
  db: Db, args: { id: string; ownerUserId: string },
): Promise<Memory> {
  const [row] = await db.query<Memory>(
    `update memories set confirmed_at = now(), confidence = 1.0
     where id = $1 and owner_user_id = $2 returning *`,
    [args.id, args.ownerUserId],
  );
  if (!row) throw new MemoryError('not found');
  return row;
}

/** Gone. Not hidden. */
export async function deleteMemory(
  db: Db, args: { id: string; ownerUserId: string },
): Promise<void> {
  const [row] = await db.query<{ id: string; source_kind: string }>(
    `delete from memories where id = $1 and owner_user_id = $2 returning id, source_kind`,
    [args.id, args.ownerUserId],
  );
  if (!row) throw new MemoryError('not found');
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'memory.deleted',
    subjectType: 'memory',
    subjectId: row.id,
    payload: { sourceKind: row.source_kind },
  });
}

/**
 * Revoking a source purges what was learned from it.
 *
 * "Leaving unrelated conversation history intact" is the other half of the
 * plan's sentence, and it is why this is keyed on `source_id` rather than
 * sweeping everything of a kind: revoking one document must not forget what
 * another taught.
 */
export async function purgeMemoriesForSource(
  db: Db,
  args: { ownerUserId: string; sourceKind: SourceKind; sourceId: string },
): Promise<{ purged: number }> {
  const rows = await db.query<{ id: string }>(
    `delete from memories
     where owner_user_id = $1 and source_kind = $2 and source_id = $3
     returning id`,
    [args.ownerUserId, args.sourceKind, args.sourceId],
  );
  await db.query(
    `delete from memory_suggestions
     where owner_user_id = $1 and source_kind = $2 and source_id = $3`,
    [args.ownerUserId, args.sourceKind, args.sourceId],
  );
  if (rows.length) {
    await appendEvent(db, {
      actorUserId: args.ownerUserId,
      actor: 'system',
      kind: 'memory.purged_with_source',
      subjectType: 'memory',
      payload: { sourceKind: args.sourceKind, purged: rows.length },
    });
  }
  return { purged: rows.length };
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * A suggestion is not a memory.
 *
 * The separation is the control. An assistant that writes straight to memory
 * can be talked into remembering something false about its owner, permanently,
 * from one message — and the person would have no idea it happened. So the
 * default is that a suggestion waits for a human, and automatic mode is
 * something somebody has to turn on knowing what it does.
 */
export async function suggestMemory(
  db: Db,
  args: {
    ownerUserId: string; content: string; sourceKind: Exclude<SourceKind, 'manual'>;
    sourceId?: string | null; confidence?: number;
  },
): Promise<{ suggested: boolean; auto: boolean; reason?: string }> {
  const content = args.content.trim();
  if (!content) return { suggested: false, auto: false, reason: 'empty' };

  const secret = refuseSecret(content);
  if (secret) {
    // Never stored, not even as a suggestion: a pending suggestion is still a
    // row in the database holding a credential.
    return { suggested: false, auto: false, reason: `it looked like ${secret}` };
  }

  const [settings] = await db.query<{ memory_mode: string }>(
    `select memory_mode from persona_settings where user_id = $1`,
    [args.ownerUserId],
  );
  const mode = settings?.memory_mode ?? 'manual';
  if (mode === 'off') return { suggested: false, auto: false, reason: 'memory is switched off' };

  if (mode === 'automatic') {
    await addMemory(db, {
      ownerUserId: args.ownerUserId,
      content,
      sourceKind: args.sourceKind,
      sourceId: args.sourceId ?? null,
      provenance: `Learned from a ${args.sourceKind}`,
      confidence: args.confidence ?? 0.6,
    });
    return { suggested: true, auto: true };
  }

  await db.query(
    `insert into memory_suggestions (owner_user_id, content, source_kind, source_id, confidence)
     values ($1, $2, $3, $4, $5)`,
    [args.ownerUserId, content, args.sourceKind, args.sourceId ?? null, args.confidence ?? 0.5],
  );
  return { suggested: true, auto: false };
}

export async function decideSuggestion(
  db: Db,
  args: { id: string; ownerUserId: string; accept: boolean },
): Promise<{ memory: Memory | null }> {
  const [row] = await db.query<{
    content: string; source_kind: SourceKind; source_id: string | null; confidence: number;
  }>(
    `update memory_suggestions set state = $3, decided_at = now()
     where id = $1 and owner_user_id = $2 and state = 'pending'
     returning content, source_kind, source_id, confidence`,
    [args.id, args.ownerUserId, args.accept ? 'accepted' : 'rejected'],
  );
  if (!row) throw new MemoryError('not found');
  if (!args.accept) return { memory: null };

  const memory = await addMemory(db, {
    ownerUserId: args.ownerUserId,
    content: row.content,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    provenance: `You approved this, learned from a ${row.source_kind}`,
    confidence: row.confidence,
  });
  return { memory };
}
