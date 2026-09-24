// Data claims require receipts too — item 41b, the sequel to claimGuard's
// item 12. Two real incidents (items 33 and 41) showed a tool running is not
// enough: the REPLY can still invent filenames or state a count the tool
// result contradicts. This suite covers the pure detector in isolation
// (`checkDataClaims`) the way claimGuard.test.ts covers `claimsCompletedAction`
// — fast, no database, one behavior per case.
import { describe, expect, it } from 'vitest';
import {
  DATA_CLAIM_TOOLS, checkDataClaims, checkNarratedSearchWithoutTool, type DataToolReceipt,
} from '../src/dataClaimGuard.js';

const searchDocumentsHit = (overrides: Partial<{ hits: unknown[] }> = {}): DataToolReceipt => ({
  tool: 'search_documents',
  result: {
    ok: true,
    hits: overrides.hits ?? [
      { citation: 'Lease Agreement.pdf, page 3', snippet: 'the tenant shall…', document_id: 'd1' },
      { citation: 'Invoice 2026-04.csv', snippet: 'total due 450.00', document_id: 'd2' },
    ],
  },
});

const listDocumentsResult = (documents: unknown[]): DataToolReceipt => ({
  tool: 'list_documents',
  result: { ok: true, documents },
});

const NINE_DOCS = Array.from({ length: 9 }, (_, i) => ({
  id: `doc-${i}`, filename: `File ${i}.pdf`, state: 'indexed', skip_reason: null, folder: '/docs',
}));

describe('DATA_CLAIM_TOOLS', () => {
  it('covers the document tools and the item-17 read tools', () => {
    expect([...DATA_CLAIM_TOOLS].sort()).toEqual([
      'check_email_availability', 'get_event', 'get_provider_status', 'list_documents',
      'query_calendar', 'read_email', 'search_contacts', 'search_documents', 'search_email',
    ].sort());
  });
});

describe('checkDataClaims — silence when there is nothing to check', () => {
  it('never fires when no data tool ran this turn', () => {
    const verdict = checkDataClaims(
      'I found Crystal Rodriguez.pdf and AmeriEstate ebook.epub in your documents.',
      [],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('never fires on an empty reply', () => {
    const verdict = checkDataClaims('', [searchDocumentsHit()]);
    expect(verdict.fabricated).toBe(false);
  });

  it('ignores receipts from tools outside its list (e.g. schedule_reminder)', () => {
    const verdict = checkDataClaims(
      'Done — I found Crystal Rodriguez.pdf for you.',
      [{ tool: 'schedule_reminder', result: { ok: true, reminder_id: 'r1' } }],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('ignores a receipt whose result was ok:false — nothing there to be grounded in', () => {
    const verdict = checkDataClaims(
      'I found Crystal Rodriguez.pdf for you.',
      [{ tool: 'search_documents', result: { ok: false, error: 'bad_query', message: 'Say what to search for.' } }],
    );
    expect(verdict.fabricated).toBe(false);
  });
});

describe('checkDataClaims — a reply that correctly quotes the tool result passes untouched', () => {
  it('passes when every named file is a real citation', () => {
    const verdict = checkDataClaims(
      'I found two matches: Lease Agreement.pdf, page 3, and Invoice 2026-04.csv.',
      [searchDocumentsHit()],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('passes a correct count against list_documents', () => {
    const verdict = checkDataClaims(
      'You have 9 indexed documents.',
      [listDocumentsResult(NINE_DOCS)],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('passes an honest empty report', () => {
    const verdict = checkDataClaims(
      'No documents are indexed yet. Connect a folder on the Connections page first.',
      [{ tool: 'search_documents', result: { ok: true, hits: [], message: 'No documents are indexed yet.' } }],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('passes a reply that only paraphrases, naming no specific file or count', () => {
    const verdict = checkDataClaims(
      'I searched your documents and found a couple of matches about the lease and an invoice.',
      [searchDocumentsHit()],
    );
    expect(verdict.fabricated).toBe(false);
  });
});

describe('checkDataClaims — an invented filename triggers the guard', () => {
  it('flags a filename never present in the tool result', () => {
    const verdict = checkDataClaims(
      'I found AmeriEstate ebook.pdf and Crystal Rodriguez.pdf in your documents.',
      [searchDocumentsHit()],
    );
    expect(verdict.fabricated).toBe(true);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('flags an invented filename even when ONE real filename is also named', () => {
    const verdict = checkDataClaims(
      'I found Lease Agreement.pdf and also temp_EG.txt.',
      [searchDocumentsHit()],
    );
    expect(verdict.fabricated).toBe(true);
  });

  it('flags a fabricated filename against list_documents results too', () => {
    const verdict = checkDataClaims(
      'Your indexed files include Plan-Comparison.csv.',
      [listDocumentsResult(NINE_DOCS)],
    );
    expect(verdict.fabricated).toBe(true);
  });
});

describe('checkDataClaims — a count contradicting the tool result triggers the guard', () => {
  it('flags a stated count that does not match list_documents length', () => {
    const verdict = checkDataClaims(
      'You have 38 indexed documents.',
      [listDocumentsResult(NINE_DOCS)],
    );
    expect(verdict.fabricated).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/38.*9|9.*38/);
  });

  it('flags zero stated when the tool actually returned rows', () => {
    const verdict = checkDataClaims(
      'You have 0 files indexed right now.',
      [listDocumentsResult(NINE_DOCS)],
    );
    expect(verdict.fabricated).toBe(true);
  });

  it('flags an email count mismatch against search_email', () => {
    const verdict = checkDataClaims(
      'I found 5 emails matching that.',
      [{
        tool: 'search_email',
        result: {
          ok: true,
          emails: [{ email_id: 'google:m1', from: 'ann@example.test', to: 'r@example.test', subject: 'lunch', date: '2026-09-01', snippet: 'x' }],
        },
      }],
    );
    expect(verdict.fabricated).toBe(true);
  });

  it('does not cross-check a count against an unrelated tool\'s result', () => {
    // "12 documents" stated while only search_email ran this turn — nothing
    // to compare a document count against, so this must not fire.
    const verdict = checkDataClaims(
      'You have 12 documents total, by the way — separately, I found 1 email.',
      [{
        tool: 'search_email',
        result: { ok: true, emails: [{ email_id: 'google:m1', from: 'a', to: 'b', subject: 's', date: 'd', snippet: 's' }] },
      }],
    );
    // The email count (1) is correct; there is no document tool result this
    // turn to check the "12 documents" claim against, so only the grounded
    // comparison fires — none, here — and the guard stays silent.
    expect(verdict.fabricated).toBe(false);
  });

  it('does not treat an unrelated number (e.g. a page locator) as a count claim', () => {
    const verdict = checkDataClaims(
      'I found Lease Agreement.pdf, page 3.',
      [searchDocumentsHit()],
    );
    expect(verdict.fabricated).toBe(false);
  });
});

describe('checkDataClaims — instability across turns with unchanged data (item 41 shape)', () => {
  it('the same unchanged tool result grounds a reply consistently, whatever number was said moments before', () => {
    // The literal item-41 shape: same 9-document result, checked against two
    // different claimed counts in two "turns" — the real data never changed,
    // so the guard's verdict must depend ONLY on the receipt, not on some
    // remembered prior answer (this module holds no state between calls).
    const receipt = listDocumentsResult(NINE_DOCS);
    const first = checkDataClaims('Zero files are indexed.', [receipt]);
    const second = checkDataClaims('38 files are indexed.', [receipt]);
    const third = checkDataClaims('9 files are indexed.', [receipt]);
    expect(first.fabricated).toBe(true);
    expect(second.fabricated).toBe(true);
    expect(third.fabricated).toBe(false);
  });
});

// The 2026-09-04 04:54 incident: Roman typed "Test". Six milliseconds later —
// too fast for any real search_documents/list_documents call — the reply
// confidently narrated "Search for 'test' returned eight passages across six
// files" with specific invented file names, and `meta` (the turn's tool
// receipts) was empty. checkDataClaims alone CANNOT catch this: its very
// first line is `if (!vocab.any) return { fabricated: false, reasons };` —
// with zero data-tool receipts there is nothing to build a vocabulary from,
// so the function is silent by design. That silence is correct when the
// reply never claims to have searched anything; it is the bug when the reply
// DOES claim it, in its own words, while no tool ran. This needs its own
// detector, distinct from (and not weakening) the receipt-comparison checks
// above — checkNarratedSearchWithoutTool fires on the NARRATION itself:
// "I searched / I found N files / passages returned" language, when the
// turn's receipts contain zero DATA_CLAIM_TOOLS calls at all.
describe('live email availability grounding', () => {
  it('rejects metadata-only availability and accepts only a successful live mailbox check', () => {
    const claim = 'Email is available and ready.';
    expect(checkNarratedSearchWithoutTool(claim, [{tool:'get_provider_status',result:{ok:true,receipt:'private'}}]).fabricated).toBe(true);
    expect(checkNarratedSearchWithoutTool('I can see your emails.', [{tool:'get_provider_status',result:{ok:true}}]).fabricated).toBe(true);
    expect(checkNarratedSearchWithoutTool(claim, [{tool:'check_email_availability',result:{ok:false,error:'provider_unavailable'}}]).fabricated).toBe(true);
    expect(checkNarratedSearchWithoutTool(claim, [{tool:'check_email_availability',result:{ok:true,available:true,providers:['Gmail']}}]).fabricated).toBe(false);
  });
});

describe('checkNarratedSearchWithoutTool — the zero-tool-call narration gap (2026-09-04 incident)', () => {
  it('flags a reply that narrates search results when no data tool ran this turn', () => {
    // The literal incident shape, condensed: "Test" is the user's message;
    // this is the kind of reply that followed it, 6ms later, with meta: {}.
    const verdict = checkNarratedSearchWithoutTool(
      "Search for 'test' returned eight passages across six files: ResumeMartinVu.pdf, "
      + 'Plan-Comparison.csv, LinkedIn_Employer_Brand_Playbook.pdf and three others.',
      [],
    );
    expect(verdict.fabricated).toBe(true);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('flags first-person search narration with no receipts', () => {
    const verdict = checkNarratedSearchWithoutTool(
      'I searched your documents and found 3 matching files about the lease.',
      [],
    );
    expect(verdict.fabricated).toBe(true);
  });

  it('does NOT fire when a data tool actually ran this turn (even if empty)', () => {
    const verdict = checkNarratedSearchWithoutTool(
      "Search for 'test' returned no passages.",
      [{ tool: 'search_documents', result: { ok: true, hits: [] } }],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('does NOT fire on ordinary conversation that never claims to have searched anything', () => {
    const verdict = checkNarratedSearchWithoutTool('Test received. How can I help?', []);
    expect(verdict.fabricated).toBe(false);
  });

  it('does NOT fire on an honest refusal that explicitly says no search happened', () => {
    const verdict = checkNarratedSearchWithoutTool(
      'I have not searched your documents for that yet — ask me and I will.',
      [],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('does NOT fire when a non-data tool ran this turn but no search-result language is used', () => {
    const verdict = checkNarratedSearchWithoutTool(
      'Reminder set for 5 minutes from now.',
      [{ tool: 'schedule_reminder', result: { ok: true, reminder_id: 'r1' } }],
    );
    expect(verdict.fabricated).toBe(false);
  });

  it('flags calendar/email/contacts narration with no receipts too, not just documents', () => {
    const verdict = checkNarratedSearchWithoutTool(
      'I checked your calendar and found 2 events tomorrow.',
      [],
    );
    expect(verdict.fabricated).toBe(true);
  });
});
