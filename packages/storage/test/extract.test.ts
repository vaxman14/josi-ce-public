// Extraction decisions, pure.
import { describe, expect, it } from 'vitest';
import { MAX_EXTRACT_CHARS, extractSegments, isExtractableExtension, looksLikeCredentialFile } from '../src/extract.js';

describe('what is extractable', () => {
  it('reads the plain-text family and nothing it would have to guess at', () => {
    for (const ext of ['txt', 'md', 'csv', 'json', 'html']) {
      expect(isExtractableExtension(ext), ext).toBe(true);
    }
    for (const ext of ['zip', 'exe', '']) {
      expect(isExtractableExtension(ext), ext).toBe(false);
    }
    for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'png']) expect(isExtractableExtension(ext), ext).toBe(true);
  });

  it('an unsupported format is a null, not an exception and not garbage in the index', () => {
    expect(extractSegments({ extension: 'pdf', bytes: Buffer.from('%PDF-1.7 …') })).toBeNull();
  });

  it('a mislabelled binary comes back null rather than polluting the index', () => {
    const noise = Buffer.from(Array.from({ length: 2000 }, (_, i) => (i * 7) % 251));
    expect(extractSegments({ extension: 'txt', bytes: noise })).toBeNull();
  });
});

describe('credential exclusion', () => {
  it('spots secrets by filename and content without flagging ordinary prose', () => {
    expect(looksLikeCredentialFile('backup-codes.txt')).toBe(true);
    expect(looksLikeCredentialFile('notes.txt', 'api_key = abcdefghijklmnop')).toBe(true);
    expect(looksLikeCredentialFile('meeting-notes.txt', 'Discuss password reset UX')).toBe(false);
  });
});

describe('what extraction produces', () => {
  it('plain text, as one segment search can cite', () => {
    const out = extractSegments({ extension: 'txt', bytes: Buffer.from('hello documents') });
    expect(out).toEqual([{ locatorKind: 'none', locator: '', content: 'hello documents' }]);
  });

  it('strips markup from HTML — the words, not the tags', () => {
    const out = extractSegments({
      extension: 'html',
      bytes: Buffer.from('<html><script>evil()</script><body><h1>Title</h1><p>body &amp; soul</p></body></html>'),
    });
    expect(out![0].content).toBe('Title body & soul');
    expect(out![0].content).not.toContain('evil');
  });

  it('caps runaway text at the ceiling', () => {
    const out = extractSegments({ extension: 'txt', bytes: Buffer.from('a'.repeat(MAX_EXTRACT_CHARS + 50)) });
    expect(out![0].content.length).toBe(MAX_EXTRACT_CHARS);
  });

  it('an empty file has nothing to index', () => {
    expect(extractSegments({ extension: 'txt', bytes: Buffer.from('   \n ') })).toBeNull();
  });
});
