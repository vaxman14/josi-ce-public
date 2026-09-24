// What setup tested, and how the review screen is allowed to describe it.
//
// The screen this replaces reported an installation as configured when nothing
// had been contacted. It could say, on one page, that the model provider was
// "configured" and that no message had ever been sent — because "configured"
// meant a row existed. There was no way to represent "we tried and it failed",
// so a failure looked exactly like a success.
//
// Two ideas fix that and both live here:
//
//   1. A verification is a RECORD OF AN ATTEMPT. It has an outcome, and one of
//      the outcomes is failure.
//   2. The status shown to a person is DERIVED from that record by one pure
//      function, so there is one place where "tested" can be claimed and it
//      cannot be claimed without a passing verification.
import type { Db } from './db.js';
import { appendEvent } from './events.js';

export type VerificationStatus = 'passed' | 'failed' | 'skipped';

export interface Verification {
  item: string;
  status: VerificationStatus;
  category: string | null;
  detail: string | null;
  /** Safe metadata about what was tested: the address a message went to, the
   * model that answered. Never a credential. */
  target: string | null;
  checked_at: string;
}

/** Record the outcome of a real attempt to use what was configured.
 *
 * `detail` must be text the product composed. Nothing a provider said in prose
 * is passed through here — see the note on LlmError.providerCode for why. */
export async function recordVerification(
  db: Db,
  args: {
    item: string;
    status: VerificationStatus;
    category?: string | null;
    detail?: string | null;
    target?: string | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  await db.query(
    `insert into setup_verifications (item, status, category, detail, target, checked_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (item) do update set
       status = excluded.status, category = excluded.category,
       detail = excluded.detail, target = excluded.target, checked_at = now()`,
    [args.item, args.status, args.category ?? null, args.detail ?? null, args.target ?? null],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId ?? null,
    actor: 'system',
    kind: 'setup.verified',
    // The category, never the detail: detail is operator-facing text about a
    // specific attempt and the audit log is metadata only.
    payload: { item: args.item, status: args.status, category: args.category ?? null },
  });
}

export async function getVerifications(db: Db): Promise<Map<string, Verification>> {
  const rows = await db.query<Verification>(
    `select item, status, category, detail, target, checked_at from setup_verifications`,
  );
  return new Map(rows.map((r) => [r.item, r]));
}

// ------------------------------------------------------------------- review

/** The only five things the review screen may say about an item.
 *
 * There is deliberately no "configured" state. That word is what let the old
 * screen describe an untested credential and a working one identically. */
export type ReviewStatus =
  | 'configured_and_tested'
  | 'configured_but_failed'
  | 'skipped'
  | 'unavailable'
  | 'required';

export const REVIEW_LABELS: Record<ReviewStatus, string> = {
  configured_and_tested: 'Configured and tested',
  configured_but_failed: 'Configured but failed',
  skipped: 'Skipped',
  unavailable: 'Unavailable',
  required: 'Required',
};

export interface ReviewItemInput {
  key: string;
  label: string;
  /** Setup cannot finish while this is outstanding or failing. */
  required: boolean;
  /** Whether configuration was saved. Saving is NOT testing. */
  configured: boolean;
  verification: Verification | null;
  /** Set when the item cannot exist on this build or this installation — a
   * CE-only capability on a hosted build, a connector on a LAN-only host. The
   * reason is shown, because "unavailable" with no explanation reads as broken. */
  unavailableReason?: string | null;
}

export interface ReviewItem extends ReviewItemInput {
  status: ReviewStatus;
  statusLabel: string;
  /** Whether this item, in this state, prevents setup from completing. */
  blocking: boolean;
}

/** The single place a status is decided.
 *
 * Order matters. Unavailability wins over everything: an item that cannot exist
 * is not outstanding work and must never be reported as required, or setup
 * becomes impossible to finish. A recorded outcome wins over configuration,
 * because the outcome is newer information about the same thing. */
export function reviewStatusFor(item: ReviewItemInput): ReviewStatus {
  if (item.unavailableReason) return 'unavailable';

  if (item.verification) {
    if (item.verification.status === 'failed') return 'configured_but_failed';
    if (item.verification.status === 'passed') return 'configured_and_tested';
    return 'skipped';
  }

  // No attempt has been recorded.
  if (!item.configured) return item.required ? 'required' : 'skipped';

  // Configured, but never tested. This is the case the old screen called
  // "configured" and treated as done. It is not a failure — nothing failed —
  // but it is certainly not tested, so it is outstanding work.
  return 'required';
}

/** Does this item, as it stands, prevent setup from finishing?
 *
 * Only required items block. An optional item that failed stays visible and
 * stays failed — the operator is told, and chooses. Silently downgrading it to
 * "skipped" would hide a real failure behind a word that means "I decided not
 * to". */
export function blocksCompletion(status: ReviewStatus, required: boolean): boolean {
  if (!required) return false;
  return status === 'required' || status === 'configured_but_failed';
}

export function buildReviewItems(inputs: ReviewItemInput[]): ReviewItem[] {
  return inputs.map((input) => {
    const status = reviewStatusFor(input);
    return {
      ...input,
      status,
      statusLabel: REVIEW_LABELS[status],
      blocking: blocksCompletion(status, input.required),
    };
  });
}

export interface ReviewSummary {
  items: ReviewItem[];
  counts: Record<ReviewStatus, number>;
  blocking: ReviewItem[];
  canComplete: boolean;
  /** One sentence, derived from the items rather than written separately.
   *
   * The old screen rendered a fixed reassurance next to a list that contradicted
   * it — "everything is configured" above items that had never been contacted.
   * A headline computed from the same array cannot disagree with it. */
  headline: string;
}

export function summarizeReview(inputs: ReviewItemInput[]): ReviewSummary {
  const items = buildReviewItems(inputs);
  const counts: Record<ReviewStatus, number> = {
    configured_and_tested: 0, configured_but_failed: 0, skipped: 0, unavailable: 0, required: 0,
  };
  for (const item of items) counts[item.status]++;

  const blocking = items.filter((i) => i.blocking);
  const failed = counts.configured_but_failed;
  const tested = counts.configured_and_tested;

  let headline: string;
  if (blocking.length) {
    headline = blocking.length === 1
      ? `${blocking[0].label} has to be working before setup can finish.`
      : `${blocking.length} things have to be working before setup can finish.`;
  } else if (failed) {
    headline = `Ready to finish. ${failed} optional ${failed === 1 ? 'item' : 'items'} failed and can be fixed later.`;
  } else if (counts.skipped) {
    headline = `Ready to finish. ${tested} tested, ${counts.skipped} skipped — the skipped ones stay on your checklist.`;
  } else {
    headline = `Ready to finish. ${tested} of ${tested} tested.`;
  }

  return { items, counts, blocking, canComplete: blocking.length === 0, headline };
}
