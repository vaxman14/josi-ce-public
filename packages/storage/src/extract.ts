// Turning a file's bytes into searchable text — for the formats where that is
// honest to do without a parser.
//
// Plain text is decoded directly; PDF, Office/OpenDocument and images go
// through bundled parsers. Everything else is recorded as `unsupported_type`,
// whose explanation to the owner reads "Josi cannot read this kind of file
// yet". A file counted and honestly skipped is the house rule.
//
// Nothing in this module touches the network or the providers. Bytes in,
// segments out, and the decision of what to DO with a refusal stays with the
// caller — which is what makes the whole matrix testable without a database.
import { appendEvent, type Db } from '@josi-ce/core';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { createWorker } from 'tesseract.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { SkipReason } from './gates.js';

export interface ExtractedSegment {
  locatorKind: 'none' | 'line' | 'heading';
  locator: string;
  content: string;
}

/** Formats read as text directly. Deliberately a list of what IS plain text
 * rather than a guess from the bytes: a `.docx` that happens to decode as
 * UTF-8 garbage must not be indexed as garbage. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm',
]);
export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']);

/** image/* media types a vision-capable adapter can actually be sent, keyed by
 * extension. `bmp` and `tif`/`tiff` are deliberately absent: they are real
 * extensions Josi can OCR for the document pipeline, but no mainstream model
 * vision API accepts them, so a chat attachment in one of these formats is
 * honestly "cannot see this" rather than a media type sent and silently
 * rejected by the provider. */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const XML_OFFICE_EXTENSIONS = new Set(['pptx', 'odt', 'ods', 'odp']);
const require = createRequire(import.meta.url);
const OCR_LANGUAGE_PATH = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');

/** How much text one document may contribute to the index. Generous for
 * documents, small next to the database — and a ceiling, not a target. */
export const MAX_EXTRACT_CHARS = 500_000;

export function isExtractableExtension(extension: string): boolean {
  const ext = extension.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ext === 'pdf' || ext === 'docx' || ext === 'xlsx'
    || XML_OFFICE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

export function looksLikeCredentialFile(filename: string, text = ''): boolean {
  const name = filename.toLowerCase();
  if (/(^|[-_. ])(cred(ential)?s?|passwords?|passwd|recovery[-_ ]?codes?|backup[-_ ]?codes?|private[-_ ]?key|tokens?|secrets?)([-_. ]|$)/i.test(name)) return true;
  const sample = text.slice(0, 32_000);
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(sample)
    || /\b(?:api[_ -]?key|client[_ -]?secret|refresh[_ -]?token|password)\s*[:=]\s*\S{8,}/i.test(sample);
}

export async function extractRichSegments(
  args: { extension: string; bytes: Buffer; ocrImages?: boolean },
): Promise<ExtractedSegment[] | null> {
  const ext = args.extension.toLowerCase();
  const plain = extractSegments(args);
  if (plain) return plain;
  let text = '';
  if (ext === 'pdf') {
    const parser = new PDFParse({ data: args.bytes });
    try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
  } else if (ext === 'docx') {
    text = (await mammoth.extractRawText({ buffer: Buffer.from(args.bytes) })).value;
  } else if (ext === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(args.bytes) as unknown as ExcelJS.Buffer);
    const rows: string[] = [];
    workbook.eachSheet((sheet) => sheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((value: ExcelJS.CellValue) => (
        typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
      )).join('\t'));
    }));
    text = rows.join('\n');
  } else if (XML_OFFICE_EXTENSIONS.has(ext)) {
    const files = unzipSync(new Uint8Array(args.bytes));
    text = Object.entries(files).filter(([name]) => /\.(?:xml|txt)$/i.test(name))
      .map(([, bytes]) => stripHtml(Buffer.from(bytes).toString('utf8'))).join('\n');
  } else if (IMAGE_EXTENSIONS.has(ext)) {
    // OCR is opt-in, and only the document-ingestion pipeline (Drive/OneDrive
    // folder sync) opts in — where an "image" routed through here is very
    // often actually a scanned page, and recognized text is a fair thing to
    // index. Chat attachments call this with `ocrImages` left false: running
    // OCR on an ordinary photo and handing the garbled result to the model as
    // if it were a description is worse than no description at all, and that
    // is exactly the bug this option exists to stop. With it off, an image
    // simply produces no extracted text — not a null return, an EMPTY one—
    // the caller decides what an image with no text means for its own path.
    if (!args.ocrImages) return null;
    // Language data ships inside the image. Indexing a photo must not quietly
    // download a model from a CDN or stop working on an offline installation.
    const worker = await createWorker('eng', undefined, { langPath: OCR_LANGUAGE_PATH });
    try {
      const image = Buffer.from(args.bytes) as unknown as Parameters<typeof worker.recognize>[0];
      text = (await worker.recognize(image)).data.text;
    } finally { await worker.terminate(); }
  } else return null;
  text = text.replace(/\u0000/g, '').trim().slice(0, MAX_EXTRACT_CHARS);
  return text ? [{ locatorKind: 'none', locator: '', content: text }] : null;
}

/** Markup stripped, entities the bare minimum, structure ignored. Search wants
 * the words; anything smarter belongs to a real parser in a later round. */
function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The text of one file, or null when this format is not one Josi can read yet.
 *
 * Null is a STATEMENT, not a failure: the caller records `unsupported_type`
 * and the owner sees the honest sentence. A decode that produces control-byte
 * soup (a mislabelled binary) also comes back null rather than polluting the
 * index with noise.
 */
export function extractSegments(
  args: { extension: string; bytes: Buffer },
): ExtractedSegment[] | null {
  const extension = args.extension.toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return null;

  let text = args.bytes.toString('utf8');
  // A replacement character every few bytes means this was never text.
  const junk = (text.slice(0, 4000).match(/\uFFFD/g) ?? []).length;
  if (junk > 40) return null;

  if (extension === 'html' || extension === 'htm') text = stripHtml(text);
  text = text.replace(/\u0000/g, '').trim();
  if (!text) return null;
  if (text.length > MAX_EXTRACT_CHARS) text = text.slice(0, MAX_EXTRACT_CHARS);

  return [{ locatorKind: 'none', locator: '', content: text }];
}

/** Write what was extracted, replacing whatever was there.
 *
 * Replacement, not append: an edited file's old text must not stay searchable
 * next to its new text. The document becomes `indexed`, which is what opens
 * the search gate for it.
 */
export async function storeExtraction(
  db: Db,
  args: { documentId: string; ownerUserId: string; segments: ExtractedSegment[] },
): Promise<void> {
  const content = args.segments.map((s) => s.content).join('\n\n');
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await db.query(
    `insert into document_text (document_id, owner_user_id, content, locator_kind, char_count)
     values ($1, $2, $3, 'none', $4)`,
    [args.documentId, args.ownerUserId, content, content.length],
  );
  for (let i = 0; i < args.segments.length; i++) {
    const segment = args.segments[i];
    await db.query(
      `insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
       values ($1, $2, $3, $4, $5, $6)`,
      [args.documentId, args.ownerUserId, i, segment.locatorKind, segment.locator, segment.content],
    );
  }
  await db.query(
    `update documents set state = 'indexed', skip_reason = null where id = $1`,
    [args.documentId],
  );
}

/** M74: a file passed over gets a reason, its derived text goes with it, and
 * the audit record carries the reason — never the filename. The same shape as
 * ingest's private markSkipped, exported here for the steps AFTER the gates:
 * a download that failed, a format Josi cannot read, bytes that turned out
 * encrypted once fetched. */
export async function skipDocument(
  db: Db,
  args: {
    documentId: string;
    ownerUserId: string;
    reason: SkipReason;
  },
): Promise<void> {
  await db.query(
    `update documents set state = 'skipped', skip_reason = $2 where id = $1`,
    [args.documentId, args.reason],
  );
  await db.query(`delete from document_text where document_id = $1`, [args.documentId]);
  await db.query(`delete from document_segments where document_id = $1`, [args.documentId]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'system',
    kind: 'storage.file_skipped',
    subjectType: 'document',
    subjectId: args.documentId,
    payload: { reason: args.reason },
  });
}
