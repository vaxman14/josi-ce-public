// The audit trail.
//
// One rule governs this file and it is the reason CE can promise that a super
// admin administers plumbing rather than reading people's mail: an event
// records WHO did WHAT to WHICH resource, and never what the resource said.
// Counts, ids, hashes and categories are welcome. Subjects, bodies, filenames
// and extracted text are not.
import { json, type Db } from './db.js';

export interface EventInput {
  /** The signed-in user responsible, when there is one. */
  actorUserId?: string | null;
  /** Free-text actor for activity with no user behind it: 'system', 'agent'. */
  actor?: string;
  kind: string;
  subjectType?: string | null;
  subjectId?: string | null;
  payload?: Record<string, unknown>;
}

/** Keys that must never appear in an audit payload. This is a backstop, not a
 * substitute for calling sites being careful — but a backstop that throws in
 * tests is how carelessness gets caught before it ships. */
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'body', 'bodyText', 'body_text', 'content', 'text', 'message', 'subject',
  'snippet', 'preview', 'filename', 'file_name', 'path', 'extractedText',
  'password', 'token', 'access_token', 'refresh_token', 'secret', 'secrets',
  'apiKey', 'api_key', 'client_secret',
]);

export class AuditContentError extends Error {}

/** Throws when a payload carries something that looks like content or a
 * credential. Exported so tests can assert the guard itself works. */
export function assertMetadataOnly(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key)) {
      throw new AuditContentError(
        `audit payload key "${key}" looks like content or a credential; audit records metadata only`,
      );
    }
  }
}

export async function appendEvent(db: Db, input: EventInput): Promise<void> {
  const payload = input.payload ?? {};
  assertMetadataOnly(payload);
  await db.query(
    `insert into events (actor_user_id, actor, kind, subject_type, subject_id, payload)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.actorUserId ?? null,
      input.actor ?? (input.actorUserId ? 'user' : 'system'),
      input.kind,
      input.subjectType ?? null,
      input.subjectId ?? null,
      json(payload),
    ],
  );
}

export interface EventRow {
  id: string;
  actor_user_id: string | null;
  actor: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export async function listEvents(
  db: Db,
  opts: { kind?: string; actorUserId?: string; limit?: number } = {},
): Promise<EventRow[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  return db.query<EventRow>(
    `select * from events
     where ($1::text is null or kind like $1 || '%')
       and ($2::uuid is null or actor_user_id = $2)
     order by id desc limit $3`,
    [opts.kind ?? null, opts.actorUserId ?? null, limit],
  );
}
