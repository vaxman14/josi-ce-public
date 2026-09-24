import { constants } from 'node:fs';
import { open, realpath, readdir, unlink, copyFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { type Db } from '@josi-ce/core';
import { looksLikeCredentialFile } from './extract.js';
import { isAttachmentContractFailure, validateAttachmentContract } from './attachmentContract.js';

export const CHAT_FILE_BYTES = 100 * 1024 * 1024;
export const CHAT_USER_BYTES = 200 * 1024 * 1024;
export const CHAT_USER_FILES = 1000;
export const CHAT_THREAD_FILES = 100;
export const CHAT_TENANT_BYTES = 2 * 1024 * 1024 * 1024;
export const attachmentRoot = () => process.env.JOSI_UPLOAD_DIR ?? (process.env.NODE_ENV === 'test' ? join(tmpdir(), 'josi-chat-attachments') : '/data/chat-attachments');
export class AttachmentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function attachmentFailure(error: unknown): AttachmentError {
  if (error instanceof AttachmentError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return new AttachmentError(507, 'storage_full', 'Attachment storage is full. Ask the administrator to free space.');
  if (code === 'EROFS') return new AttachmentError(503, 'storage_read_only', 'Attachment storage is read-only. Ask the administrator to repair the attachment volume mount.');
  if (code === 'EACCES' || code === 'EPERM') return new AttachmentError(503, 'storage_permission', 'Attachment storage permissions are incorrect. Ask the administrator to repair volume ownership.');
  if (code === 'ENOENT') return new AttachmentError(503, 'storage_missing', 'Attachment storage is missing. Ask the administrator to provision the persistent attachment volume.');
  return new AttachmentError(503, 'storage_unavailable', 'Attachment storage is unavailable. Ask the administrator to check the volume and retry.');
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pin the opened directory for every operation. No caller-supplied path or DB
// storage_path is used, and a swapped root/leaf symlink cannot redirect access.
async function directory(root: string) {
  if (await realpath(root) !== resolve(root)) throw new AttachmentError(503, 'storage_unsafe', 'Attachment storage must be a dedicated directory without symlinks.');
  return open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}
async function inDirectory<T>(root: string, id: string, fn: (path: string) => Promise<T>): Promise<T> {
  if (!UUID.test(id)) throw new AttachmentError(404, 'not_found', 'Attachment not found.');
  const dir = await directory(root);
  // Linux production pins traversal through the opened directory descriptor.
  // macOS test runners cannot traverse /dev/fd directories, so use the already
  // realpath-checked root there while retaining O_NOFOLLOW on the leaf.
  const pinnedRoot = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : root;
  try { return await fn(`${pinnedRoot}/${id}`); } finally { await dir.close(); }
}
export async function writeAttachment(id: string, bytes: Buffer, root = attachmentRoot()): Promise<void> {
  try {
    await inDirectory(root, id, async path => {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      catch (error) { await unlink(path).catch(() => undefined); throw error; }
      finally { await file.close(); }
    });
  } catch (error) { throw attachmentFailure(error); }
}
export async function writeAttachmentFromFile(id: string, source: string, root = attachmentRoot()): Promise<void> {
  try {
    await inDirectory(root, id, async path => {
      try {
        await copyFile(source, path, constants.COPYFILE_EXCL);
        await chmod(path, 0o600);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await file.sync(); } finally { await file.close(); }
      } catch (error) { await unlink(path).catch(() => undefined); throw error; }
    });
  } catch (error) { throw attachmentFailure(error); }
}
export async function readAttachment(id: string, root = attachmentRoot()): Promise<Buffer> {
  try {
    return await inDirectory(root, id, async path => {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > CHAT_FILE_BYTES) throw new AttachmentError(503, 'storage_unsafe', 'Attachment storage contains an invalid file.');
        return await file.readFile();
      } finally { await file.close(); }
    });
  } catch (error) { throw attachmentFailure(error); }
}
export async function removeAttachment(id: string, root = attachmentRoot()): Promise<void> {
  await inDirectory(root, id, path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw attachmentFailure(error); }));
}
export async function probeAttachmentStorage(root = attachmentRoot()): Promise<{ ok: boolean; code?: string; message?: string }> {
  const id = randomUUID();
  try { await writeAttachment(id, Buffer.from('storage-probe'), root); await removeAttachment(id, root); return { ok: true }; }
  catch (error) { const failure = attachmentFailure(error); return { ok: false, code: failure.code, message: failure.message }; }
}
export function validateAttachment(original: string, claimedType: string, bytes: Buffer) {
  const filename = original.normalize('NFC').replace(/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^\.+/, '').slice(0, 240);
  const sample = bytes.subarray(0, 32000).toString('utf8');
  if (looksLikeCredentialFile(filename, sample)) throw new AttachmentError(400, 'sensitive_file', 'That looks like a password, key, token, or recovery-code file. Josi will not upload it.');
  try { return validateAttachmentContract(original, claimedType, bytes); }
  catch (error) {
    if (isAttachmentContractFailure(error)) throw new AttachmentError(error.status, error.code, error.message);
    throw error;
  }
}

/** Unsent uploads expire after a day. References are checked against messages
 * as well as the durable marker, including pre-upgrade conversations. */
export async function cleanupAttachments(db: Db, root = attachmentRoot()): Promise<number> {
  const expired = await db.query<{ id: string }>(`delete from chat_attachments a
    where a.referenced_at is null and a.created_at < now() - interval '24 hours'
      and not exists (select 1 from messages m where m.thread_id=a.thread_id
        and m.meta->'attachments' @> jsonb_build_array(jsonb_build_object('id',a.id::text))) returning a.id`);
  for (const row of expired) await removeAttachment(row.id, root);
  // Handles abandoned writes and cascade-deleted conversations without ever
  // trusting a path supplied by a client. Age protects in-flight uploads.
  const dir = await directory(root);
  try {
    const pinnedRoot = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : root;
    for (const name of (await readdir(pinnedRoot)).filter(n => UUID.test(n))) {
      const path = `${pinnedRoot}/${name}`;
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
      if (!file) continue;
      const stat = await file.stat(); await file.close();
      if (!stat.isFile() || stat.mtimeMs > Date.now() - 86400000) continue;
      const rows = await db.query(`select id from chat_attachments where id=$1`, [name]);
      if (!rows.length) await unlink(path);
    }
  } finally { await dir.close(); }
  return expired.length;
}
