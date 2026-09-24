// Deciding whether two contact records are the same person.
//
// This is the load-bearing part of every contact-sync path — Google, Microsoft,
// the phone in someone's pocket — and it is the part that is dangerous to get
// wrong in BOTH directions:
//
//   * Too eager, and two colleagues who share a family phone line become one
//     person, and a message meant for one reaches the other. That is a privacy
//     failure that a "merge" button cannot undo, because the original records
//     are gone.
//   * Too shy, and every sync adds a fourth copy of everyone.
//
// So the rules are explicit, ordered by how much they prove, and each returns
// its own confidence rather than a boolean. A caller that wants to merge
// automatically may use `exact`; anything less goes in front of a person.
//
// NOTHING HERE TOUCHES A DATABASE. It is a pure function of two records, which
// is what makes the whole matrix testable without constructing an installation
// per case.

/** Where a record came from. A device is a source like any other. */
export type ContactSource = 'josi' | 'google' | 'microsoft' | 'device';

export interface ExternalContact {
  /** The provider's own stable id. `resourceName` for Google People, `id` for
   * Microsoft Graph, the platform contact identifier on a device. */
  sourceId: string;
  source: ContactSource;
  /** Which connected account or device this came from. Two Google accounts on
   * one installation are two different origins and must not be conflated. */
  sourceAccount: string;
  displayName: string | null;
  emails: string[];
  phones: string[];
}

// -------------------------------------------------------------- normalisation

/** An email address reduced to what identifies the mailbox.
 *
 * Case-folded, whitespace trimmed. Deliberately NOT dot-stripped or
 * plus-stripped: `a.b@gmail.com` and `ab@gmail.com` are the same mailbox at
 * Gmail and different mailboxes almost everywhere else, and a rule that is
 * right for one provider and wrong for the rest merges strangers. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value.includes('@')) return null;
  const [local, domain] = [value.slice(0, value.lastIndexOf('@')), value.slice(value.lastIndexOf('@') + 1)];
  if (!local || !domain || !domain.includes('.')) return null;
  return `${local}@${domain}`;
}

/** A phone number reduced to comparable digits.
 *
 * Returns E.164 where the input carried enough information to be sure, and
 * otherwise the national digits. `defaultCountry` is the installation's own
 * dialling code and is applied ONLY to a number that looks national — never to
 * one that already carries a country code, because guessing a country onto a
 * number that has one is how two different people in two countries collide.
 *
 * This is deliberately not a full libphonenumber. It handles the shapes people
 * actually store — spaces, dashes, brackets, a leading +, a leading 00, a
 * national trunk 0 — and returns null rather than guessing at anything else.
 * A null never matches anything, which is the safe direction. */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry?: string | null,
): string | null {
  let value = (raw ?? '').trim();
  if (!value) return null;

  // Extensions are not part of the identity of a line.
  value = value.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, '');

  const hadPlus = value.startsWith('+');
  // `00` is the international prefix everywhere that is not North America.
  const hadZeroZero = /^00\d/.test(value);
  let digits = value.replace(/\D/g, '');
  if (hadZeroZero) digits = digits.slice(2);

  if (!digits) return null;

  if (hadPlus || hadZeroZero) {
    // Already international. E.164 allows at most 15 digits; anything longer
    // is not a phone number and must not be treated as one.
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  }

  const cc = (defaultCountry ?? '').replace(/\D/g, '');
  if (cc) {
    // A single leading zero is a national trunk prefix and is dropped when a
    // country code goes on the front.
    const national = digits.replace(/^0+/, '');
    if (!national) return null;
    const combined = `${cc}${national}`;
    return combined.length >= 7 && combined.length <= 15 ? `+${combined}` : null;
  }

  // No country to apply. Keep the digits so two records from the same place
  // still match each other, and accept that they will not match an
  // international form of the same line — under-matching, on purpose.
  return digits.length >= 7 ? digits : null;
}

export function normalizeName(raw: string | null | undefined): string | null {
  const value = (raw ?? '')
    .normalize('NFKD')
    // Strip combining marks so "José" and "Jose" are the same name.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || null;
}

// ------------------------------------------------------------------ matching

export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface MatchVerdict {
  confidence: MatchConfidence;
  /** Which rule fired. Shown in a merge preview so a person can disagree. */
  reason: string;
  /** May a caller merge these without asking? Only ever true for `exact`. */
  autoMergeable: boolean;
}

const none: MatchVerdict = { confidence: 'none', reason: 'Nothing in common.', autoMergeable: false };

/** Are these the same person?
 *
 * The order is the argument. Each rule proves strictly less than the one above
 * it, and only the first — the same record from the same account — is allowed
 * to merge unattended.
 */
export function matchContacts(a: ExternalContact, b: ExternalContact): MatchVerdict {
  // 1. The provider says so. Same source, same account, same id: this is not a
  //    match, it is the same row seen twice, and it is the only case where a
  //    machine should act alone.
  if (a.source === b.source && a.sourceAccount === b.sourceAccount && a.sourceId === b.sourceId) {
    return {
      confidence: 'exact',
      reason: 'The same record from the same account.',
      autoMergeable: true,
    };
  }

  const emailsA = new Set(a.emails.map(normalizeEmail).filter(Boolean) as string[]);
  const emailsB = new Set(b.emails.map(normalizeEmail).filter(Boolean) as string[]);
  const sharedEmail = [...emailsA].find((e) => emailsB.has(e));

  const phonesA = new Set(a.phones.map((p) => normalizePhone(p)).filter(Boolean) as string[]);
  const phonesB = new Set(b.phones.map((p) => normalizePhone(p)).filter(Boolean) as string[]);
  const sharedPhone = [...phonesA].find((p) => phonesB.has(p));

  const nameA = normalizeName(a.displayName);
  const nameB = normalizeName(b.displayName);
  const sameName = !!nameA && nameA === nameB;

  // 2. A shared mailbox plus a matching name. A mailbox is close to a person,
  //    and the name agreeing removes the shared-inbox case.
  if (sharedEmail && sameName) {
    return {
      confidence: 'strong',
      reason: `Same name and the same email address (${sharedEmail}).`,
      autoMergeable: false,
    };
  }

  // 3. A shared mailbox alone. Usually the same person; sometimes
  //    `office@`, which two colleagues both list.
  if (sharedEmail) {
    return {
      confidence: 'strong',
      reason: `The same email address (${sharedEmail}), but the names differ.`,
      autoMergeable: false,
    };
  }

  // 4. A shared LINE plus a matching name. A phone number is a line, not a
  //    person: households, desks and switchboards are all shared. The name is
  //    what makes it worth showing at all.
  if (sharedPhone && sameName) {
    return {
      confidence: 'strong',
      reason: `Same name and the same phone number (${sharedPhone}).`,
      autoMergeable: false,
    };
  }

  // 5. A shared line and nothing else. This is the family-phone case, and it
  //    is the one that must never merge unattended.
  if (sharedPhone) {
    return {
      confidence: 'weak',
      reason: `The same phone number (${sharedPhone}), but nothing else agrees. This is often a shared line rather than the same person.`,
      autoMergeable: false,
    };
  }

  // 6. A name and nothing else is not evidence. There are a lot of people
  //    called James Smith, and merging them is not recoverable.
  return none;
}

/** A stable key for grouping candidates before comparing them.
 *
 * Only used to avoid comparing every record with every other one. Two records
 * that share a bucket still go through `matchContacts`; two that do not are
 * never compared, so a bucket that is too narrow under-matches and a bucket
 * that is too wide is merely slow. Under-matching is the safe failure. */
export function matchBuckets(contact: ExternalContact): string[] {
  const buckets: string[] = [];
  for (const email of contact.emails) {
    const normalized = normalizeEmail(email);
    if (normalized) buckets.push(`e:${normalized}`);
  }
  for (const phone of contact.phones) {
    const normalized = normalizePhone(phone);
    // The last seven digits: enough to survive one record carrying a country
    // code and another not, without bucketing the whole country together.
    if (normalized) buckets.push(`p:${normalized.slice(-7)}`);
  }
  return buckets;
}

// --------------------------------------------------------------- deduplication

export interface MergeCandidate<T> {
  left: T;
  right: T;
  verdict: MatchVerdict;
}

/** Every pair worth a person's attention, and every pair a machine may take.
 *
 * Deterministic: the same input produces the same output in the same order,
 * because a merge preview that reorders itself between two viewings is a merge
 * preview nobody trusts. */
export function findDuplicates<T extends ExternalContact>(contacts: readonly T[]): {
  automatic: Array<MergeCandidate<T>>;
  needsReview: Array<MergeCandidate<T>>;
} {
  const byBucket = new Map<string, T[]>();
  for (const contact of contacts) {
    for (const bucket of matchBuckets(contact)) {
      const list = byBucket.get(bucket) ?? [];
      list.push(contact);
      byBucket.set(bucket, list);
    }
  }

  const seen = new Set<string>();
  const automatic: Array<MergeCandidate<T>> = [];
  const needsReview: Array<MergeCandidate<T>> = [];

  const index = new Map(contacts.map((c, i) => [c, i]));
  const pairKey = (a: T, b: T) => {
    const [x, y] = [index.get(a)!, index.get(b)!].sort((m, n) => m - n);
    return `${x}:${y}`;
  };

  // The same-record case shares no bucket when a contact has neither an email
  // nor a phone, so it is checked across the whole set rather than per bucket.
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const verdict = matchContacts(contacts[i], contacts[j]);
      if (verdict.confidence !== 'exact') continue;
      seen.add(pairKey(contacts[i], contacts[j]));
      automatic.push({ left: contacts[i], right: contacts[j], verdict });
    }
  }

  for (const group of byBucket.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const key = pairKey(group[i], group[j]);
        if (seen.has(key)) continue;
        const verdict = matchContacts(group[i], group[j]);
        if (verdict.confidence === 'none') continue;
        seen.add(key);
        if (verdict.autoMergeable) automatic.push({ left: group[i], right: group[j], verdict });
        else needsReview.push({ left: group[i], right: group[j], verdict });
      }
    }
  }

  const order = (c: MergeCandidate<T>) => index.get(c.left)! * contacts.length + index.get(c.right)!;
  automatic.sort((a, b) => order(a) - order(b));
  needsReview.sort((a, b) => order(a) - order(b));
  return { automatic, needsReview };
}
