import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { json, type Db } from '@josi-ce/core';
import {
  LIMITS, MigrationError, commitMigrationInTransaction, listMigrationBatches, migrationScope,
  previewMigration, readMigrationArchive, readMigrationBatch, rollbackMigrationInTransaction, scanMigration,
  searchMigrationArchives, selectable, selectMigration, unpackUploads,
  type MigrationManifest, type MigrationReceipt, type MigrationScope, type MigrationSource,
} from '@josi-ce/persona';
import { requireAuth } from './authz.js';
import { param } from './async.js';

interface PreviewRow {
  id: string;
  owner_user_id: string;
  installation_id: string;
  scanned: MigrationManifest | null;
  reviewed: MigrationManifest | null;
  revision: string | null;
  expires_at: string | Date;
}

/** Aggregate limit enforced WHILE streaming, not after memoryStorage has
 * buffered N independently max-sized files. No temp files are ever written. */
function receiveUpload() {
  let total = 0;
  const storage: multer.StorageEngine = {
    _handleFile(_req, file, done) {
      const chunks: Buffer[] = [];
      let size = 0, failed = false;
      file.stream.on('data', (chunk: Buffer) => {
        total += chunk.length; size += chunk.length;
        if (!failed && (total > LIMITS.uploadBytes || size > (/\.zip$/i.test(file.originalname) ? LIMITS.uploadBytes : LIMITS.entryBytes))) {
          failed = true; chunks.forEach(buffer => buffer.fill(0)); chunks.length = 0;
          done(new MigrationError('Upload exceeds the 8 MiB total or 1 MiB individual-file limit.', 413));
        }
        if (!failed) chunks.push(chunk);
      });
      file.stream.on('error', () => { if (!failed) { failed = true; done(new MigrationError('Upload interrupted.')); } });
      file.stream.on('end', () => { if (!failed) done(null, { buffer: Buffer.concat(chunks), size }); });
    },
    _removeFile(_req, file, done) { file.buffer?.fill(0); done(null); },
  };
  return multer({ storage, preservePath: true, limits: { files: LIMITS.uploadFiles, fileSize: LIMITS.uploadBytes, fields: 0, parts: LIMITS.uploadFiles } }).array('files', LIMITS.uploadFiles);
}

export function migrationRoutes(db: Db): Router {
  const router = Router();
  const uploads = new Set<string>();
  router.use(requireAuth, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const handle = (fn: (req: Request, res: Response, scope: MigrationScope) => Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req, res, await migrationScope(db, req.user!.id)); }
    catch (error) {
      // Do not log errors: postgres errors can include the complete failed row.
      const known = error instanceof MigrationError;
      if (!res.headersSent) res.status(known ? error.status : 500).json({ error: known ? error.message : 'Migration could not be completed. No partial import was saved. Try again.' });
    }
  };
  const prune = () => db.query('delete from migration_previews where expires_at <= $1', [new Date(Date.now())]);
  const load = async (conn: Db, id: string, scope: MigrationScope, lock = false) => {
    const [preview] = await conn.query<PreviewRow>(
      `select id,owner_user_id,installation_id,scanned,reviewed,revision,expires_at
       from migration_previews where id = $1 and owner_user_id = $2 and installation_id = $3${lock ? ' for update' : ''}`,
      [id, scope.ownerUserId, scope.installationId]);
    if (!preview || new Date(preview.expires_at).getTime() <= Date.now()) {
      throw new MigrationError('Preview not found or expired. Scan your files again.', 404);
    }
    return preview;
  };
  const offset = (req: Request) => {
    const value = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw new MigrationError('Invalid page.');
    return value;
  };
  router.post('/scan', handle(async (req, res, scope) => {
    const source = (req.query.source ?? 'auto') as MigrationSource | 'auto';
    if (!['auto', 'openclaw', 'hermes', 'josi'].includes(source)) throw new MigrationError('Choose a supported source.');
    if (uploads.has(scope.ownerUserId) || uploads.size >= 2) throw new MigrationError('Another scan is in progress. Try again shortly.', 429);
    uploads.add(scope.ownerUserId);
    try {
      await new Promise<void>((resolve, reject) => receiveUpload()(req, res, error => error ? reject(error) : resolve())).catch(() => {
        throw new MigrationError('Upload refused. Choose one ZIP or 1–100 files, within 8 MiB total and 1 MiB per expanded file.', 413);
      });
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const unpacked = unpackUploads(files.map(file => ({ path: file.originalname, bytes: file.buffer })));
      let scanned: MigrationManifest;
      try { scanned = scanMigration(unpacked, source); } finally { unpacked.forEach(file => file.bytes.fill(0)); }
      const report = await previewMigration(db, scope, scanned);
      const size = Buffer.byteLength(JSON.stringify(scanned));
      if (size > 16 * 1024 * 1024) throw new MigrationError('Preview capacity exceeded. Use a smaller export.', 413);
      if (!db.transaction) throw new MigrationError('Durable previews are unavailable.', 503);
      const id = randomUUID(), expires = new Date(Date.now() + LIMITS.previewMs);
      await db.transaction(async tx => {
        // Shared installation lock makes capacity and one-preview-per-owner
        // enforcement deterministic across API replicas.
        await tx.query('select install_id from install_identity where id = true for update');
        await tx.query('delete from migration_previews where expires_at <= $1', [new Date(Date.now())]);
        const [capacity] = await tx.query<{ count: string; bytes: string }>(
          `select count(*)::text as count, coalesce(sum(pg_column_size(scanned) + coalesce(pg_column_size(reviewed),0)),0)::text as bytes from migration_previews`);
        if (Number(capacity.count) >= 20 || Number(capacity.bytes) + size > 32 * 1024 * 1024) throw new MigrationError('Migration preview capacity is full. Close another preview or try again shortly.', 429);
        await tx.query('delete from migration_previews where owner_user_id = $1 and installation_id = $2', [scope.ownerUserId, scope.installationId]);
        await tx.query(`insert into migration_previews(id,owner_user_id,installation_id,scanned,expires_at) values($1,$2,$3,$4,$5)`,
          [id, scope.ownerUserId, scope.installationId, json(scanned), expires]);
      });
      res.json({ previewId: id, expiresAt: expires.toISOString(), manifest: report, limits: LIMITS });
    } finally {
      (req.files as Express.Multer.File[] | undefined)?.forEach(file => file.buffer?.fill(0));
      uploads.delete(scope.ownerUserId);
    }
  }));
  router.post('/:id/review', handle(async (req, res, scope) => {
    if (!db.transaction) throw new MigrationError('Durable previews are unavailable.', 503);
    await prune();
    const result = await db.transaction(async tx => {
      await tx.query('select install_id from install_identity where id = true for update');
      const preview = await load(tx, param(req, 'id'), scope, true);
      if (!preview.scanned) throw new MigrationError('Preview not found or expired. Scan your files again.', 404);
      const reviewed = await previewMigration(tx, scope, selectMigration(preview.scanned, req.body?.selections));
      const size = Buffer.byteLength(JSON.stringify(preview.scanned)) + Buffer.byteLength(JSON.stringify(reviewed));
      if (size > 32 * 1024 * 1024) throw new MigrationError('Preview capacity exceeded. Use a smaller selection.', 413);
      const [capacity] = await tx.query<{ bytes: string }>(
        `select coalesce(sum(pg_column_size(scanned) + coalesce(pg_column_size(reviewed),0)),0)::text as bytes
         from migration_previews where id <> $1`, [preview.id]);
      if (Number(capacity.bytes) + size > 32 * 1024 * 1024) throw new MigrationError('Migration preview capacity is full. Close another preview or try again shortly.', 429);
      const revision = randomUUID();
      await tx.query(`update migration_previews set reviewed=$1,revision=$2 where id=$3 and owner_user_id=$4 and installation_id=$5`,
        [json(reviewed), revision, preview.id, scope.ownerUserId, scope.installationId]);
      return { revision, manifest: reviewed };
    });
    res.json(result);
  }));
  router.post('/:id/commit', handle(async (req, res, scope) => {
    if (!db.transaction) throw new MigrationError('Atomic transactions are unavailable; nothing was imported.', 503);
    await prune();
    let result: MigrationReceipt;
    try {
      result = await db.transaction(async tx => {
        const id = param(req, 'id');
        const [preview] = await tx.query<PreviewRow>(
          `select id,owner_user_id,installation_id,scanned,reviewed,revision,expires_at
           from migration_previews where id=$1 and owner_user_id=$2 and installation_id=$3 for update`,
          [id, scope.ownerUserId, scope.installationId]);
        if (!preview || new Date(preview.expires_at).getTime() <= Date.now()) {
          const [batch] = await tx.query<{ receipt: MigrationReceipt; rolled_back_at: string | null }>(
            'select receipt,rolled_back_at from migration_batches where id=$1 and owner_user_id=$2 and installation_id=$3',
            [id, scope.ownerUserId, scope.installationId]);
          if (batch?.rolled_back_at) throw new MigrationError('This batch has already been rolled back.', 409);
          if (batch) return batch.receipt;
          throw new MigrationError('Preview not found or expired. Scan your files again.', 404);
        }
        if (!preview.reviewed || req.body?.revision !== preview.revision || req.body?.confirm !== 'import') throw new MigrationError('Review this selection before importing.', 409);
        if (!preview.reviewed.items.some(selectable)) throw new MigrationError('There are no selected supported items to import.');
        const receipt = await commitMigrationInTransaction(tx, scope, preview.reviewed, preview.id);
        await tx.query('delete from migration_previews where id=$1 and owner_user_id=$2 and installation_id=$3',
          [preview.id, scope.ownerUserId, scope.installationId]);
        return receipt;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new MigrationError('Your data changed since review. Review the selection again before importing.', 409);
      }
      throw error;
    }
    res.json({ receipt: result });
  }));
  router.delete('/previews/:id', handle(async (req, res, scope) => {
    if (!db.transaction) throw new MigrationError('Durable previews are unavailable.', 503);
    await db.transaction(async tx => {
      const preview = await load(tx, param(req, 'id'), scope, true);
      await tx.query('delete from migration_previews where id=$1 and owner_user_id=$2 and installation_id=$3', [preview.id, scope.ownerUserId, scope.installationId]);
    });
    res.json({ discarded: true });
  }));
  router.get('/batches', handle(async (req, res, scope) => res.json({ batches: await listMigrationBatches(db, scope, offset(req)) })));
  router.get('/batches/:id', handle(async (req, res, scope) => res.json(await readMigrationBatch(db, scope, param(req, 'id')))));
  router.post('/batches/:id/rollback', handle(async (req, res, scope) => {
    if (req.body?.confirm !== 'rollback') throw new MigrationError('Confirm rollback of this batch.');
    if (!db.transaction) throw new MigrationError('Atomic transactions are unavailable.', 503);
    const id = param(req, 'id');
    const result = await db.transaction(async tx => {
      await tx.query('select id from migration_previews where id=$1 and owner_user_id=$2 and installation_id=$3 for update', [id, scope.ownerUserId, scope.installationId]);
      const rolledBack = await rollbackMigrationInTransaction(tx, scope, id);
      await tx.query('delete from migration_previews where id=$1 and owner_user_id=$2 and installation_id=$3', [id, scope.ownerUserId, scope.installationId]);
      return rolledBack;
    });
    res.json(result);
  }));
  router.get('/archives', handle(async (req, res, scope) => {
    if (req.query.q !== undefined && typeof req.query.q !== 'string') throw new MigrationError('Invalid search.');
    res.json({ archives: await searchMigrationArchives(db, scope, req.query.q as string ?? '', offset(req)) });
  }));
  router.get('/archives/:id', handle(async (req, res, scope) => res.json({ archive: await readMigrationArchive(db, scope, param(req, 'id')) })));
  return router;
}
