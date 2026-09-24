import { inflateRawSync } from 'node:zlib';
import { LIMITS, MigrationError, type MigrationFile } from './types.js';

export function safePath(path: string): string {
  if (!path || path.length > 240 || /[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith('/')) {
    throw new MigrationError('Unsafe archive or upload path.');
  }
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.length > 12 || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new MigrationError('Path traversal or excessive directory depth refused.');
  }
  return path;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32 stored/deflate only. Never extracts to disk. Inspect ALL directory
 * entries before inflating, then enforce actual output bounds independently.
 * ZIP64, multipart, encryption, links, overlapping data and nested ZIPs fail
 * closed. Local headers must agree with the authoritative central directory. */
export function readZip(bytes: Buffer): MigrationFile[] {
  const fail = (reason = 'Malformed or unsupported ZIP archive.'): never => { throw new MigrationError(reason, 413); };
  if (bytes.length > LIMITS.uploadBytes || bytes.length < 22) fail('Archive exceeds 8 MiB or is not a ZIP.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)
      || bytes.readUInt16LE(end + 8) !== count || central + centralSize !== end) fail();
  if (!count || count > LIMITS.files) fail('ZIP must contain between 1 and 200 entries.');
  const entries: Array<{ path: string; start: number; size: number; expanded: number; method: number; crc: number }> = [];
  const ranges: Array<[number, number]> = [];
  const names = new Set<string>();
  let offset = central, total = 0;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20), expanded = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30);
    const next = offset + 46 + nameLength + extraLength + bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), attrs = bytes.readUInt32LE(offset + 38);
    if (next > end || bytes.readUInt16LE(offset + 34) || (flags & ~0x080e) || ![0, 8].includes(method) || (method === 0 && size !== expanded)) fail();
    const type = (attrs >>> 16) & 0xf000;
    if (type && type !== 0x8000 && type !== 0x4000) fail('Symlinks and special files are refused.');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    let path: string;
    try { path = safePath(utf8.decode(nameBytes)); } catch { return fail('Unsafe or non-UTF-8 ZIP path.'); }
    if (names.has(path.toLowerCase())) fail('Duplicate ZIP paths are ambiguous.');
    names.add(path.toLowerCase());
    if (/\.zip$/i.test(path)) fail('Nested archives are not supported.');
    total += expanded;
    if (expanded > LIMITS.entryBytes || total > LIMITS.expandedBytes || expanded > Math.max(1, size) * LIMITS.ratio) {
      fail('Expanded size or compression ratio exceeds the migration limits.');
    }
    // Extra ZIP64 fields are refused even when the 32-bit sizes appear small.
    for (let p = offset + 46 + nameLength; p < offset + 46 + nameLength + extraLength;) {
      if (p + 4 > offset + 46 + nameLength + extraLength) fail();
      if (bytes.readUInt16LE(p) === 1) fail('ZIP64 archives are not supported.');
      p += 4 + bytes.readUInt16LE(p + 2);
      if (p > offset + 46 + nameLength + extraLength) fail();
    }
    if (local + 30 > central || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail();
    const localName = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    if (start + size > central || !bytes.subarray(local + 30, local + 30 + localName).equals(nameBytes)) fail();
    const crc = bytes.readUInt32LE(offset + 16);
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== size
      || bytes.readUInt32LE(local + 22) !== expanded)) fail();
    ranges.push([local, start + size]);
    if (path.endsWith('/')) { if (expanded || size || type === 0x8000) fail(); }
    else { if (type === 0x4000) fail(); entries.push({ path, start, size, expanded, method, crc }); }
    offset = next;
  }
  if (offset !== end) fail();
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) fail('Overlapping ZIP entries refused.');
  return entries.map(entry => {
    let output: Buffer;
    try {
      const input = bytes.subarray(entry.start, entry.start + entry.size);
      output = entry.method === 0 ? Buffer.from(input) : inflateRawSync(input, { maxOutputLength: LIMITS.entryBytes });
    } catch { return fail('ZIP entry could not be safely decompressed.'); }
    if (output.length !== entry.expanded || crc32(output) !== entry.crc) fail('ZIP size or checksum mismatch.');
    return { path: entry.path, bytes: output };
  });
}

export function unpackUploads(files: MigrationFile[]): MigrationFile[] {
  if (!files.length || files.length > LIMITS.uploadFiles) throw new MigrationError('Choose 1–100 files.');
  if (files.reduce((n, f) => n + f.bytes.length, 0) > LIMITS.uploadBytes) throw new MigrationError('Uploads exceed 8 MiB.', 413);
  for (const file of files) safePath(file.path);
  if (files.some(file => /\.zip$/i.test(file.path))) {
    if (files.length !== 1) throw new MigrationError('Upload one ZIP, or individual files, in separate scans.');
    return readZip(files[0].bytes);
  }
  if (files.some(file => file.bytes.length > LIMITS.entryBytes)) throw new MigrationError('An individual file exceeds 1 MiB.', 413);
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) throw new MigrationError('Duplicate upload paths are ambiguous.');
  return files;
}
