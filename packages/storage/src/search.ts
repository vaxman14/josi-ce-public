// Searching documents.
//
// M51 sets the shape: PostgreSQL full-text search by default, semantic optional,
// and external embeddings FORBIDDEN when the installation is in Local-only mode.
//
// The default is the security decision. Full-text search runs entirely inside
// the database — no model, no network, nothing leaving the host. Semantic search
// answers some questions better and requires sending the text of somebody's
// documents to an embedding service. Making the private one the default and the
// leaky one an explicit, disclosed opt-in is the whole difference.
//
// Local-only is not advisory. `assertSemanticAllowed` reads the same
// `security_policy.local_only` flag Phase 4 introduced for model providers,
// because an installation that promised nothing leaves the host cannot have one
// subsystem quietly exempt.
import { appendEvent, type Db } from '@josi-ce/core';

export class SemanticForbidden extends Error {}
export class SemanticNotConsented extends Error {}

export interface SearchHit {
  documentId: string;
  segmentId: string | null;
  filename: string;
  relativePath: string;
  mappingId: string;
  /** M67: the most precise locator available — page, sheet, slide, heading. */
  locator: string;
  locatorKind: string;
  snippet: string;
  rank: number;
  fromOcr: boolean;
}

/**
 * Full-text search over one person's documents.
 *
 * `ownerUserId` is not a filter that a caller may omit — it is a required
 * argument, and every query below uses it. A search endpoint that can be made
 * to return another person's documents is the most direct possible failure of
 * M68, and the shape of this function is what makes forgetting it impossible.
 */
export async function searchDocuments(
  db: Db,
  args: {
    ownerUserId: string;
    query: string;
    limit?: number;
    /** Restrict to one folder. Still owner-scoped regardless. */
    mappingId?: string | null;
  },
): Promise<SearchHit[]> {
  const query = args.query.trim();
  if (!query) return [];
  const limit = Math.min(50, Math.max(1, args.limit ?? 10));

  // `websearch_to_tsquery` rather than `to_tsquery`: it takes what a person
  // actually types, including quotes and OR, and cannot be made to throw by
  // punctuation. `to_tsquery` raises a syntax error on ordinary input like
  // "q3 (draft)", and an error message from a search box is a way to probe.
  return db.query<SearchHit>(
    `select
       s.document_id            as "documentId",
       s.id                     as "segmentId",
       d.filename               as filename,
       d.relative_path          as "relativePath",
       d.mapping_id             as "mappingId",
       s.locator                as locator,
       s.locator_kind           as "locatorKind",
       ts_headline('english', s.content, websearch_to_tsquery('english', $2),
                   'MaxFragments=1, MaxWords=30, MinWords=10') as snippet,
       ts_rank(s.search_vector, websearch_to_tsquery('english', $2)) as rank,
       s.from_ocr               as "fromOcr"
     from document_segments s
     join documents d on d.id = s.document_id
     join folder_mappings m on m.id = d.mapping_id
     left join sync_state ss on ss.mapping_id = m.id
     where s.owner_user_id = $1
       and s.search_vector @@ websearch_to_tsquery('english', $2)
       -- A blocked or skipped document must not be searchable: its text should
       -- already be gone, and this is the second line of that defence.
       and d.state not in ('blocked', 'skipped')
       -- A paused mapping keeps its index (M78), but a REVOKED one is on its way
       -- out and must not answer.
       and m.status <> 'revoked'
       -- A partial first walk is not an authoritative index. Until a cloud
       -- mapping completes once, its scraps must not answer search queries as
       -- though Josi has a current view of that folder.
       and (m.provider = 'local' or ss.mapping_id is null or ss.last_sync_at is not null)
       and ($3::uuid is null or d.mapping_id = $3::uuid)
     order by rank desc, d.filename
     limit $4`,
    [args.ownerUserId, query, args.mappingId ?? null, limit],
  );
}

/** M67: what a citation says.
 *
 * File name plus the most precise locator the format gave us. "Open source" is
 * offered only when the person still has access — which is checked at display
 * time, not stored, so revocation takes effect immediately (M71). */
export function citationLabel(hit: {
  filename: string; locator: string; locatorKind: string;
}): string {
  if (!hit.locator || hit.locatorKind === 'none') return hit.filename;
  const prefix = {
    page: 'page', sheet: '', slide: 'slide', heading: '', line: 'line',
  }[hit.locatorKind] ?? '';
  return prefix ? `${hit.filename}, ${prefix} ${hit.locator}` : `${hit.filename} — ${hit.locator}`;
}

export interface ResolvedCitation {
  filename: string;
  locator: string;
  /** M67/M71: false once the document is gone or access was revoked. The
   * message is not rewritten; the link simply stops being offered. */
  canOpen: boolean;
  documentId: string | null;
}

/**
 * M71 in one function.
 *
 * Citations are resolved at DISPLAY time against the current state of the
 * world. Revoking access makes `canOpen` false on a message that was sent
 * months ago, without editing a single word of what was said — which matters,
 * because silently rewriting a person's message history to match today's
 * permissions is its own kind of dishonesty.
 */
export async function resolveCitations(
  db: Db,
  args: { messageId: string; viewerUserId: string },
): Promise<ResolvedCitation[]> {
  const rows = await db.query<{
    document_id: string | null;
    filename_at_time: string;
    locator: string;
    owner_user_id: string;
    still_there: boolean;
    mapping_status: string | null;
  }>(
    `select c.document_id, c.filename_at_time, c.locator, c.owner_user_id,
            (d.id is not null) as still_there,
            m.status as mapping_status
     from message_citations c
     left join documents d on d.id = c.document_id
     left join folder_mappings m on m.id = d.mapping_id
     where c.message_id = $1
     order by c.created_at`,
    [args.messageId],
  );

  return rows.map((r) => ({
    filename: r.filename_at_time,
    locator: r.locator,
    documentId: r.still_there ? r.document_id : null,
    canOpen: r.still_there
      && r.owner_user_id === args.viewerUserId
      && r.mapping_status === 'active',
  }));
}

// ---------------------------------------------------------------------------
// Semantic search (M51)
// ---------------------------------------------------------------------------

export const SEMANTIC_DISCLOSURE =
  'To search by meaning, Josi sends the text of your documents to the embedding '
  + 'service your administrator has configured. That text leaves this server. '
  + 'Full-text search does not do this and stays on the machine.';

/**
 * The two gates on semantic search, in order.
 *
 * Local-only first, because it is the installation-wide promise and no
 * individual's consent can override it. A person cannot agree to send data out
 * of an installation whose operator has declared that nothing does.
 */
export async function assertSemanticAllowed(db: Db, userId: string): Promise<void> {
  const [security] = await db.query<{ local_only: boolean }>(
    `select local_only from security_policy where id = true`,
  );
  if (security?.local_only) {
    throw new SemanticForbidden(
      'this installation is set to Local-only, so nothing may be sent to an external service',
    );
  }

  const [policy] = await db.query<{ semantic_enabled: boolean }>(
    `select semantic_enabled from storage_policy where id = true`,
  );
  if (!policy?.semantic_enabled) {
    throw new SemanticForbidden('an administrator has not enabled search by meaning');
  }

  const [consent] = await db.query<{ user_id: string }>(
    `select user_id from semantic_consents where user_id = $1`, [userId],
  );
  if (!consent) {
    throw new SemanticNotConsented('you have not agreed to send document text to the embedding service');
  }
}

export async function recordSemanticConsent(
  db: Db,
  args: { userId: string; provider: string },
): Promise<void> {
  // Local-only is checked here too. Recording consent for something that may
  // never happen would leave a row saying a person agreed to an exfiltration
  // the installation forbids.
  const [security] = await db.query<{ local_only: boolean }>(
    `select local_only from security_policy where id = true`,
  );
  if (security?.local_only) {
    throw new SemanticForbidden(
      'this installation is set to Local-only, so nothing may be sent to an external service',
    );
  }

  await db.query(
    `insert into semantic_consents (user_id, disclosure, provider)
     values ($1, $2, $3)
     on conflict (user_id) do update set
       disclosure = excluded.disclosure, provider = excluded.provider, consented_at = now()`,
    [args.userId, SEMANTIC_DISCLOSURE, args.provider],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'user',
    kind: 'storage.semantic_consented',
    subjectType: 'user',
    subjectId: args.userId,
    payload: { provider: args.provider },
  });
}

export async function revokeSemanticConsent(db: Db, userId: string): Promise<{ embeddings: number }> {
  await db.query(`delete from semantic_consents where user_id = $1`, [userId]);
  // Consent withdrawn means the derived vectors go too. An embedding is a
  // lossy but real representation of the text it came from.
  const [row] = await db.query<{ n: number }>(
    `with removed as (delete from document_embeddings where owner_user_id = $1 returning 1)
     select count(*)::int as n from removed`,
    [userId],
  );
  await appendEvent(db, {
    actorUserId: userId,
    actor: 'user',
    kind: 'storage.semantic_revoked',
    subjectType: 'user',
    subjectId: userId,
    payload: { embeddings: row?.n ?? 0 },
  });
  return { embeddings: row?.n ?? 0 };
}

/** Cosine similarity over stored vectors.
 *
 * In the application rather than the database because CE targets stock
 * PostgreSQL, where pgvector may not be installable. Honest about being slower
 * than an index; correct, and it runs on a Pi. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function encodeVector(values: number[]): Buffer {
  const f = new Float32Array(values);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  // Copied rather than viewed: a Buffer from the driver may be a slice of a
  // larger pooled allocation, and a view would read its neighbours.
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
