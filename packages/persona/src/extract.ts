// What may be learned from a conversation.
//
// This is the narrowest part of Phase 12.1 and deliberately so. An assistant
// that decides for itself what is worth remembering about somebody will
// eventually remember something they did not say, and they will find out months
// later when it repeats it.
//
// So the rules here are restrictive to the point of being boring:
//
//   1. ONLY THE PERSON'S OWN WORDS. Never the model's reply, never tool output.
//      A model claim stored as a fact about its owner is a fabrication with a
//      long life, and tool output is somebody else's data — a document's
//      contents, a colleague's email — which has its own lifetime and its own
//      revocation rules.
//
//   2. ONLY EXPLICIT SELF-STATEMENTS. "I prefer X" is a statement. "They seem
//      to like X" is an inference, and inference is where a memory store starts
//      quietly building a profile nobody consented to.
//
//   3. NOTHING TRANSIENT. "Book me a table tonight" is a request, not a fact
//      about a person, and remembering it is how an assistant ends up
//      confidently wrong next Tuesday.
//
//   4. NO SECRETS, and no sensitive inference. Health, religion, politics,
//      sexuality, immigration status and criminal history are refused as
//      CATEGORIES even when stated explicitly, because a durable store designed
//      to be recalled and repeated is the wrong place for them and the person
//      has not asked for that. They can still add such a memory by hand — that
//      is their choice to make deliberately, not the assistant's to make for
//      them.
import { refuseSecret } from './memory.js';

export interface Candidate {
  content: string;
  /** Which pattern matched, for provenance the person can read. */
  kind: 'preference' | 'identity' | 'constraint' | 'routine';
  confidence: number;
}

/**
 * Explicit self-statements, and nothing else.
 *
 * Each pattern requires a first-person subject. That single requirement is what
 * keeps the model's own claims and a document's contents out: neither says "I".
 */
const PATTERNS: Array<{ re: RegExp; kind: Candidate['kind']; confidence: number }> = [
  // "call me Alex", "my name is Alex"
  { re: /^\s*(?:please\s+)?call me ([A-Za-z][\w' -]{1,40})\s*\.?$/i, kind: 'identity', confidence: 0.8 },
  { re: /\bmy (?:preferred )?name is ([A-Za-z][\w' -]{1,40})\b/i, kind: 'identity', confidence: 0.8 },
  { re: /\bmy pronouns are ([\w/ ]{2,30})\b/i, kind: 'identity', confidence: 0.85 },
  { re: /\bi(?:'m| am) (?:based |located )?in ([A-Z][\w .'-]{2,40})\b/, kind: 'identity', confidence: 0.6 },
  { re: /\bmy time ?zone is ([\w/+\- ]{2,40})\b/i, kind: 'identity', confidence: 0.8 },

  // Durable preferences.
  { re: /\bi (?:prefer|always want|would rather) ([^.!?\n]{3,120})/i, kind: 'preference', confidence: 0.7 },
  { re: /\bi (?:hate|dislike|never want|don'?t want) ([^.!?\n]{3,120})/i, kind: 'preference', confidence: 0.7 },
  // First person, or an instruction addressed to Josi. NOT a bare "always",
  // which matched "She always works mornings" — an observation about somebody
  // else, and an assistant recording those is building a profile nobody
  // consented to. Found by a test written to exercise the third-person case.
  { re: /\bi (?:always|never) ([^.!?\n]{3,120})/i, kind: 'preference', confidence: 0.55 },
  { re: /^\s*please (?:always|never) ([^.!?\n]{3,120})/i, kind: 'preference', confidence: 0.6 },

  // Standing constraints.
  { re: /\bi(?:'m| am) allergic to ([^.!?\n]{2,60})/i, kind: 'constraint', confidence: 0.8 },
  { re: /\bi (?:can'?t|cannot) ([^.!?\n]{3,100})/i, kind: 'constraint', confidence: 0.5 },

  // Recurring routine.
  { re: /\bi (?:usually|normally|typically) ([^.!?\n]{3,120})/i, kind: 'routine', confidence: 0.6 },
];

/** Categories refused outright, even when stated plainly.
 *
 * Not because the statement is untrue or unimportant — because an assistant
 * deciding on its own to keep a durable record of somebody's health or beliefs
 * is a decision the person should make, not one made for them by a regex. */
const SENSITIVE = [
  /\b(diagnos\w+|cancer|depress\w+|anxiety|therapy|medication|prescri\w+|disab\w+|pregnan\w+|HIV)\b/i,
  /\b(muslim|christian|jewish|hindu|buddhist|atheist|church|mosque|synagogue)\b/i,
  /\b(vote[ds]?|voting|labour|tory|republican|democrat|conservative party)\b/i,
  /\b(gay|lesbian|bisexual|transgender|queer|sexuality)\b/i,
  /\b(visa|immigration|asylum|deported|green card|citizenship status)\b/i,
  /\b(arrest\w*|convict\w*|criminal record|probation|lawsuit against me)\b/i,
];

/** Requests, which are not facts. */
const TRANSIENT = [
  /\b(today|tonight|tomorrow|this (morning|afternoon|evening|week)|right now|asap)\b/i,
  // Stem plus ANY suffix, and the irregular past. A hand-written suffix list
  // missed "booked", then missed "reminders" and "sent" — three attempts at
  // enumerating English. Over-matching here refuses to learn something, which
  // is the safe direction; under-matching turns a request with a deadline into
  // a permanent fact about somebody.
  /\b(book|send|sent|schedul|cancel|remind|draft|forward|repl|arrang|organis|organiz)\w*/i,
  /\?\s*$/,
];

export const MAX_CANDIDATES_PER_TURN = 2;
export const MAX_CANDIDATE_LENGTH = 200;

/**
 * Pull durable facts out of ONE message the person wrote.
 *
 * Returns at most two, because a turn that produces five "facts" has almost
 * certainly matched a sentence it should not have, and because a person facing
 * a queue of suggestions stops reading them.
 */
export function extractDurableFacts(userMessage: string): Candidate[] {
  const text = (userMessage ?? '').trim();
  if (!text || text.length > 4000) return [];

  const out: Candidate[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/[.!?\n]/)) {
    const sentence = line.trim();
    if (!sentence || sentence.length < 6) continue;

    // A request is not a fact about a person.
    if (TRANSIENT.some((re) => re.test(sentence))) continue;
    // Sensitive categories are the person's to record deliberately.
    if (SENSITIVE.some((re) => re.test(sentence))) continue;
    // Credentials never, in any form.
    if (refuseSecret(sentence)) continue;

    for (const { re, kind, confidence } of PATTERNS) {
      const m = re.exec(sentence);
      if (!m) continue;

      // The whole sentence, trimmed — not the capture group alone, because
      // "sailing" without "I prefer" is not a fact anybody can read back.
      const content = sentence.replace(/\s+/g, ' ').slice(0, MAX_CANDIDATE_LENGTH);
      const key = content.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ content, kind, confidence });
      break;
    }
    if (out.length >= MAX_CANDIDATES_PER_TURN) break;
  }

  return out;
}

/** Provenance a person can read, rather than a source enum. */
export function provenanceFor(kind: Candidate['kind']): string {
  switch (kind) {
    case 'identity': return 'You told Josi this about yourself';
    case 'constraint': return 'You mentioned this as something that always applies';
    case 'routine': return 'You described this as what you usually do';
    case 'preference':
    default: return 'You said you prefer this';
  }
}
