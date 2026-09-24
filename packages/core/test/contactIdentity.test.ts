// Deciding whether two contact records are the same person.
//
// The failure this file exists to prevent is not "duplicates in a list". It is
// two colleagues who share a family phone line becoming one contact, after
// which a message meant for one reaches the other and the original records are
// gone. Every rule below is ordered by how much it proves, and only the first
// may act unattended.
import { describe, expect, it } from 'vitest';
import {
  findDuplicates, matchBuckets, matchContacts, normalizeEmail, normalizeName, normalizePhone,
  type ExternalContact,
} from '../src/index.js';

const contact = (over: Partial<ExternalContact> = {}): ExternalContact => ({
  sourceId: 'id-1',
  source: 'google',
  sourceAccount: 'alice@example.test',
  displayName: 'Alice Example',
  emails: [],
  phones: [],
  ...over,
});

describe('normalising an email address', () => {
  it('folds case and trims', () => {
    expect(normalizeEmail('  Alice@Example.TEST ')).toBe('alice@example.test');
  });

  it('refuses anything that is not an address', () => {
    for (const bad of ['', '   ', 'alice', 'alice@', '@example.test', 'alice@localhost', null, undefined]) {
      expect(normalizeEmail(bad), String(bad)).toBeNull();
    }
  });

  it('does not strip dots or plus tags', () => {
    // Gmail treats these as the same mailbox. Almost nobody else does, and a
    // rule that is right for one provider and wrong for the rest merges
    // strangers.
    expect(normalizeEmail('a.b@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
    expect(normalizeEmail('alice+josi@example.test')).toBe('alice+josi@example.test');
  });
});

describe('normalising a phone number', () => {
  it('reduces the shapes people actually store to one', () => {
    for (const written of ['+44 20 7946 0958', '+44-20-7946-0958', '+44 (20) 7946 0958', '004420 7946 0958']) {
      expect(normalizePhone(written), written).toBe('+442079460958');
    }
  });

  it('drops an extension, which is not part of a line’s identity', () => {
    expect(normalizePhone('+442079460958 ext. 21')).toBe('+442079460958');
    expect(normalizePhone('+442079460958 x21')).toBe('+442079460958');
  });

  it('applies the installation’s country only to a national number', () => {
    expect(normalizePhone('020 7946 0958', '44')).toBe('+442079460958');
    // The trunk zero goes when a country code arrives.
    expect(normalizePhone('20 7946 0958', '44')).toBe('+442079460958');
  });

  it('never puts a country code onto a number that already has one', () => {
    // This is how two different people in two countries collide.
    expect(normalizePhone('+1 202 555 0143', '44')).toBe('+12025550143');
    expect(normalizePhone('+442079460958', '1')).toBe('+442079460958');
  });

  it('keeps national digits when it has no country to apply', () => {
    // Under-matching on purpose: two records from the same place still match
    // each other and neither matches an international form.
    expect(normalizePhone('020 7946 0958')).toBe('02079460958');
  });

  it('returns null rather than guessing', () => {
    for (const bad of ['', '   ', 'call me', '12345', '+', '+123456789012345678', null, undefined]) {
      expect(normalizePhone(bad), String(bad)).toBeNull();
    }
  });

  it('never matches anything when it is null', () => {
    // The safe direction: an unparseable number is not evidence of anything.
    const a = contact({ sourceId: 'a', phones: ['call the office'], displayName: null });
    const b = contact({ sourceId: 'b', phones: ['call the office'], displayName: null });
    expect(matchContacts(a, b).confidence).toBe('none');
  });
});

describe('normalising a name', () => {
  it('folds accents, case and punctuation', () => {
    expect(normalizeName('José  O’Brien-Smith')).toBe('jose o brien smith');
    expect(normalizeName('JOSE OBRIEN SMITH')).toBe('jose obrien smith');
  });

  it('is null for nothing', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});

describe('matching two records', () => {
  it('treats the same id from the same account as the same row', () => {
    const verdict = matchContacts(
      contact({ sourceId: 'people/c1' }),
      contact({ sourceId: 'people/c1', displayName: 'Alice E' }),
    );
    expect(verdict.confidence).toBe('exact');
    expect(verdict.autoMergeable).toBe(true);
  });

  it('does not treat the same id from a DIFFERENT account as the same row', () => {
    // Two Google accounts on one installation are two different origins.
    const verdict = matchContacts(
      contact({ sourceId: 'people/c1', sourceAccount: 'alice@example.test', emails: [] }),
      contact({ sourceId: 'people/c1', sourceAccount: 'bob@example.test', emails: [] }),
    );
    expect(verdict.confidence).not.toBe('exact');
  });

  it('does not treat the same id from a different SOURCE as the same row', () => {
    const verdict = matchContacts(
      contact({ sourceId: 'shared-id', source: 'google' }),
      contact({ sourceId: 'shared-id', source: 'microsoft' }),
    );
    expect(verdict.confidence).not.toBe('exact');
  });

  it('calls a shared mailbox plus a matching name strong, and still asks', () => {
    const verdict = matchContacts(
      contact({ sourceId: 'a', emails: ['Alice@example.test'] }),
      contact({ sourceId: 'b', source: 'microsoft', emails: ['alice@EXAMPLE.test'] }),
    );
    expect(verdict.confidence).toBe('strong');
    expect(verdict.autoMergeable).toBe(false);
  });

  it('notices a shared mailbox with differing names, and says so', () => {
    // `office@` is listed by everybody in the office.
    const verdict = matchContacts(
      contact({ sourceId: 'a', displayName: 'Alice Example', emails: ['office@example.test'] }),
      contact({ sourceId: 'b', displayName: 'Bob Other', emails: ['office@example.test'] }),
    );
    expect(verdict.confidence).toBe('strong');
    expect(verdict.reason).toMatch(/names differ/i);
    expect(verdict.autoMergeable).toBe(false);
  });

  it('is WEAK about a shared line with nothing else, which is the family phone', () => {
    // The failure this whole file exists for.
    const verdict = matchContacts(
      contact({ sourceId: 'a', displayName: 'Alice Example', phones: ['+44 20 7946 0958'] }),
      contact({ sourceId: 'b', displayName: 'Bob Example', phones: ['+442079460958'] }),
    );
    expect(verdict.confidence).toBe('weak');
    expect(verdict.autoMergeable).toBe(false);
    expect(verdict.reason).toMatch(/shared line/i);
  });

  it('never merges on a name alone', () => {
    // There are a lot of people called James Smith.
    const verdict = matchContacts(
      contact({ sourceId: 'a', displayName: 'James Smith' }),
      contact({ sourceId: 'b', source: 'device', sourceAccount: 'phone', displayName: 'James Smith' }),
    );
    expect(verdict.confidence).toBe('none');
  });

  it('merges nothing automatically except the same record', () => {
    // The property, over every pair the other tests construct: exactly one
    // rule is allowed to act without a person.
    const pairs: Array<[ExternalContact, ExternalContact]> = [
      [contact({ sourceId: 'a', emails: ['x@example.test'] }), contact({ sourceId: 'b', emails: ['x@example.test'] })],
      [contact({ sourceId: 'a', phones: ['+442079460958'] }), contact({ sourceId: 'b', phones: ['+442079460958'] })],
      [contact({ sourceId: 'a' }), contact({ sourceId: 'b' })],
    ];
    for (const [left, right] of pairs) {
      expect(matchContacts(left, right).autoMergeable).toBe(false);
    }
    expect(matchContacts(contact(), contact()).autoMergeable).toBe(true);
  });
});

describe('finding duplicates across a set', () => {
  it('separates what a machine may do from what a person must decide', () => {
    const records = [
      contact({ sourceId: 'p1', emails: ['alice@example.test'] }),
      contact({ sourceId: 'p1', emails: ['alice@example.test'], displayName: 'Alice E.' }),
      contact({ sourceId: 'm1', source: 'microsoft', sourceAccount: 'alice@work.test', emails: ['ALICE@example.test'] }),
      contact({ sourceId: 'd1', source: 'device', sourceAccount: 'iphone', displayName: 'Bob Example', phones: ['+442079460958'] }),
      contact({ sourceId: 'd2', source: 'device', sourceAccount: 'iphone', displayName: 'Carol Example', phones: ['+44 20 7946 0958'] }),
    ];
    const { automatic, needsReview } = findDuplicates(records);

    expect(automatic).toHaveLength(1);
    expect(automatic[0].verdict.confidence).toBe('exact');

    // Pairs, not clusters. Three records share alice@example.test, so the
    // Microsoft one pairs with BOTH Google ones — redundant once the exact
    // pair is merged, and deliberately so: collapsing a chain of pairs into a
    // cluster is transitive merging, which is precisely how A-matches-B and
    // B-matches-C ends up merging two people who share nothing.
    expect(needsReview.map((c) => c.verdict.confidence).sort())
      .toEqual(['strong', 'strong', 'weak']);
    const family = needsReview.find((c) => c.verdict.confidence === 'weak')!;
    expect([family.left.displayName, family.right.displayName]).toEqual(['Bob Example', 'Carol Example']);
  });

  it('does not collapse unrelated people who merely share a source', () => {
    const records = [
      contact({ sourceId: 'a', displayName: 'Alice', emails: ['alice@example.test'] }),
      contact({ sourceId: 'b', displayName: 'Bob', emails: ['bob@example.test'] }),
      contact({ sourceId: 'c', displayName: 'Carol', emails: ['carol@example.test'] }),
    ];
    const { automatic, needsReview } = findDuplicates(records);
    expect(automatic).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  it('is deterministic, because a merge preview that reorders is not trusted', () => {
    const records = [
      contact({ sourceId: 'a', emails: ['x@example.test'] }),
      contact({ sourceId: 'b', source: 'microsoft', emails: ['x@example.test'] }),
      contact({ sourceId: 'c', source: 'device', sourceAccount: 'phone', emails: ['x@example.test'] }),
    ];
    const first = findDuplicates(records);
    for (let i = 0; i < 5; i++) {
      expect(findDuplicates(records)).toEqual(first);
    }
    // Every pair once, never twice.
    expect(first.needsReview).toHaveLength(3);
  });

  it('compares only records that could match, without missing one that does', () => {
    const buckets = matchBuckets(contact({ emails: ['a@example.test'], phones: ['+442079460958'] }));
    expect(buckets).toContain('e:a@example.test');
    // The last seven digits, so one record carrying a country code and another
    // not still land together.
    expect(buckets.some((b) => b.startsWith('p:'))).toBe(true);
    expect(matchBuckets(contact({ emails: [], phones: [] }))).toEqual([]);
  });

  it('still finds the same record twice when it has neither email nor phone', () => {
    // No bucket to share, so this case is checked across the whole set.
    const records = [
      contact({ sourceId: 'z', emails: [], phones: [] }),
      contact({ sourceId: 'z', emails: [], phones: [], displayName: 'Renamed' }),
    ];
    expect(findDuplicates(records).automatic).toHaveLength(1);
  });
});
