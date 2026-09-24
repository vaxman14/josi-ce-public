// Turning a reply into something Telegram will accept.
//
// TWO PROBLEMS, AND THEY INTERACT BADLY
//
// 1. MarkdownV2 reserves eighteen characters. An unescaped one anywhere in the
//    message makes Telegram reject the WHOLE message with a 400 — so a person
//    asking Josi about a price ("that's $40 (approx.)") gets silence, not a
//    formatting glitch. The failure mode of getting this wrong is a channel
//    that works until somebody types a bracket.
//
// 2. Messages are capped at 4096 characters. Splitting has to happen AFTER
//    escaping, because escaping grows the text — and it must never split
//    between a backslash and the character it escapes, which would send a
//    dangling escape at the end of one chunk and an unescaped reserved
//    character at the start of the next. That is the bug that turns a long
//    answer into two rejected requests.
//
// So this file escapes first, then splits on escape-aware boundaries, and the
// tests assert both halves including the adversarial case where a reserved
// character lands exactly on the boundary.
//
// Josi's own system prompt asks for plain text with no markdown, so nothing
// here tries to PRESERVE formatting. It makes arbitrary text safe to send.

import { TELEGRAM_MAX_MESSAGE_CHARS } from './api.js';

/** Telegram's MarkdownV2 reserved set, verbatim from the Bot API docs. Written
 * out rather than expressed as a range so a future change is a visible diff. */
export const MARKDOWN_V2_RESERVED = [
  '_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|',
  '{', '}', '.', '!',
] as const;

const RESERVED_SET = new Set<string>(MARKDOWN_V2_RESERVED);

/**
 * Escapes every reserved character.
 *
 * Character by character rather than a regex with a class, because the class
 * has to escape its own metacharacters and a mistake there is invisible: the
 * expression still compiles and silently stops matching one character. A loop
 * over an explicit set cannot have that bug, and at these message sizes the
 * cost is irrelevant.
 */
export function escapeMarkdownV2(text: string): string {
  let out = '';
  for (const ch of text) {
    if (RESERVED_SET.has(ch)) out += '\\';
    out += ch;
  }
  return out;
}

/**
 * Splits escaped text into sendable chunks.
 *
 * Preference order for a break point, best first:
 *   1. a paragraph break, so a split reads as a pause
 *   2. a line break
 *   3. a space
 *   4. a hard cut, because a 4096-character word still has to be sent
 *
 * In every case the boundary is corrected so it never falls immediately after
 * an escaping backslash. `limit` is a parameter so the tests can drive the
 * boundary cases with short strings instead of building 4096-character
 * fixtures that nobody can read in a diff.
 */
export function chunkForTelegram(
  escaped: string,
  limit: number = TELEGRAM_MAX_MESSAGE_CHARS,
): string[] {
  if (limit < 2) throw new RangeError('a chunk limit below 2 cannot hold an escape pair');
  if (escaped.length === 0) return [];
  if (escaped.length <= limit) return [escaped];

  const chunks: string[] = [];
  let rest = escaped;

  while (rest.length > limit) {
    let cut = limit;
    for (const sep of ['\n\n', '\n', ' ']) {
      const at = rest.lastIndexOf(sep, limit);
      // Only take a natural break if it is not so early that the chunk becomes
      // a sliver — otherwise a single early newline in a long paragraph would
      // produce hundreds of tiny messages.
      if (at > limit * 0.5) { cut = at + sep.length; break; }
    }
    cut = pullBackOffEscape(rest, cut);

    // PROGRESS OR THROW.
    //
    // Found by mutation testing: flipping the odd/even test in
    // `pullBackOffEscape` makes it return a cut of 0 (or -1), the loop pushes
    // an empty chunk, `rest` never shrinks, and the whole thing spins forever.
    // That hung the test run rather than failing it, which is the worst way for
    // a defect to present — but the reason it matters is not the harness. This
    // loop runs on every outbound reply, and a hang here is an assistant that
    // stops answering with no error anywhere.
    //
    // A cut that makes no progress is a bug in the code above, so this throws
    // rather than papering over it with `Math.max(1, cut)`: a silently
    // mis-chunked message would be rejected by Telegram anyway, and a caller
    // that sees an exception can say so.
    if (cut <= 0 || cut > rest.length) {
      throw new RangeError(
        `chunking made no progress (cut=${cut}, remaining=${rest.length}) — this is a bug`,
      );
    }

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/**
 * Moves a cut point back so it never lands between a backslash and what it
 * escapes.
 *
 * Counts the run of backslashes ending at the cut: an ODD run means the last
 * one is escaping the character that would start the next chunk, so the cut
 * moves back one. An even run is `\\` pairs — a literal backslash — and is
 * safe to cut after.
 */
export function pullBackOffEscape(text: string, cut: number): number {
  let backslashes = 0;
  let i = cut - 1;
  while (i >= 0 && text[i] === '\\') { backslashes += 1; i -= 1; }
  return backslashes % 2 === 1 ? cut - 1 : cut;
}

/**
 * The whole outbound text pipeline: disclose, escape, split.
 *
 * M41's discipline carries to this channel. Mail must say a message came from
 * an assistant; a Telegram reply is the same claim in a different envelope, and
 * a person who linked their account months ago should not have to remember.
 * The disclosure is appended to the LAST chunk, so a long answer does not repeat
 * it and a person reading only the first chunk is not misled — the conversation
 * as a whole carries it, exactly as an email signature does.
 *
 * An empty disclosure is refused rather than tolerated, matching
 * `identity.ts`'s rule that the wording is customisable and the presence is not.
 */
export function prepareOutbound(args: {
  body: string;
  disclosure: string;
  limit?: number;
}): string[] {
  const body = args.body.trim();
  const disclosure = args.disclosure.trim();
  if (!disclosure) {
    throw new Error('the AI disclosure is missing — it can be reworded but not removed');
  }
  if (!body) return [];

  const escaped = escapeMarkdownV2(`${body}\n\n${disclosure}`);
  return chunkForTelegram(escaped, args.limit);
}
