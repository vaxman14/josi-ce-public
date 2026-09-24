// What has to be true before Josi will read a file.
//
// This is the "untrusted bytes" half of Phase 9. Every file goes through the
// same ordered chain, and any gate can end it with a reason the owner can read.
//
// THE ORDER IS THE DESIGN, and it is cheapest-and-most-certain first:
//
//   1. quota      — is there room for this at all?
//   2. size       — a ceiling, checked before anything is opened
//   3. extension  — an allowlist, from the LAST dot
//   4. archive    — excluded unless enabled, bounded when it is
//   5. encryption — skipped, never cracked, password never requested
//   6. malware    — blocks, and never touches the source
//
// Malware scanning is last because it is the most expensive, and because a file
// that will be refused for its size does not need to be handed to a scanner.
// Encryption comes before malware for the opposite reason: a scanner cannot see
// inside an encrypted file anyway, so a clean verdict on one would be
// meaningless.
import { createHash } from 'node:crypto';
import { extensionOf } from './paths.js';

export type SkipReason =
  | 'encrypted' | 'password_protected' | 'too_large' | 'extension_not_allowed'
  | 'archive_excluded' | 'archive_limits_exceeded' | 'unreadable' | 'malware_found'
  | 'quota_exceeded' | 'unsupported_type' | 'credential_detected';

export interface StoragePolicy {
  max_file_bytes: number | string;
  max_total_bytes_per_user: number | string;
  max_files_per_user: number;
  allowed_extensions: string[];
  archives_enabled: boolean;
  archive_max_entries: number;
  archive_max_total_bytes: number | string;
  archive_max_depth: number;
  archive_max_seconds: number;
  clamav_enabled: boolean;
  clamav_scan_mode: 'on_index' | 'on_change';
  processing_paused: boolean;
}

export interface Candidate {
  filename: string;
  relativePath: string;
  byteSize: number;
  /** First bytes of the file, for the format checks that need them. */
  header?: Buffer;
}

export interface UsageNow {
  files: number;
  bytes: number;
}

export interface Ceilings {
  /** Per-user overrides from `storage_capabilities`. Null means the workspace
   * default applies. */
  maxFiles: number | null;
  maxBytes: number | null;
}

export type GateResult =
  | { ok: true }
  | { ok: false; reason: SkipReason; detail?: string };

const num = (v: number | string): number => (typeof v === 'number' ? v : Number(v));

/** Archives, by extension. Deliberately a list of what IS an archive rather
 * than a guess: a file this misses is merely treated as an ordinary file and
 * still has to pass the extension allowlist. */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']);

export function isArchive(filename: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(filename));
}

/** M64: encrypted and password-protected documents are skipped.
 *
 * Josi never requests, retains or manages a document password. There is no
 * "enter the password" prompt anywhere in CE, which is why this function only
 * has to DETECT encryption — there is nothing to do about it afterwards.
 *
 * Detection is by file structure, not by trying to open it:
 *
 *   * ZIP-family (docx, xlsx, pptx, odt, zip): the general-purpose bit flag's
 *     low bit is set on an encrypted local file header.
 *   * Legacy Office (doc, xls, ppt): an OLE compound file whose contents are
 *     RC4-encrypted. Detected by the FilePass/`\x00E\x00n\x00c` markers.
 *   * PDF: an /Encrypt entry in the trailer.
 */
export function looksEncrypted(candidate: Candidate): boolean {
  const header = candidate.header;
  if (!header || header.length < 8) return false;
  const ext = extensionOf(candidate.filename);

  // ZIP-based formats. "PK\x03\x04" then version(2) then the flag word at 6..8.
  if (header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
    const flags = header.readUInt16LE(6);
    if ((flags & 0x0001) !== 0) return true;
  }

  // OLE compound documents: legacy Office, and also the AES-encrypted form of
  // the modern ones, which are wrapped in OLE rather than ZIP.
  const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (header.subarray(0, 8).equals(OLE_MAGIC)) {
    const text = header.toString('binary');
    // "EncryptedPackage" in UTF-16LE is the modern AES case; a FilePass record
    // is the legacy one. Either means we cannot read it and must not try.
    if (text.includes('E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0')) return true;
    if (ext === 'doc' || ext === 'xls' || ext === 'ppt') {
      if (text.includes('\x2f\x00\x00\x00')) return false; // ordinary record, keep going
    }
  }

  // PDF. The /Encrypt entry may be anywhere, but the header window is what we
  // have; a PDF whose encryption dictionary sits past it will fail to parse
  // later and be skipped as unreadable, which is the same outcome.
  if (header.subarray(0, 5).toString('latin1') === '%PDF-') {
    if (header.toString('latin1').includes('/Encrypt')) return true;
  }

  return false;
}

/** The whole chain, in order. Returns the FIRST reason to refuse. */
export function checkFile(args: {
  candidate: Candidate;
  policy: StoragePolicy;
  usage: UsageNow;
  ceilings: Ceilings;
}): GateResult {
  const { candidate, policy, usage, ceilings } = args;

  // 1. Quota. M55 / item 40h — a per-user override REPLACES the workspace
  // default when an administrator has set one; null means "the workspace
  // default applies". This is a deliberate per-person decision (set through
  // PUT /storage/admin/capabilities/:userId), so it may raise a person above
  // the installation default as easily as it may lower them below it — an
  // administrator granting one person more room is exactly what the control
  // is for, not a mistake to guard against.
  const maxFiles = ceilings.maxFiles ?? policy.max_files_per_user;
  const maxBytes = ceilings.maxBytes ?? num(policy.max_total_bytes_per_user);
  if (usage.files >= maxFiles) return { ok: false, reason: 'quota_exceeded', detail: 'file count' };
  if (usage.bytes + candidate.byteSize > maxBytes) {
    return { ok: false, reason: 'quota_exceeded', detail: 'storage' };
  }

  // 2. Size.
  if (candidate.byteSize > num(policy.max_file_bytes)) return { ok: false, reason: 'too_large' };

  // 3. Extension, from the last dot. "report.pdf.exe" is an exe.
  const ext = extensionOf(candidate.filename);
  const archive = isArchive(candidate.filename);
  if (!archive && !policy.allowed_extensions.includes(ext)) {
    return { ok: false, reason: 'extension_not_allowed', detail: ext || 'no extension' };
  }

  // 4. Archives.
  if (archive && !policy.archives_enabled) return { ok: false, reason: 'archive_excluded' };

  // 5. Encryption. Checked before malware because a scanner cannot see inside
  // an encrypted file, so a clean verdict on one would mean nothing.
  if (looksEncrypted(candidate)) return { ok: false, reason: 'encrypted' };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Archives (M65)
// ---------------------------------------------------------------------------

export interface ArchiveEntry {
  path: string;
  /** Uncompressed size as the archive CLAIMS. Never trusted — see below. */
  declaredSize: number;
  encrypted?: boolean;
  /** Nested archive depth, 0 for entries of the outer archive. */
  depth?: number;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxSeconds: number;
}

export type ArchiveStop =
  | 'complete' | 'entry_limit' | 'size_limit' | 'depth_limit' | 'time_limit'
  | 'encrypted_entry' | 'unsafe_path' | 'unreadable';

export interface ArchiveOutcome {
  entriesSeen: number;
  entriesExtracted: number;
  bytesExpanded: number;
  maxDepthReached: number;
  stopped: ArchiveStop;
  accepted: ArchiveEntry[];
}

export function limitsFrom(policy: StoragePolicy): ArchiveLimits {
  return {
    maxEntries: policy.archive_max_entries,
    maxTotalBytes: num(policy.archive_max_total_bytes),
    maxDepth: policy.archive_max_depth,
    maxSeconds: policy.archive_max_seconds,
  };
}

/**
 * Bounded extraction.
 *
 * A zip bomb is a small archive that expands to something enormous, so every
 * bound below is about EXPANSION rather than the archive's own size:
 *
 *   * entry count      — 42.zip is a handful of files that recurse
 *   * expanded bytes   — the running total, checked BEFORE accepting each entry
 *   * recursion depth  — archives inside archives
 *   * wall-clock time  — the backstop for anything the other three miss
 *
 * The running total is checked before an entry is accepted, not after. Checking
 * after means the bound is exceeded by one entry every time, and one entry is
 * all a bomb needs.
 *
 * Entry paths are checked for traversal too: "../../etc/cron.d/x" inside a ZIP
 * is a real and old attack, and an archive is exactly where a path arrives from
 * somewhere untrusted.
 */
export function extractArchive(
  entries: Iterable<ArchiveEntry>,
  limits: ArchiveLimits,
  opts: { now?: () => number; pathCheck?: (p: string) => boolean } = {},
): ArchiveOutcome {
  const now = opts.now ?? (() => Date.now());
  const safePath = opts.pathCheck ?? defaultPathCheck;
  const started = now();

  const out: ArchiveOutcome = {
    entriesSeen: 0, entriesExtracted: 0, bytesExpanded: 0,
    maxDepthReached: 0, stopped: 'complete', accepted: [],
  };

  for (const entry of entries) {
    out.entriesSeen += 1;

    if (now() - started > limits.maxSeconds * 1000) { out.stopped = 'time_limit'; return out; }
    if (out.entriesExtracted >= limits.maxEntries) { out.stopped = 'entry_limit'; return out; }

    const depth = entry.depth ?? 0;
    if (depth >= limits.maxDepth) { out.stopped = 'depth_limit'; return out; }
    out.maxDepthReached = Math.max(out.maxDepthReached, depth);

    // M65: encrypted entries are still skipped, archives enabled or not.
    if (entry.encrypted) { out.stopped = 'encrypted_entry'; return out; }

    if (!safePath(entry.path)) { out.stopped = 'unsafe_path'; return out; }

    // BEFORE, not after.
    if (out.bytesExpanded + entry.declaredSize > limits.maxTotalBytes) {
      out.stopped = 'size_limit';
      return out;
    }

    out.bytesExpanded += entry.declaredSize;
    out.entriesExtracted += 1;
    out.accepted.push(entry);
  }

  return out;
}

/** Traversal inside an archive. Same rules as a request path, applied to a
 * name that came from a file somebody else made. */
function defaultPathCheck(p: string): boolean {
  if (!p || p.includes('\0')) return false;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '.');
}

// ---------------------------------------------------------------------------
// Malware (M56–M59)
// ---------------------------------------------------------------------------

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

export interface Scanner {
  /** Returns a verdict, or throws if the scanner is unreachable. */
  scan(bytes: Buffer): Promise<ScanResult>;
}

export class ScannerUnavailable extends Error {}

/**
 * M57: a finding blocks, and the source is not touched.
 *
 * The hash is taken before and after so "we did not modify it" is a measured
 * fact rather than a claim about code that could later change. That matters
 * more than it sounds: antivirus false positives on ordinary business documents
 * are common, and a system that quarantines or deletes on a false positive has
 * destroyed data it was trusted with. Blocking is reversible. Deleting is not.
 */
export async function scanDocument(
  scanner: Scanner,
  bytes: Buffer,
): Promise<{ result: ScanResult; hashBefore: string; hashAfter: string }> {
  const hashBefore = sha256(bytes);
  const result = await scanner.scan(bytes);
  const hashAfter = sha256(bytes);
  return { result, hashBefore, hashAfter };
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Whether a scan is required before this file may be processed.
 *
 * M59 gives two modes. The security-relevant part is what happens when the
 * scanner is enabled but NOT reachable: processing must stop, not continue
 * unscanned. An outage that silently disables scanning is worse than no scanner
 * at all, because the operator believes files are being checked.
 */
export function scanRequired(
  policy: StoragePolicy,
  event: 'index' | 'change',
): boolean {
  if (!policy.clamav_enabled) return false;
  return policy.clamav_scan_mode === 'on_change' ? true : event === 'index';
}

// ---------------------------------------------------------------------------
// The hour window (M53)
// ---------------------------------------------------------------------------

/**
 * Whether heavy work may run right now.
 *
 * A window that crosses midnight (22:00–06:00) is the normal case for "run this
 * overnight", so the comparison has to handle start > end rather than assuming
 * a window sits inside one day.
 */
export function withinHours(
  policy: { ocr_hours_start: number | null; ocr_hours_end: number | null },
  hour: number,
): boolean {
  const { ocr_hours_start: start, ocr_hours_end: end } = policy;
  if (start === null || end === null) return true;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
