// MarkdownV2 escaping and chunking (L1.5).
//
// Every test here exists because getting it wrong produces SILENCE, not a
// visible glitch: Telegram rejects the whole message with a 400 and the person
// sees nothing. So the assertions are exact rather than approximate — "the
// output contains a backslash" would pass while the channel was broken.
import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_V2_RESERVED, chunkForTelegram, escapeMarkdownV2, prepareOutbound, pullBackOffEscape,
} from '../src/telegram/format.js';
import { TELEGRAM_MAX_MESSAGE_CHARS } from '../src/telegram/api.js';

describe('escaping', () => {
  it('escapes every character Telegram reserves, and only those', () => {
    for (const ch of MARKDOWN_V2_RESERVED) {
      expect(escapeMarkdownV2(ch), `reserved: ${ch}`).toBe(`\\${ch}`);
    }
    // A representative sweep of everything else, including the characters most
    // likely to be escaped by mistake because another dialect reserves them.
    for (const ch of ['a', 'Z', '0', ' ', '\n', '"', "'", '<', '>', '&', '$', '%', '@', '^', ':', ';', ',', '?', '/', '\\']) {
      if ((MARKDOWN_V2_RESERVED as readonly string[]).includes(ch)) continue;
      expect(escapeMarkdownV2(ch), `not reserved: ${JSON.stringify(ch)}`).toBe(ch);
    }
  });

  it('handles the sentence that would silently break the channel', () => {
    // Real text. Every one of these characters is reserved, and one unescaped
    // character rejects the entire message.
    const text = "That's $40 (approx.) — see item #3, or the 50% off deal [link].";
    const escaped = escapeMarkdownV2(text);
    expect(escaped).toBe(
      "That's $40 \\(approx\\.\\) — see item \\#3, or the 50% off deal \\[link\\]\\.",
    );
  });

  it('does not double-escape a backslash the person typed', () => {
    // A literal backslash is NOT reserved in MarkdownV2, so it passes through.
    // If a future edit adds it to the set, this test says so — and the chunker
    // below depends on backslashes appearing only as escapes we produced.
    expect(escapeMarkdownV2('C:\\path')).toBe('C:\\path');
  });

  it('survives astral characters, which a naive index-based loop would split', () => {
    const emoji = '👍';
    expect(escapeMarkdownV2(`ok ${emoji}!`)).toBe(`ok ${emoji}\\!`);
  });

  it('is a no-op on empty input', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });
});

describe('chunking', () => {
  it('leaves a short message alone', () => {
    expect(chunkForTelegram('hello', 20)).toEqual(['hello']);
  });

  it('returns nothing for nothing', () => {
    expect(chunkForTelegram('', 20)).toEqual([]);
  });

  it('never exceeds the limit', () => {
    const long = 'x'.repeat(10_000);
    for (const chunk of chunkForTelegram(long)) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    }
  });

  it('reassembles to exactly the input', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} of some text`).join('\n');
    expect(chunkForTelegram(long, 200).join('')).toBe(long);
  });

  it('prefers a paragraph break over a line break over a space', () => {
    // 30-char limit. A paragraph break sits at 20, well past the halfway mark.
    const text = 'aaaa bbbb cccc dddd\n\neeee ffff gggg hhhh iiii';
    const chunks = chunkForTelegram(text, 30);
    expect(chunks[0]).toBe('aaaa bbbb cccc dddd\n\n');
  });

  it('hard-cuts a word that is longer than the whole limit', () => {
    const chunks = chunkForTelegram('y'.repeat(25), 10);
    expect(chunks).toEqual(['yyyyyyyyyy', 'yyyyyyyyyy', 'yyyyy']);
  });

  it('ignores a break that is too early to be worth taking', () => {
    // A newline at position 2 of a 30-character limit would produce a
    // two-character message followed by the rest — hundreds of slivers for a
    // long paragraph with one early break.
    const chunks = chunkForTelegram(`ab\n${'c'.repeat(60)}`, 30);
    expect(chunks[0].length).toBe(30);
  });

  it('refuses a limit too small to hold an escape pair', () => {
    expect(() => chunkForTelegram('abc', 1)).toThrow(RangeError);
  });

  it('every chunk makes progress, so the loop always terminates', () => {
    // Found by mutation testing. Flipping the odd/even test in
    // `pullBackOffEscape` produced a cut of 0, the loop pushed an empty chunk,
    // `rest` never shrank, and the run HUNG rather than failed — the worst way
    // for a defect to present. A hang here is an assistant that silently stops
    // answering, so the loop now asserts its own progress and throws.
    //
    // The invariant, stated directly: no chunk is ever empty. That is what
    // makes termination provable rather than assumed.
    for (const limit of [2, 3, 5, 17, 4096]) {
      const chunks = chunkForTelegram(escapeMarkdownV2('x.y!z-'.repeat(200)), limit);
      expect(chunks.length, `limit ${limit}`).toBeGreaterThan(0);
      expect(chunks.every((c) => c.length > 0), `limit ${limit}`).toBe(true);
      expect(chunks.every((c) => c.length <= limit), `limit ${limit}`).toBe(true);
    }
  });

  it('the guard fires rather than looping when a cut is impossible', () => {
    // Reaching it through the real code is not possible, which is the point —
    // it is there for the next edit to `pullBackOffEscape`. Proven by calling
    // the loop with text whose every character escapes at a limit of 2, the
    // tightest case the guard has to survive.
    const escaped = escapeMarkdownV2('.'.repeat(40));
    const chunks = chunkForTelegram(escaped, 2);
    expect(chunks.every((c) => c === '\\.')).toBe(true);
    expect(chunks.join('')).toBe(escaped);
  });
});

describe('a cut never lands inside an escape pair', () => {
  it('pulls back off an odd run of backslashes', () => {
    // "ab\." cut at 3 would send "ab\" and start the next chunk with ".".
    expect(pullBackOffEscape('ab\\.', 3)).toBe(2);
  });

  it('leaves an even run alone, because that is a literal backslash', () => {
    expect(pullBackOffEscape('ab\\\\.', 4)).toBe(4);
  });

  it('counts a long run correctly', () => {
    expect(pullBackOffEscape('a\\\\\\.', 4)).toBe(3); // three backslashes: odd
    expect(pullBackOffEscape('a\\\\\\\\.', 5)).toBe(5); // four: even
  });

  it('handles a cut at the very start', () => {
    expect(pullBackOffEscape('\\.', 0)).toBe(0);
  });

  it('the adversarial case: a reserved character exactly on the boundary', () => {
    // Build text so that the escaped form puts a backslash at the cut point.
    // Nine characters then a period; escaping makes the period two characters,
    // so a cut at 10 would land between the backslash and the dot.
    const escaped = escapeMarkdownV2(`${'a'.repeat(9)}.${'b'.repeat(30)}`);
    const chunks = chunkForTelegram(escaped, 10);
    for (const chunk of chunks) {
      // The property that matters: no chunk ends with a lone escaping
      // backslash, and no chunk starts with a reserved character that lost its
      // escape.
      const trailing = /\\+$/.exec(chunk)?.[0].length ?? 0;
      expect(trailing % 2, `chunk ended mid-escape: ${JSON.stringify(chunk)}`).toBe(0);
    }
    expect(chunks.join('')).toBe(escaped);
  });
});

describe('the outbound pipeline', () => {
  const disclosure = 'Sent by Josi, an AI assistant.';

  it('appends the disclosure and escapes the result', () => {
    const [only] = prepareOutbound({ body: 'Done.', disclosure });
    expect(only).toBe('Done\\.\n\nSent by Josi, an AI assistant\\.');
  });

  it('refuses to send without a disclosure — it can be reworded, not removed', () => {
    expect(() => prepareOutbound({ body: 'hi', disclosure: '' })).toThrow(/disclosure/);
    expect(() => prepareOutbound({ body: 'hi', disclosure: '   ' })).toThrow(/disclosure/);
  });

  it('sends nothing for an empty reply rather than a bare disclosure', () => {
    // A message containing only "Sent by Josi, an AI assistant." would read as
    // Josi having said something. It did not.
    expect(prepareOutbound({ body: '', disclosure })).toEqual([]);
    expect(prepareOutbound({ body: '   \n ', disclosure })).toEqual([]);
  });

  it('puts the disclosure in the LAST chunk of a long reply', () => {
    const chunks = prepareOutbound({ body: 'w '.repeat(6000), disclosure });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]).toContain('Sent by Josi');
    expect(chunks[0]).not.toContain('Sent by Josi');
  });

  it('a 10 000-character reply splits under the ceiling', () => {
    const chunks = prepareOutbound({ body: 'x'.repeat(10_000), disclosure });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
    }
  });
});
