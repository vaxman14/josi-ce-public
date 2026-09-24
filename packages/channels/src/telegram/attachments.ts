// Attachments arriving over Telegram.
//
// The premise is that these bytes are hostile. Somebody who has linked their
// account is not necessarily the only person with access to their phone, and a
// forwarded file has an origin nobody in this system can see. Phase 9 wrote
// that assumption down for mapped folders; this is the same assumption for a
// channel that can push a file at the server without being asked.
//
// FOUR GATES, CHEAPEST FIRST, and the order is the point — each one refuses
// without doing the work the next would need:
//
//   1. Is the channel even allowed to accept files? (a database read)
//   2. Is the declared size within the administrator's ceiling? (arithmetic)
//   3. Is the type on the allowlist? (a string check)
//   4. Do the bytes stay within the ceiling as they arrive? (the download)
//
// Gate 4 exists because gates 2 and 3 both rest on CLAIMS. `file_size` is what
// Telegram was told, the filename is what the sender chose, and `mime_type` is
// what the client asserted. None of them is evidence, which is why the download
// is capped independently in `api.ts` and why the extension is derived from a
// sanitised name rather than trusted as one.
import { appendEvent, type Db } from '@josi-ce/core';

export type AttachmentOutcome =
  | 'accepted' | 'too_large' | 'type_not_allowed' | 'attachments_disabled'
  | 'download_failed' | 'oversize_during_download' | 'unsafe_name';

/**
 * What CE will accept over this channel.
 *
 * Short on purpose, and it is the SAME question Phase 9 asks about a mapped
 * folder: can the pipeline actually do something with this. A format CE cannot
 * read is not made useful by being accepted — it is a file taking up a quota
 * and a promise nobody kept. Anything absent from this list is refused with a
 * reason the sender can read.
 */
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  'txt', 'md', 'csv', 'tsv', 'json', 'pdf',
  'png', 'jpg', 'jpeg', 'webp', 'heic',
  'docx', 'xlsx', 'pptx',
] as const;

const ALLOWED = new Set<string>(ALLOWED_ATTACHMENT_EXTENSIONS);

/** Types that must never be accepted whatever the extension says, because the
 * name is chosen by the sender. Kept as a separate deny list rather than
 * relying on the allowlist alone: a future edit that widens the allowlist by
 * accident still cannot let an executable through. */
const ALWAYS_REFUSED_MIME = [
  'application/x-msdownload', 'application/x-msdos-program', 'application/x-executable',
  'application/x-sh', 'application/x-shellscript', 'text/x-shellscript',
  'application/vnd.microsoft.portable-executable', 'application/x-mach-binary',
];

export interface IncomingAttachment {
  fileId: string;
  fileUniqueId?: string | null;
  /** What Telegram says it is. A claim. */
  declaredBytes?: number | null;
  /** What the sending client says it is. A claim. */
  mimeType?: string | null;
  /** What the sender named it. Very much a claim. */
  fileName?: string | null;
}

export interface AttachmentVerdict {
  ok: boolean;
  outcome: AttachmentOutcome;
  /** Sanitised, lowercase, no dot. Empty when the name gave nothing usable. */
  extension: string;
  /** A sentence for the sender. Never mentions a path or a limit belonging to
   * somebody else's file. */
  message: string;
}

/**
 * Reduce a sender-chosen filename to an extension, safely.
 *
 * A filename from a chat message is the classic traversal vector, and it does
 * not need to be a path here at all — nothing downstream uses the name. So the
 * name is never kept: only a short, lowercase, alphanumeric extension survives,
 * and anything that looks like a path, a null byte, or a double extension
 * trying to hide (`invoice.pdf.exe`) is resolved to the LAST component, which
 * is the one the operating system would honour.
 */
export function safeExtension(fileName: string | null | undefined): string {
  if (!fileName) return '';
  // A null byte truncates a C string; anything after it is invisible to some
  // consumers and visible to others, which is a disagreement worth refusing.
  if (fileName.includes('\0')) return '';
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

/** True when a name contains something no legitimate attachment name needs and
 * that some consumer might act on. Refused outright rather than sanitised: an
 * attachment whose name is an attack is not an attachment worth keeping. */
export function isUnsafeName(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  return fileName.includes('\0')
    || fileName.includes('..')
    || fileName.startsWith('/')
    || fileName.startsWith('\\')
    || /^[a-zA-Z]:[\\/]/.test(fileName);
}

export interface AttachmentPolicy {
  enabled: boolean;
  maxBytes: number;
}

/**
 * The decision, made before any byte is fetched.
 *
 * Deliberately pure and exported: the routing code calls it, and the tests call
 * it directly with hostile inputs that would be tedious to construct as whole
 * webhook payloads.
 */
export function checkAttachment(
  attachment: IncomingAttachment,
  policy: AttachmentPolicy,
): AttachmentVerdict {
  if (!policy.enabled) {
    return {
      ok: false, outcome: 'attachments_disabled', extension: '',
      message: 'This installation does not accept files over Telegram.',
    };
  }

  if (isUnsafeName(attachment.fileName)) {
    return {
      ok: false, outcome: 'unsafe_name', extension: '',
      message: 'That file\'s name was refused.',
    };
  }

  const declared = attachment.declaredBytes ?? 0;
  if (declared > policy.maxBytes) {
    return {
      ok: false, outcome: 'too_large', extension: safeExtension(attachment.fileName),
      message: `That file is larger than this installation accepts (${formatBytes(policy.maxBytes)}).`,
    };
  }

  const mime = (attachment.mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (ALWAYS_REFUSED_MIME.includes(mime)) {
    return {
      ok: false, outcome: 'type_not_allowed', extension: safeExtension(attachment.fileName),
      message: 'Josi does not accept that kind of file.',
    };
  }

  const extension = safeExtension(attachment.fileName);
  // A photo arrives with no filename at all, so an empty extension is allowed
  // ONLY when the declared type is an image Telegram itself produced. Anything
  // else with no usable extension is refused, because "we could not tell what
  // this is" is not a reason to accept it.
  if (!extension) {
    if (mime.startsWith('image/') && ALLOWED.has(mime.slice('image/'.length))) {
      return { ok: true, outcome: 'accepted', extension: mime.slice('image/'.length), message: '' };
    }
    return {
      ok: false, outcome: 'type_not_allowed', extension: '',
      message: 'Josi could not tell what kind of file that is, so it was not accepted.',
    };
  }
  if (!ALLOWED.has(extension)) {
    return {
      ok: false, outcome: 'type_not_allowed', extension,
      message: 'Josi does not accept that kind of file.',
    };
  }

  return { ok: true, outcome: 'accepted', extension, message: '' };
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Record the decision. Never the filename — Phase 9 established that a
 * filename is content ("salary-review-2026.xlsx was too large"), and this table
 * is read by an administrator. */
export async function recordAttachment(
  db: Db,
  args: {
    chatId: number;
    userId: string | null;
    attachment: IncomingAttachment;
    verdict: AttachmentVerdict;
    receivedBytes?: number | null;
  },
): Promise<void> {
  await db.query(
    `insert into telegram_attachments
       (chat_id, user_id, file_unique_id, declared_bytes, received_bytes, mime_type,
        extension, outcome)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      args.chatId, args.userId, args.attachment.fileUniqueId ?? null,
      args.attachment.declaredBytes ?? null, args.receivedBytes ?? null,
      args.attachment.mimeType ?? null, args.verdict.extension || null, args.verdict.outcome,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.userId,
    actor: 'system',
    kind: 'telegram.attachment',
    subjectType: 'telegram_chat',
    subjectId: String(args.chatId),
    payload: { outcome: args.verdict.outcome, extension: args.verdict.extension || null },
  });
}
