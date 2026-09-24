// Untrusted bytes: the gates, with hostile fixtures.
//
// The phase plan's acceptance criteria are specific — "archive extraction is
// bounded (zip-bomb fixture)", "ClamAV finding blocks but leaves the file
// byte-identical" — so these are built as adversarial inputs rather than happy
// paths with a negative case bolted on.
import { describe, expect, it } from 'vitest';
import {
  checkFile, extractArchive, isArchive, limitsFrom, looksEncrypted,
  scanDocument, scanRequired, sha256, withinHours,
  type ArchiveEntry, type Scanner, type StoragePolicy,
} from '../src/gates.js';

const POLICY: StoragePolicy = {
  max_file_bytes: 1000,
  max_total_bytes_per_user: 10000,
  max_files_per_user: 10,
  allowed_extensions: ['txt', 'pdf', 'docx'],
  archives_enabled: false,
  archive_max_entries: 5,
  archive_max_total_bytes: 1000,
  archive_max_depth: 1,
  archive_max_seconds: 30,
  clamav_enabled: false,
  clamav_scan_mode: 'on_index',
  processing_paused: false,
};

const NO_USAGE = { files: 0, bytes: 0 };
const NO_CEILING = { maxFiles: null, maxBytes: null };

const file = (over: Partial<{ filename: string; byteSize: number; header: Buffer }> = {}) => ({
  filename: over.filename ?? 'notes.txt',
  relativePath: over.filename ?? 'notes.txt',
  byteSize: over.byteSize ?? 10,
  header: over.header,
});

const check = (over = {}, policy = POLICY, usage = NO_USAGE, ceilings = NO_CEILING) =>
  checkFile({ candidate: file(over), policy, usage, ceilings });

describe('the gate chain — M55', () => {
  it('lets an ordinary allowed file through', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('refuses a file over the size ceiling', () => {
    expect(check({ byteSize: 1001 })).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses an extension that is not on the allowlist', () => {
    expect(check({ filename: 'thing.exe' })).toMatchObject({
      ok: false, reason: 'extension_not_allowed',
    });
  });

  // The file an allowlist exists to refuse.
  it('refuses report.pdf.exe, which is an exe', () => {
    expect(check({ filename: 'report.pdf.exe' })).toMatchObject({
      ok: false, reason: 'extension_not_allowed', detail: 'exe',
    });
  });

  it('refuses a file with no extension at all', () => {
    expect(check({ filename: 'Makefile' })).toMatchObject({ ok: false, reason: 'extension_not_allowed' });
  });

  it('refuses once the file count is reached', () => {
    expect(check({}, POLICY, { files: 10, bytes: 0 })).toMatchObject({
      ok: false, reason: 'quota_exceeded', detail: 'file count',
    });
  });

  it('refuses when this file would take the total past the limit', () => {
    expect(check({ byteSize: 500 }, POLICY, { files: 1, bytes: 9600 })).toMatchObject({
      ok: false, reason: 'quota_exceeded', detail: 'storage',
    });
  });

  // M55 / item 40h: a per-user override REPLACES the workspace default — it
  // may tighten a person below the installation default, or (an
  // administrator's own deliberate decision, set through the capabilities
  // route) raise them above it. Null means "the workspace default applies".
  it('a tighter per-user ceiling is enforced below the workspace default', () => {
    const tighter = check({}, POLICY, { files: 3, bytes: 0 }, { maxFiles: 3, maxBytes: null });
    expect(tighter).toMatchObject({ ok: false, reason: 'quota_exceeded' });
  });

  it('a per-user override can raise a person above the workspace default', () => {
    // Workspace default caps file count at 10; an administrator granting this
    // person 9999 must actually let a 10th, 11th, ... file through.
    const raised = check({}, POLICY, { files: 10, bytes: 0 }, { maxFiles: 9999, maxBytes: null });
    expect(raised).toMatchObject({ ok: true });

    // Same for bytes: workspace default is 10000, this file would push total
    // usage to 10100 — over the workspace default but under a raised override.
    const raisedBytes = check(
      { byteSize: 500 }, POLICY, { files: 1, bytes: 9600 }, { maxFiles: null, maxBytes: 50000 },
    );
    expect(raisedBytes).toMatchObject({ ok: true });
  });

  it('no override at all falls back to the workspace default, both directions', () => {
    const overDefault = check({}, POLICY, { files: 10, bytes: 0 }, NO_CEILING);
    expect(overDefault).toMatchObject({ ok: false, reason: 'quota_exceeded' });
  });

  it('checks quota before size, so a full quota is the reason given', () => {
    // Order matters for what the person is told: "you are out of space" is
    // actionable, "that file is too big" sends them to shrink a file that was
    // never going to fit anyway.
    const res = check({ byteSize: 99999 }, POLICY, { files: 10, bytes: 0 });
    expect(res).toMatchObject({ reason: 'quota_exceeded' });
  });
});

describe('encrypted documents are skipped, never opened — M64', () => {
  const zip = (flags: number) => {
    const b = Buffer.alloc(32);
    b.write('PK\x03\x04', 0, 'latin1');
    b.writeUInt16LE(flags, 6);
    return b;
  };

  it('detects an encrypted ZIP-family file by its flag bit', () => {
    expect(looksEncrypted(file({ filename: 'a.docx', header: zip(0x0001) }))).toBe(true);
  });

  it('leaves an ordinary ZIP-family file alone', () => {
    expect(looksEncrypted(file({ filename: 'a.docx', header: zip(0x0000) }))).toBe(false);
  });

  it('detects an encrypted PDF', () => {
    const header = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Encrypt 9 0 R /Root 1 0 R >>', 'latin1');
    expect(looksEncrypted(file({ filename: 'a.pdf', header }))).toBe(true);
  });

  it('leaves an ordinary PDF alone', () => {
    const header = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Root 1 0 R >>', 'latin1');
    expect(looksEncrypted(file({ filename: 'a.pdf', header }))).toBe(false);
  });

  it('detects a modern Office file wrapped in encrypted OLE', () => {
    const b = Buffer.alloc(200);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
    Buffer.from('E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0', 'binary').copy(b, 32);
    expect(looksEncrypted(file({ filename: 'a.docx', header: b }))).toBe(true);
  });

  it('is refused by the chain with a reason the owner can read', () => {
    const res = check({ filename: 'a.docx', header: zip(0x0001) });
    expect(res).toMatchObject({ ok: false, reason: 'encrypted' });
  });

  it('checks encryption before malware, since a scan of an encrypted file means nothing', () => {
    // Both would apply; the chain has to give the encrypted answer.
    const policy = { ...POLICY, clamav_enabled: true };
    const res = checkFile({
      candidate: file({ filename: 'a.docx', header: zip(0x0001) }),
      policy, usage: NO_USAGE, ceilings: NO_CEILING,
    });
    expect(res).toMatchObject({ reason: 'encrypted' });
  });
});

describe('archives — M65', () => {
  it('are excluded by default', () => {
    expect(check({ filename: 'a.zip' })).toMatchObject({ ok: false, reason: 'archive_excluded' });
  });

  it('are recognised by extension', () => {
    for (const name of ['a.zip', 'a.rar', 'a.7z', 'a.tar', 'a.tgz']) {
      expect(isArchive(name), name).toBe(true);
    }
    expect(isArchive('a.txt')).toBe(false);
  });

  it('pass the extension gate when enabled, because their entries are what matter', () => {
    const policy = { ...POLICY, archives_enabled: true };
    expect(check({ filename: 'a.zip' }, policy)).toEqual({ ok: true });
  });

  const entries = (n: number, size: number, over: Partial<ArchiveEntry> = {}): ArchiveEntry[] =>
    Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, declaredSize: size, ...over }));

  const LIMITS = limitsFrom({ ...POLICY, archives_enabled: true });

  it('stops at the entry limit', () => {
    const out = extractArchive(entries(50, 1), LIMITS);
    expect(out.stopped).toBe('entry_limit');
    expect(out.entriesExtracted).toBe(5);
  });

  // The zip bomb the plan asks for: a handful of entries that claim to expand
  // to far more than the ceiling.
  it('stops a zip bomb at the size limit, BEFORE accepting the entry', () => {
    const out = extractArchive(
      [{ path: 'bomb.txt', declaredSize: 10_000_000_000 }],
      LIMITS,
    );
    expect(out.stopped).toBe('size_limit');
    expect(out.entriesExtracted).toBe(0);
    // The bound must not be exceeded even once. Checking after accepting is the
    // classic mistake, and one entry is all a bomb needs.
    expect(out.bytesExpanded).toBe(0);
    expect(out.bytesExpanded).toBeLessThanOrEqual(LIMITS.maxTotalBytes);
  });

  it('stops a gradual bomb exactly at the ceiling', () => {
    const out = extractArchive(entries(4, 400), LIMITS);
    expect(out.stopped).toBe('size_limit');
    expect(out.bytesExpanded).toBeLessThanOrEqual(LIMITS.maxTotalBytes);
    expect(out.entriesExtracted).toBe(2);
  });

  it('stops nested archives at the depth limit', () => {
    const out = extractArchive(
      [{ path: 'inner.zip', declaredSize: 10, depth: 1 }],
      LIMITS,
    );
    expect(out.stopped).toBe('depth_limit');
    expect(out.entriesExtracted).toBe(0);
  });

  it('stops on wall-clock time', () => {
    let t = 0;
    const out = extractArchive(entries(5, 1), { ...LIMITS, maxSeconds: 1 }, {
      now: () => { t += 800; return t; },
    });
    expect(out.stopped).toBe('time_limit');
  });

  // Traversal from inside an archive is old and still works against systems
  // that only validate paths that arrived over HTTP.
  it('refuses an entry whose path escapes', () => {
    for (const path of ['../../etc/cron.d/x', '/etc/passwd', 'a/../../b', 'C:/x', 'a\\b']) {
      const out = extractArchive([{ path, declaredSize: 1 }], LIMITS);
      expect(out.stopped, path).toBe('unsafe_path');
      expect(out.entriesExtracted).toBe(0);
    }
  });

  it('refuses an encrypted entry even when archives are enabled', () => {
    const out = extractArchive([{ path: 'a.txt', declaredSize: 1, encrypted: true }], LIMITS);
    expect(out.stopped).toBe('encrypted_entry');
    expect(out.entriesExtracted).toBe(0);
  });

  it('completes an ordinary archive', () => {
    const out = extractArchive(entries(3, 10), LIMITS);
    expect(out.stopped).toBe('complete');
    expect(out.entriesExtracted).toBe(3);
    expect(out.bytesExpanded).toBe(30);
  });
});

describe('malware — M56, M57, M59', () => {
  const cleanScanner: Scanner = { async scan() { return { clean: true }; } };
  const dirtyScanner: Scanner = {
    async scan() { return { clean: false, signature: 'Eicar-Test-Signature' }; },
  };

  it('leaves the source byte-identical', async () => {
    const bytes = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const before = sha256(bytes);
    const { result, hashBefore, hashAfter } = await scanDocument(dirtyScanner, bytes);

    expect(result.clean).toBe(false);
    // The plan's acceptance criterion, measured rather than asserted about code.
    expect(hashBefore).toBe(before);
    expect(hashAfter).toBe(before);
    expect(sha256(bytes)).toBe(before);
  });

  it('a scanner that mutates its input is detectable', async () => {
    // Proving the before/after hashes are a real check and not decoration.
    const rude: Scanner = {
      async scan(b) { b.fill(0); return { clean: true }; },
    };
    const bytes = Buffer.from('hello world');
    const { hashBefore, hashAfter } = await scanDocument(rude, bytes);
    expect(hashBefore).not.toBe(hashAfter);
  });

  it('is not required when the scanner is off', () => {
    expect(scanRequired(POLICY, 'index')).toBe(false);
    expect(scanRequired(POLICY, 'change')).toBe(false);
  });

  it('on_index scans at index time only', () => {
    const p = { ...POLICY, clamav_enabled: true, clamav_scan_mode: 'on_index' as const };
    expect(scanRequired(p, 'index')).toBe(true);
    expect(scanRequired(p, 'change')).toBe(false);
  });

  it('on_change scans both', () => {
    const p = { ...POLICY, clamav_enabled: true, clamav_scan_mode: 'on_change' as const };
    expect(scanRequired(p, 'index')).toBe(true);
    expect(scanRequired(p, 'change')).toBe(true);
  });

  it('a clean verdict is a clean verdict', async () => {
    const { result } = await scanDocument(cleanScanner, Buffer.from('ordinary'));
    expect(result.clean).toBe(true);
  });
});

describe('the OCR hour window — M53', () => {
  const win = (start: number | null, end: number | null) =>
    ({ ocr_hours_start: start, ocr_hours_end: end });

  it('is unrestricted when unset', () => {
    for (const h of [0, 9, 23]) expect(withinHours(win(null, null), h)).toBe(true);
  });

  it('handles an ordinary daytime window', () => {
    expect(withinHours(win(9, 17), 8)).toBe(false);
    expect(withinHours(win(9, 17), 9)).toBe(true);
    expect(withinHours(win(9, 17), 16)).toBe(true);
    expect(withinHours(win(9, 17), 17)).toBe(false);
  });

  // The normal case for "run this overnight", and the one a naive
  // start <= h < end comparison gets wrong.
  it('handles a window that crosses midnight', () => {
    expect(withinHours(win(22, 6), 23)).toBe(true);
    expect(withinHours(win(22, 6), 2)).toBe(true);
    expect(withinHours(win(22, 6), 6)).toBe(false);
    expect(withinHours(win(22, 6), 12)).toBe(false);
  });
});
