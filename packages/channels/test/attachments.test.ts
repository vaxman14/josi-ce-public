// Attachment gates (L1.6).
//
// Every input in an attachment is a CLAIM chosen by the sender: the size, the
// MIME type, and above all the filename. So the tests here are mostly hostile
// names and lying declarations, and the assertion is always that CE refused
// before doing any work.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { createUser } from '../../auth/src/users.js';
import { listEvents } from '../../core/src/events.js';
import {
  ALLOWED_ATTACHMENT_EXTENSIONS, checkAttachment, isUnsafeName, recordAttachment, safeExtension,
} from '../src/telegram/attachments.js';

const ON = { enabled: true, maxBytes: 1024 * 1024 };
const OFF = { enabled: false, maxBytes: 1024 * 1024 };

describe('extracting an extension from a name the sender chose', () => {
  it('takes the last component and lowercases it', () => {
    expect(safeExtension('Report.PDF')).toBe('pdf');
    expect(safeExtension('a/b/c/notes.md')).toBe('md');
    expect(safeExtension('a\\b\\notes.md')).toBe('md');
  });

  it('resolves a double extension to the one the OS would honour', () => {
    // `invoice.pdf.exe` is an executable wearing a document's name.
    expect(safeExtension('invoice.pdf.exe')).toBe('exe');
  });

  it('gives nothing for a name with no usable extension', () => {
    for (const name of ['', 'noext', '.hidden', 'trailing.', 'a.verylongextension', 'a.p df', 'a.p/df']) {
      expect(safeExtension(name), name).toBe('');
    }
  });

  it('gives nothing when a null byte is present', () => {
    // Anything after a null byte is invisible to some consumers and visible to
    // others, and a disagreement about what a file is called is worth refusing.
    expect(safeExtension('safe.txt\0.exe')).toBe('');
  });

  it('handles undefined and null without throwing', () => {
    expect(safeExtension(null)).toBe('');
    expect(safeExtension(undefined)).toBe('');
  });
});

describe('names that are attacks rather than names', () => {
  it('spots traversal, absolute paths and null bytes', () => {
    for (const name of ['../../etc/passwd', '..', '/etc/passwd', '\\\\server\\share', 'C:\\Windows\\x', 'a\0b']) {
      expect(isUnsafeName(name), name).toBe(true);
    }
  });

  it('leaves an ordinary name alone', () => {
    for (const name of ['report.pdf', 'Q3 notes (final).docx', 'наш-файл.txt', '2026.01.01.csv']) {
      expect(isUnsafeName(name), name).toBe(false);
    }
  });
});

describe('the gate', () => {
  it('refuses everything when the administrator has not turned attachments on', () => {
    const verdict = checkAttachment(
      { fileId: 'f', fileName: 'a.txt', declaredBytes: 10 }, OFF,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('attachments_disabled');
  });

  it('refuses an over-size file before a byte is fetched', () => {
    const verdict = checkAttachment(
      { fileId: 'f', fileName: 'a.pdf', declaredBytes: 5 * 1024 * 1024 }, ON,
    );
    expect(verdict.outcome).toBe('too_large');
    // The message names the ceiling so the sender can act on it, and names no
    // path and nobody else's limit.
    expect(verdict.message).toContain('1 MB');
  });

  it('refuses a hostile name before considering anything else', () => {
    const verdict = checkAttachment(
      { fileId: 'f', fileName: '../../etc/passwd.txt', declaredBytes: 10 }, ON,
    );
    expect(verdict.outcome).toBe('unsafe_name');
  });

  it('refuses an executable MIME type whatever the name says', () => {
    // The deny list exists separately from the allowlist so that a future edit
    // widening the allowlist still cannot let a binary through.
    const verdict = checkAttachment(
      { fileId: 'f', fileName: 'invoice.pdf', mimeType: 'application/x-msdownload', declaredBytes: 10 },
      ON,
    );
    expect(verdict.outcome).toBe('type_not_allowed');
  });

  it('ignores MIME parameters when matching', () => {
    const verdict = checkAttachment(
      { fileId: 'f', fileName: 'x.sh', mimeType: 'application/x-sh; charset=utf-8', declaredBytes: 10 },
      ON,
    );
    expect(verdict.outcome).toBe('type_not_allowed');
  });

  it('accepts each format on the allowlist', () => {
    for (const ext of ALLOWED_ATTACHMENT_EXTENSIONS) {
      const verdict = checkAttachment({ fileId: 'f', fileName: `a.${ext}`, declaredBytes: 10 }, ON);
      expect(verdict.ok, ext).toBe(true);
      expect(verdict.extension).toBe(ext);
    }
  });

  it('refuses a format that is not on it', () => {
    for (const ext of ['exe', 'sh', 'zip', 'mp4', 'doc', 'xls', 'html', 'svg']) {
      const verdict = checkAttachment({ fileId: 'f', fileName: `a.${ext}`, declaredBytes: 10 }, ON);
      expect(verdict.ok, ext).toBe(false);
      expect(verdict.outcome).toBe('type_not_allowed');
    }
  });

  it('accepts a Telegram photo, which arrives with no filename at all', () => {
    const verdict = checkAttachment(
      { fileId: 'f', fileName: null, mimeType: 'image/jpeg', declaredBytes: 1000 }, ON,
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.extension).toBe('jpeg');
  });

  it('refuses an unnamed file that is not a recognised image', () => {
    // "We could not tell what this is" is not a reason to accept it.
    const verdict = checkAttachment(
      { fileId: 'f', fileName: null, mimeType: 'application/octet-stream', declaredBytes: 10 }, ON,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.outcome).toBe('type_not_allowed');
  });

  it('the size gate runs before the type gate', () => {
    // A 500 MB .exe should be refused for the reason that costs least to
    // determine, and either refusal is correct — but the ORDER is what keeps a
    // flood of huge files cheap to reject.
    const verdict = checkAttachment(
      { fileId: 'f', fileName: 'x.exe', declaredBytes: 500 * 1024 * 1024 }, ON,
    );
    expect(verdict.outcome).toBe('too_large');
  });
});

describe('recording the decision', () => {
  let db: TestDb;
  let user: string;

  beforeEach(async () => {
    db = await testDb();
    await ensureWorkspace(db, {});
    user = (await createUser(db, {
      email: 'a@example.test', username: 'a', role: 'super_admin',
    })).id;
  });

  it('keeps the outcome and the extension, and never the filename', async () => {
    const attachment = {
      fileId: 'f', fileUniqueId: 'u1', fileName: 'salary-review-2026.xlsx',
      declaredBytes: 99, mimeType: null,
    };
    const verdict = checkAttachment(attachment, ON);
    await recordAttachment(db, { chatId: 5, userId: user, attachment, verdict });

    const rows = await db.query<Record<string, unknown>>(`select * from telegram_attachments`);
    expect(rows).toHaveLength(1);
    // Phase 9 established that a filename is content: "salary-review-2026.xlsx
    // was too large" tells an administrator what somebody earns.
    expect(JSON.stringify(rows[0])).not.toContain('salary-review');
    expect(rows[0].outcome).toBe('accepted');
    expect(rows[0].extension).toBe('xlsx');

    const events = await listEvents(db, { kind: 'telegram.attachment' });
    expect(JSON.stringify(events[0].payload)).not.toContain('salary-review');
    expect(events[0].payload).toMatchObject({ outcome: 'accepted', extension: 'xlsx' });
  });
});
