/**
 * The presentation boundary between model output and every user-facing channel.
 *
 * Tool results remain intact in `AgentTurnResult.actions` for grounding,
 * continuity and audit work. Only the prose returned to a person crosses this
 * boundary. This is deliberately deterministic: prompt instructions help, but
 * cannot be the last defence against a model echoing receipt metadata.
 */

export interface PresentationAction {
  tool: string;
  result: unknown;
}

const INTERNAL_KEY = /^(?:id|.*_id|.*_ids|receipt|.*_receipt|approval|approval_id|authorization|authorization_evidence|account|account_email|account_id|account_identity|provider_account_id|observed_at|created_at|updated_at|deleted_at|last_.*_at|next_.*_at|modified|timestamp|cursor|.*_cursor|token|.*_token|secret|.*_secret)$/i;
const normalizedKey = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-\s]+/g, '_').toLowerCase();
const INTERNAL_LABEL = /\b(?:audit\s+)?receipt(?:\s+id)?|\b(?:internal|connection|account|provider|calendar|event|source|mapping|thread|task|approval|authorization)\s+id|\baccount(?:\s+(?:email|identity|metadata))?|\bobserv(?:ed|ation)\s+(?:at|time)|\binternal\s+timestamp/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

function escaped(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

function collectInternalValues(value: unknown, values: Set<string>, key = '', seen = new Set<object>()): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (INTERNAL_KEY.test(normalizedKey(key)) && text.length >= 3) values.add(text);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) collectInternalValues(entry, values, key, seen);
    return;
  }
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    collectInternalValues(child, values, childKey, seen);
  }
}

function metadataOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !INTERNAL_LABEL.test(trimmed)) return false;
  // Remove metadata fields and JSON properties, but keep an ordinary sentence
  // which merely mentions an account (for example, "Reconnect your account.").
  return /^[\s>*-]*(?:["'`{[]\s*)?(?:audit\s+)?(?:receipt(?:\s+id)?|(?:internal|connection|account|provider|calendar|event|source|mapping|thread|task|approval|authorization)\s+id|account(?:\s+(?:email|identity|metadata))?|observ(?:ed|ation)\s+(?:at|time)|internal\s+timestamp)\s*["'`]*\s*[:=#-]/i.test(trimmed);
}

/** Remove internal grounding metadata without mutating backend receipts. */
export function presentToolBackedReply(reply: string, actions: PresentationAction[]): string {
  if (!actions.length || !reply) return reply;

  const internalValues = new Set<string>();
  for (const action of actions) collectInternalValues(action.result, internalValues);

  let visible = reply
    .split(/\r?\n/)
    .filter((line) => !metadataOnlyLine(line))
    .join('\n');

  // Longest first prevents a short nested identifier from partially rewriting
  // a longer one. Values are removed only when they came from this turn's real
  // tool results; user prose and useful names/source labels remain untouched.
  for (const value of [...internalValues].sort((a, b) => b.length - a.length)) {
    visible = visible.replace(escaped(value), '');
  }
  // UUIDs are identifiers by construction. A tool-backed reply never needs to
  // expose one, including UUIDs a future tool returns under a novel key.
  visible = visible.replace(UUID, '');

  // Drop metadata-only sentence fragments left after their values were
  // removed. This also covers compact one-line model dumps with several
  // fields, not just the more common one-field-per-line form.
  visible = visible.replace(
    /(?:^|(?<=[.!?])\s+)(?:\w+\s+)?(?:receipt(?:\s+id)?|(?:internal|connection|account|provider|calendar|event|source|mapping|thread|task|approval|authorization)\s+id|account(?:\s+(?:email|identity|metadata))?|observ(?:ed|ation)\s+(?:at|time)|internal\s+timestamp)\s*[:=#-]?\s*[.!?]?\s*/gi,
    '',
  );

  visible = visible
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/:[ \t]*(?=\n|$)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (visible) return visible;
  const failed = actions.some(({ result }) => result && typeof result === 'object'
    && (result as { ok?: boolean }).ok === false);
  return failed ? 'I could not complete that request.' : 'I completed that request.';
}
