// Data claims require receipts too. Item 41b — the sequel to claimGuard.ts.
//
// claimGuard.ts (round-2 item 12) catches ACTION claims: "I scheduled that"
// with zero tools run. It does not catch a DIFFERENT failure that happened
// twice in one night (items 33 and 41): a tool DID run — search_documents,
// list_documents — and the reply then said things about the result that are
// not true. Invented filenames ("AmeriEstate ebook", "Crystal Rodriguez.pdf")
// presented as real hits. Indexed-file counts that drift between messages
// against unchanged underlying data ("zero, then 38, then this"). A tool
// running does not make everything said afterward true; this module checks
// that the SPECIFICS in the reply actually came from the SPECIFICS in the
// tool result, not from the model's imagination of what a plausible result
// would contain.
//
// Same shape as claimGuard.ts on purpose — one architecture, not two parallel
// systems: a pure detector, a re-prompt, a fallback, invoked once per turn
// from the same spot in the loop.
//
//   * The detector only runs when a data-returning tool actually executed
//     this turn (search_documents, list_documents, search_email, read_email,
//     query_calendar, get_event, search_contacts) AND returned `ok: true`.
//     No data tool ran → nothing to check against → the guard is silent.
//   * "Vocabulary" is built from every proper-noun-shaped string the tool
//     result actually contains: filenames, citations, email subjects/senders,
//     event titles, contact names, ids. The reply is scanned for
//     filename-shaped tokens (word.ext) and quoted proper nouns; anything
//     that looks like a specific artifact but is NOT in the vocabulary is a
//     candidate fabrication.
//   * Counts: when the reply states a number that reads as "how many did the
//     tool return" (e.g. "9 files", "3 emails", "your 12 documents"), that
//     number is compared against the actual array length. A mismatch is a
//     fabrication candidate — this is exactly what item 41 saw (count
//     drifting between messages with unchanged data).
//   * Deliberately heuristic and deliberately trigger-happy. Item 41b's own
//     instruction: false positives (occasionally re-prompting a reply that
//     was actually fine) are far cheaper than false negatives (letting
//     another invented filename through) given tonight's incidents. So unlike
//     claimGuard's HONEST_MARKERS escape hatch, this guard has no broad
//     "sounds honest, let it through" exception — the only way to pass is
//     for the specifics to actually be grounded in the tool result.

/** The subset of tool names whose results this guard can check. Kept in sync
 * with the tools that return filenames/counts/specifics a reply could
 * misquote — the mail/calendar/contacts family (item 17) plus the document
 * tools (search_documents/list_documents, storage-providers-phase2). */
export const DATA_CLAIM_TOOLS = new Set([
  'search_documents', 'list_documents', 'get_provider_status',
  'check_email_availability', 'search_email', 'read_email',
  'query_calendar', 'get_event',
  'search_contacts',
]);

/** One data-returning tool's receipt for this turn: its name and whatever it
 * returned (already parsed from the executor's JSON). */
export interface DataToolReceipt {
  tool: string;
  result: unknown;
}

interface Vocabulary {
  /** Every specific string token pulled out of the tool result(s): filenames,
   * citations, subjects, titles, names, ids. Lower-cased for matching. */
  known: Set<string>;
  /** How many list-shaped items each tool actually returned, keyed by tool
   * name — for the count check. Zero is a valid, meaningful count. */
  counts: Map<string, number>;
  /** True once at least one receipt was found to build a vocabulary from. */
  any: boolean;
}

/** File-extension list broad enough to catch what people actually attach —
 * not trying to be exhaustive, just to catch the shapes items 33/41 saw
 * (.pdf, .docx, .csv, .txt) plus the common neighbours. */
const FILE_EXT = 'pdf|docx?|xlsx?|csv|txt|pptx?|png|jpe?g|md|json|zip|eml|msg';

/** A filename-shaped token: a short run of word/number/punctuation segments
 * immediately before the extension, e.g. "Crystal Rodriguez.pdf" or
 * "Plan-Comparison.csv". The match itself is deliberately loose (up to 4
 * leading segments, so it does not miss a real multi-word filename) because
 * ordinary prose has no second '.' to stop a regex early — "I found Lease
 * Agreement.pdf" would otherwise match as far back as "I". `trimToFilename`
 * below does the real narrowing: it drops leading words that are common
 * English filler (verbs, articles, pronouns) rather than plausible filename
 * words, so what is actually checked against the vocabulary is the filename,
 * not the sentence that introduced it. */
const FILENAME_TOKEN = new RegExp(
  `\\b[\\w][\\w'&-]{0,30}(?:[ _-][\\w][\\w'&-]{0,30}){0,3}\\.(?:${FILE_EXT})\\b`,
  'gi',
);

/** Common English words that introduce a filename in a sentence but are never
 * themselves part of one — stripped from the FRONT of a loose FILENAME_TOKEN
 * match before it is checked against the vocabulary. Short and closed-class
 * on purpose (pronouns, articles, conjunctions, the handful of reporting
 * verbs a reply about search results actually uses); anything not on this
 * list is left alone and treated as a possible filename word, because a false
 * positive here (treating a real filename word as filler) is worse than
 * leaving an extra filler word attached to the token being checked. */
const LEADING_FILLER = new Set([
  'i', 'you', 'your', 'yours', 'it', 'its', 'we', 'our', 'they', 'their', 'a', 'an', 'the',
  'and', 'or', 'but', 'also', 'these', 'those', 'this', 'that',
  'found', 'see', 'have', 'has', 'is', 'are', 'was', 'were', 'include', 'includes', 'including',
  'named', 'called', 'indexed', 'file', 'files', 'document', 'documents', 'one', 'two', 'three',
]);

/** Narrows a loose FILENAME_TOKEN match down to the trailing run that is
 * actually filename-shaped, by dropping LEADING_FILLER words off the front.
 * "I found Lease Agreement.pdf" -> "Lease Agreement.pdf". A match that is
 * ALL filler up to the extension (should not happen given the regex requires
 * a leading word character glued to it) falls back to the original text. */
function trimToFilename(raw: string): string {
  const words = raw.trim().split(/\s+/);
  let start = 0;
  while (start < words.length - 1 && LEADING_FILLER.has(words[start].toLowerCase())) start += 1;
  const trimmed = words.slice(start).join(' ');
  return trimmed || raw.trim();
}

/** Recursively collect every string value in a JSON-ish structure, so the
 * vocabulary does not need to know each tool's exact shape — new fields in a
 * result are picked up for free. Bounded depth/size: this walks a single
 * tool result, not an attacker-controlled blob. */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 2000) return;
  if (typeof value === 'string') {
    if (value.length >= 2 && value.length <= 300) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out, depth + 1);
  }
}

/** The array field a tool's result is "about", for the count check — the
 * thing a person means when they ask "how many did you find". Absent for
 * single-item tools (read_email, get_event), which have nothing to count. */
const RESULT_ARRAY_FIELD: Record<string, string> = {
  search_documents: 'hits',
  list_documents: 'documents',
  search_email: 'emails',
  query_calendar: 'events',
  search_contacts: 'contacts',
};

function buildVocabulary(receipts: DataToolReceipt[]): Vocabulary {
  const known = new Set<string>();
  const counts = new Map<string, number>();
  let any = false;

  for (const receipt of receipts) {
    if (!DATA_CLAIM_TOOLS.has(receipt.tool)) continue;
    const result = receipt.result;
    if (!result || typeof result !== 'object' || (result as { ok?: unknown }).ok !== true) continue;
    any = true;

    const strings: string[] = [];
    collectStrings(result, strings);
    for (const s of strings) known.add(s.toLowerCase());

    const field = RESULT_ARRAY_FIELD[receipt.tool];
    if (field) {
      const arr = (result as Record<string, unknown>)[field];
      if (Array.isArray(arr)) counts.set(receipt.tool, arr.length);
    }
  }
  return { known, counts, any };
}

/** True when `token` (already lower-cased) is grounded in the vocabulary —
 * either present verbatim, or present as a substring of some known string (a
 * reply quoting "Rodriguez.pdf" from a known "Crystal Rodriguez.pdf, page 3"
 * citation should pass, not trip the guard on its own honest paraphrase). */
function isGrounded(token: string, known: Set<string>): boolean {
  if (known.has(token)) return true;
  for (const k of known) {
    if (k.includes(token) || token.includes(k)) return true;
  }
  return false;
}

/** Spelled-out small numbers, because item 41's real incident said "zero" out
 * loud ("reporting differently on every check — zero, then 38, then this") —
 * a digit-only \d+ regex would have missed exactly the word that started that
 * incident. Covers 0-20, which is the range a count-of-search-results reply
 * plausibly spells out; anything larger is said as a digit in practice. */
const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, none: 0, no: 0,
};
const WORD_NUMBER_PATTERN = Object.keys(WORD_NUMBERS).join('|');

/** Numbers in the reply that read as "this is how many the tool found" —
 * "9 files", "3 emails", "your 12 documents", "8 indexed documents", or the
 * spelled-out form ("zero files", "no documents"). Deliberately narrow to the
 * document/mail/calendar/contact nouns these tools deal in, so an unrelated
 * number in the reply (a phone number, a price) is never treated as a count
 * claim. */
const COUNT_CLAIM = new RegExp(
  `\\b(\\d+|${WORD_NUMBER_PATTERN})\\s+(?:indexed\\s+|matching\\s+|connected\\s+)?`
  + '(files?|documents?|emails?|e-mails?|messages?|events?|meetings?|contacts?|hits?|results?|matches?)\\b',
  'gi',
);

/** `m[1]` from COUNT_CLAIM as an actual number, whichever form matched. */
function parseClaimedCount(raw: string): number {
  const digits = Number(raw);
  if (Number.isFinite(digits)) return digits;
  return WORD_NUMBERS[raw.toLowerCase()] ?? NaN;
}

/** Which tool a count noun most likely refers to, so "3 emails" is checked
 * against search_email's count and not list_documents'. */
const NOUN_TOOL: Record<string, string[]> = {
  file: ['list_documents', 'search_documents'],
  files: ['list_documents', 'search_documents'],
  document: ['list_documents', 'search_documents'],
  documents: ['list_documents', 'search_documents'],
  hit: ['search_documents'],
  hits: ['search_documents'],
  result: ['search_documents', 'search_email', 'search_contacts'],
  results: ['search_documents', 'search_email', 'search_contacts'],
  match: ['search_documents', 'search_email', 'search_contacts'],
  matches: ['search_documents', 'search_email', 'search_contacts'],
  email: ['search_email'],
  emails: ['search_email'],
  'e-mail': ['search_email'],
  'e-mails': ['search_email'],
  message: ['search_email'],
  messages: ['search_email'],
  event: ['query_calendar'],
  events: ['query_calendar'],
  meeting: ['query_calendar'],
  meetings: ['query_calendar'],
  contact: ['search_contacts'],
  contacts: ['search_contacts'],
};

export interface DataClaimVerdict {
  fabricated: boolean;
  /** Human-readable reasons, for the audit log — never shown to the user. */
  reasons: string[];
}

/**
 * Checks `reply` against the real results of every data-returning tool that
 * executed this turn. Returns fabricated: true the moment either check finds
 * a specific that is not grounded in what the tools actually returned.
 *
 * Silent (fabricated: false) when no data tool ran this turn — this guard has
 * nothing to compare against and must never fire on an ordinary conversation.
 */
export function checkDataClaims(reply: string, receipts: DataToolReceipt[]): DataClaimVerdict {
  const reasons: string[] = [];
  if (!reply) return { fabricated: false, reasons };

  const vocab = buildVocabulary(receipts);
  if (!vocab.any) return { fabricated: false, reasons };

  // ---- filenames named in the reply that the tool never returned ---------
  const filenameMatches = reply.match(FILENAME_TOKEN) ?? [];
  for (const raw of filenameMatches) {
    const filename = trimToFilename(raw);
    const token = filename.toLowerCase();
    if (!isGrounded(token, vocab.known)) {
      reasons.push(`reply names a file ("${filename}") not present in this turn's tool result`);
    }
  }

  // ---- counts that contradict the tool's actual result length ------------
  for (const m of reply.matchAll(COUNT_CLAIM)) {
    const claimed = parseClaimedCount(m[1]);
    if (!Number.isFinite(claimed)) continue;
    const noun = m[2].toLowerCase();
    const tools = NOUN_TOOL[noun] ?? [];
    for (const tool of tools) {
      const actual = vocab.counts.get(tool);
      if (actual === undefined) continue; // that tool did not run; not this guard's business
      if (claimed !== actual) {
        reasons.push(`reply states ${claimed} ${noun}, but ${tool} actually returned ${actual}`);
      }
    }
  }

  return { fabricated: reasons.length > 0, reasons };
}

/** The corrective re-prompt. Worded to point the model at the one thing it is
 * allowed to use: the tool result already in the conversation — not a fresh
 * guess, not a hedge, the actual data. */
export const DATA_CLAIM_GUARD_REPROMPT =
  '[system integrity check] Your previous reply stated specific file names, counts, or details that do '
  + 'not match what the tool actually returned this turn. Look ONLY at the tool result already in this '
  + 'conversation and rewrite your reply using exactly what it contains — no other file names, no other '
  + 'counts. If the tool result was empty, say so plainly. Never state a number or a name that is not '
  + 'literally present in that tool result.';

/** What the person sees when the model doubles down: same pattern as
 * claimGuard's fallback — the fabrication is replaced, not decorated, and the
 * person is told plainly rather than being handed a second wrong answer. */
export const DATA_CLAIM_GUARD_FALLBACK =
  'I need to correct myself: my last answer included file names or counts that do not match what I '
  + 'actually found. I do not trust that answer — please ask again and I will read the real result '
  + 'carefully, or tell me if you would rather check the source directly.';

// ---------------------------------------------------------------------------
// The 2026-09-04 gap: a reply that narrates search/read results with ZERO
// data tools run this turn at all.
//
// checkDataClaims above only engages when at least one DATA_CLAIM_TOOLS
// receipt with `ok: true` exists (`buildVocabulary`'s `any` flag) — by design,
// because with no receipt there is nothing to compare specifics against. That
// design is correct for its job (checking specifics against a real result)
// but leaves a hole one layer up: a reply that never called any tool at all,
// yet confidently NARRATES having run a search and reports invented results,
// has nothing to be checked against and so sailed through silent. Real
// incident: Roman typed "Test"; 6ms later (no time for a real tool call;
// `meta` was `{}`) the reply said "Search for 'test' returned eight passages
// across six files" with specific fabricated file names. Two earlier,
// near-identical occurrences the same night confirm this is a reproducible
// trigger on short/ambiguous messages, not a one-off.
//
// This is a DIFFERENT, narrower and more clear-cut violation than either
// existing guard: claimGuard.ts's ACTED_ON vocabulary is scheduling/
// messaging verbs ("set", "sent", "scheduled") and does not match search/read
// narration at all; checkDataClaims needs a receipt to engage. Here there is
// no receipt AND the reply itself asserts one exists. That is worse than a
// mismatched claim — it is a claim with nothing behind it whatsoever — so it
// gets its own detector, wired into the SAME re-prompt/fallback mechanism
// already proven for the other two guards, not a new architecture.

/** Phrases that assert a search/read/query tool was actually run and report
 * on what it returned. Deliberately narrow to REPORTING results, not asking
 * about capability or intent ("can I search", "I'll search", "should I look")
 * — those are honest and must never trip this. Covers the document family
 * (search_documents/list_documents) and the item-17 read family (mail,
 * calendar, contacts) since the same zero-receipt narration is possible for
 * any of them. */
const NARRATED_SEARCH_PATTERNS: RegExp[] = [
  // "search for 'x' returned...", "searching your documents returned..."
  /\bsearch(?:ing|ed)?\s+(?:for\s+[^.!?\n]{0,60}?)?(?:returned|found|turned up|surfaced)\b/i,
  // "I searched your documents/email/calendar/contacts and found..."
  /\bI\s+(?:just\s+|already\s+)?searched\b[^.!?\n]{0,60}?\b(?:and\s+)?(?:found|got|returned)\b/i,
  // "I checked your calendar/email/contacts and found..."
  /\bI\s+(?:just\s+|already\s+)?checked\b[^.!?\n]{0,60}?\b(?:your|the)\b[^.!?\n]{0,40}?\b(?:and\s+)?found\b/i,
  // "I looked through your documents/files and found..."
  /\bI\s+(?:just\s+)?looked\s+(?:through|at|in)\b[^.!?\n]{0,60}?\bfound\b/i,
  // "found N passages/files/hits/matches/results across M files" — the exact
  // incident shape, general enough to catch it without requiring "search".
  /\b(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:passages?|excerpts?|snippets?|hits?|matches?|results?)\b[^.!?\n]{0,40}?\bacross\b[^.!?\n]{0,30}?\bfiles?\b/i,
  // "your search for 'x' returned/found..." (passive framing of the same claim)
  /\byour\s+search\b[^.!?\n]{0,40}?\b(?:returned|found)\b/i,
];

/** Same honesty escape hatch as claimGuard.ts: negation, futurity, offers,
 * questions — a reply using any of these is describing what it has NOT done
 * or is offering to do, not narrating a completed search, and must pass. */
const HONEST_SEARCH_MARKERS: RegExp[] = [
  /\b(?:can't|cannot|can not|couldn't|could not|unable to|not able to|haven't|have not|hasn't|has not|didn't|did not|wasn't|was not|isn't|is not)\b/i,
  /\b(?:not\s+(?:yet\s+)?searched|no\s+search)\b/i,
  /\b(?:would you|should I|do you want|shall I|want me to|I(?:'ll| will| can| could)\s+search)\b/i,
  /\bif you(?:'d| would)? like\b/i,
];

/**
 * Fires when `reply` narrates having run a search/read/query and reports
 * specific results, but `receipts` contains ZERO entries from
 * DATA_CLAIM_TOOLS this turn — i.e. there is no tool call at all for the
 * claim to even be checked against. This is stricter and fires in MORE cases
 * than checkDataClaims's silence-when-no-receipt behavior: that function's
 * silence is correct when the reply makes no claim to have searched; this
 * function's job is exactly the case where it does make that claim anyway.
 *
 * Deliberately does not touch or replace checkDataClaims — this is an
 * ADDITIONAL, earlier check. If a data tool DID run this turn (any receipt in
 * DATA_CLAIM_TOOLS present, `ok` true or false — an attempted call still
 * means a call happened), this function is silent and checkDataClaims alone
 * governs, exactly as before.
 */
export function checkNarratedSearchWithoutTool(
  reply: string,
  receipts: DataToolReceipt[],
): DataClaimVerdict {
  const reasons: string[] = [];
  if (!reply) return { fabricated: false, reasons };

  // Mailbox reachability is volatile and stricter than stored connection
  // status: only the dedicated live probe can substantiate availability.
  const emailAvailable = /\b(?:email|mail|gmail|outlook|mailbox)\b[^.!?\n]{0,50}\b(?:is|are|looks?|seems?)\s+(?:currently\s+)?(?:available|connected|working|online|ready)\b|\bI\s+(?:can|am able to)\s+(?:see|access|read|reach)\s+(?:your\s+)?(?:emails?|mail|gmail|outlook|mailbox)\b/i.test(reply);
  if (emailAvailable && !HONEST_SEARCH_MARKERS.some((p) => p.test(reply))) {
    const live = receipts.find((r) => r.tool === 'check_email_availability' && r.result && typeof r.result === 'object'
      && (r.result as {ok?:boolean;available?:boolean}).ok === true && (r.result as {available?:boolean}).available === true);
    if (!live) return { fabricated: true, reasons: ['email availability requires a successful live mailbox check this turn'] };
  }

  // Runtime connectivity is volatile. File search receipts and old chat cannot
  // substantiate a current connection/indexing assertion.
  const statusClaim = /\b(?:(?:your|the)\s+)?(?:google drive|onedrive|dropbox|box|nextcloud|storage|nas|local workspace|provider|account|folders?)\b[^.!?\n]{0,60}\b(?:is|are|has|have)\s+(?:currently\s+)?(?:connected|disconnected|indexed|synced|available|healthy|offline|online)\b/i.test(reply);
  if (statusClaim && !HONEST_SEARCH_MARKERS.some((p) => p.test(reply))) {
    const current = receipts.find((r) => r.tool === 'get_provider_status' &&
      r.result && typeof r.result === 'object' && (r.result as {ok?: boolean}).ok);
    const receipt = current ? (current.result as {receipt?: string}).receipt : undefined;
    if (!receipt) {
      return { fabricated: true, reasons: ['runtime provider/storage claim requires a current get_provider_status receipt'] };
    }
  }

  // Any attempted data-tool call this turn — success or failure — means a
  // real tool call exists for checkDataClaims to reason about; this function
  // only covers the case where NOTHING was called at all.
  const anyDataToolCalled = receipts.some((r) => DATA_CLAIM_TOOLS.has(r.tool));
  if (anyDataToolCalled) return { fabricated: false, reasons };

  if (HONEST_SEARCH_MARKERS.some((p) => p.test(reply))) return { fabricated: false, reasons };

  if (NARRATED_SEARCH_PATTERNS.some((p) => p.test(reply))) {
    reasons.push(
      'reply narrates running a search/read and reports specific results, but no data tool executed this turn',
    );
  }

  return { fabricated: reasons.length > 0, reasons };
}

/** The corrective re-prompt for the zero-tool-call case. Worded differently
 * from DATA_CLAIM_GUARD_REPROMPT on purpose: there is no real tool result to
 * "look only at" here — the honest paths are to actually call the tool now,
 * or admit plainly that nothing was searched yet. */
export const NARRATED_SEARCH_GUARD_REPROMPT =
  '[system integrity check] Your previous reply described running a search or lookup and reported '
  + 'specific results, but you did not call any tool this turn — nothing was actually searched. '
  + 'Runtime connectivity/indexing claims require get_provider_status this turn. Keep its receipt as internal evidence and never expose it. Either '
  + 'call the appropriate tool NOW to really search, or rewrite your reply to say honestly that you have '
  + 'not searched yet. Never report file names, passages, counts, or other specifics from a search that '
  + 'did not happen.';

/** What the person sees when the model doubles down with no receipt at all:
 * plainer than DATA_CLAIM_GUARD_FALLBACK because there is no partial result
 * to point to — the whole claim was invented. */
export const NARRATED_SEARCH_GUARD_FALLBACK =
  'I need to correct myself: I described search results in my last answer, but I never actually searched '
  + 'anything — that was invented. Ask me again and I will run the real search this time, or tell me if '
  + 'you would rather check the source directly.';
