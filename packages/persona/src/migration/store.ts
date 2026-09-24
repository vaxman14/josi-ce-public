import { randomUUID } from 'node:crypto';
import { appendEvent, json, type Db } from '@josi-ce/core';
import { parseProfile } from '../parse.js';
import { decodedSecret, migrationSecret } from './secrets.js';
import {
  hash, LIMITS, memoryKey, MigrationError, selectable,
  type Classification, type MigrationItem, type MigrationManifest, type MigrationReceipt, type MigrationScope, type Selection,
} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function migrationScope(db: Db, ownerUserId: string): Promise<MigrationScope> {
  const [installation] = await db.query<{ install_id: string }>('select install_id from install_identity where id = true');
  if (!installation) throw new MigrationError('Installation identity is unavailable.', 503);
  return { ownerUserId, installationId: installation.install_id };
}
async function assertScope(db: Db, scope: MigrationScope, lock = false): Promise<void> {
  if (!UUID.test(scope.ownerUserId) || !UUID.test(scope.installationId)) throw new MigrationError('Not found.', 404);
  const [row] = await db.query(
    `select u.id from users u where u.id = $1 and u.status = 'active'
      and exists (select 1 from install_identity where id = true and install_id = $2)
      ${lock ? 'for update of u' : ''}`, [scope.ownerUserId, scope.installationId]);
  if (!row) throw new MigrationError('Not found.', 404);
}

/** Duplicate checks read only the authenticated owner's rows. The route may
 * persist the resulting sanitized manifest briefly; raw upload bytes never
 * reach this layer or PostgreSQL. */
export async function previewMigration(db: Db, scope: MigrationScope, input: MigrationManifest): Promise<MigrationManifest> {
  await assertScope(db, scope);
  const manifest = structuredClone(input);
  const memories = manifest.items.some(item => selectable(item) && item.category === 'memory')
    ? await db.query<{ content: string }>('select content from memories where owner_user_id = $1 limit 10001', [scope.ownerUserId]) : [];
  if (memories.length > 10000) throw new MigrationError('Memory migration supports up to 10,000 existing memories. Import other categories separately.', 413);
  const profiles = await db.query<{ kind: string; content: string }>('select kind,content from persona_profiles where owner_user_id = $1', [scope.ownerUserId]);
  const fingerprints = manifest.items.filter(item => selectable(item) && item.category === 'conversation').map(item => hash(item.content!));
  const archives = fingerprints.length ? await db.query<{ fingerprint: string }>(
    `select a.fingerprint from migration_archives a join migration_batches b on b.id = a.migration_batch_id and b.owner_user_id = a.owner_user_id
      where a.owner_user_id = $1 and b.installation_id = $2 and a.fingerprint = any($3::text[])`, [scope.ownerUserId, scope.installationId, fingerprints]) : [];
  const memoryKeys = new Set(memories.map(m => memoryKey(m.content)));
  const kinds = new Map(profiles.map(profile => [profile.kind, profile.content]));
  const archiveKeys = new Set(archives.map(archive => archive.fingerprint));
  for (const item of manifest.items) {
    if (!selectable(item)) continue;
    if (item.profileKind) {
      if (kinds.has(item.profileKind)) {
        item.classification = kinds.get(item.profileKind) === item.content ? 'duplicate' : 'ignored';
        item.reason = 'A profile for this layer already exists or was proposed earlier. Keep existing; copy selected preferences manually in Personalization.';
      } else kinds.set(item.profileKind, item.content!);
    } else if (item.category === 'memory') {
      const key = memoryKey(item.content!);
      if (memoryKeys.has(key)) {
        item.classification = 'duplicate';
        item.reason = 'Same normalized fact already exists or was proposed earlier. Keep existing, or edit this fact and review again.';
      } else memoryKeys.add(key);
    } else if (item.category === 'conversation') {
      const key = hash(item.content!);
      if (archiveKeys.has(key)) { item.classification = 'duplicate'; item.reason = 'Identical visible transcript already exists or was proposed earlier. Keep existing.'; }
      else archiveKeys.add(key);
    }
  }
  return manifest;
}

/** Selection is applied to the server's original scan, never to a client
 * manifest. Edited memories are validated before even an ephemeral preview. */
export function selectMigration(input: MigrationManifest, selections: unknown): MigrationManifest {
  if (!Array.isArray(selections) || selections.length > LIMITS.items) throw new MigrationError('Invalid migration selection.');
  const byId = new Map<string, Selection>();
  for (const selection of selections) {
    if (!selection || typeof selection.id !== 'string' || byId.has(selection.id)
      || (selection.content !== undefined && typeof selection.content !== 'string')) throw new MigrationError('Invalid migration selection.');
    byId.set(selection.id, selection);
  }
  const manifest = structuredClone(input);
  for (const item of manifest.items) {
    const selection = byId.get(item.id);
    if (!selection) {
      if (selectable(item)) { item.classification = 'ignored'; item.reason = 'Not selected by you.'; delete item.content; delete item.values; }
      continue;
    }
    byId.delete(item.id);
    if (!selectable(item)) throw new MigrationError('Only supported items can be selected.');
    if (selection.content !== undefined) {
      if (item.category !== 'memory') throw new MigrationError('Only proposed memories may be edited in this wizard.');
      const content = selection.content.trim();
      if (!content || content.length > 2000) throw new MigrationError('Each memory must contain 1–2,000 characters.');
      const reason = migrationSecret(content);
      if (reason) throw new MigrationError('An edited memory contains likely secrets or unsafe control characters. Remove them before reviewing.');
      if (content !== item.content) { item.classification = 'transformed'; item.reason = 'Memory edited/redacted by you before import.'; item.content = content; }
    }
  }
  if (byId.size) throw new MigrationError('Unknown migration item.');
  return manifest;
}

function validateItem(item: MigrationItem): void {
  // Repeat at the persistence boundary: never trust a cached classification.
  const reason = decodedSecret(item);
  if (reason) throw new MigrationError('Selected item failed the final safety scan.');
  if (typeof item.content !== 'string' || !item.content.trim()) throw new MigrationError('Selected item has no content.');
  if (item.profileKind) {
    if (!['soul', 'user', 'agents_user'].includes(item.profileKind)) throw new MigrationError('Unsupported profile layer.');
    if (Buffer.byteLength(item.content) > 20000) throw new MigrationError('Profile too large.');
    // The exact bounded parse is repeated; imported values cannot grant authority.
    item.values = parseProfile(item.profileKind, item.content).values;
  } else if (item.category === 'memory') {
    if (item.content.length > 2000 || (item.memoryProvenance?.length ?? 0) > 2000) throw new MigrationError('Memory too large.');
  } else if (item.category === 'conversation') {
    if (Buffer.byteLength(item.content) > LIMITS.entryBytes) throw new MigrationError('Archive too large.');
  } else throw new MigrationError('This category cannot be committed.');
}

/** One real, driver-managed transaction on one pinned connection. No BEGIN
 * sent through a pool, no compensating deletes, and no overwrite/upsert. */
export async function commitMigration(db: Db, scope: MigrationScope, reviewed: MigrationManifest, batchId: string = randomUUID()): Promise<MigrationReceipt> {
  if (!db.transaction) throw new MigrationError('Atomic transactions are unavailable; nothing was imported.', 503);
  return db.transaction(tx => commitMigrationInTransaction(tx, scope, reviewed, batchId));
}

/** Commit on a transaction already pinned by the caller. This exists so the
 * durable preview row and imported data can be locked/committed atomically. */
export async function commitMigrationInTransaction(db: Db, scope: MigrationScope, reviewed: MigrationManifest, batchId: string): Promise<MigrationReceipt> {
    if (!UUID.test(batchId) || reviewed.version !== 1 || reviewed.items.length > LIMITS.items) throw new MigrationError('Invalid migration review.');
    await assertScope(db, scope, true);
    const [existing] = await db.query<{ receipt: MigrationReceipt; rolled_back_at: string | null }>(
      'select receipt, rolled_back_at from migration_batches where id = $1 and owner_user_id = $2 and installation_id = $3',
      [batchId, scope.ownerUserId, scope.installationId]);
    if (existing?.rolled_back_at) throw new MigrationError('This batch has already been rolled back.', 409);
    if (existing) return existing.receipt; // safe response retry; never import twice
    // Recheck races. If state changed since final review, commit nothing.
    const checked = await previewMigration(db, scope, reviewed);
    if (checked.items.some((item, i) => item.classification !== reviewed.items[i].classification)) {
      throw new MigrationError('Your data changed since review. Review the selection again before importing.', 409);
    }
    for (const item of checked.items.filter(selectable)) validateItem(item);
    const counts = Object.fromEntries(['imported unchanged', 'transformed', 'duplicate', 'sensitive/refused', 'unsupported', 'ignored'].map(key => [key, 0])) as Record<Classification, number>;
    for (const item of checked.items) counts[item.classification]++;
    const receipt: MigrationReceipt = { batchId, created: 0, counts,
      items: checked.items.map(({ id, category, classification, reason, provenance }) => ({ id, category, classification, reason, provenance })) };
    await db.query('insert into migration_batches(id, owner_user_id, installation_id, manifest_version) values ($1,$2,$3,1)', [batchId, scope.ownerUserId, scope.installationId]);
    for (const item of checked.items.filter(selectable)) {
      if (item.profileKind) {
        await db.query(`insert into persona_profiles(owner_user_id,kind,content,parsed,ignored,migration_batch_id,source_provenance)
          values ($1,$2,$3,$4,$5,$6,$7)`, [scope.ownerUserId, item.profileKind, item.content, json(item.values), json([]), batchId, json(item.provenance)]);
      } else if (item.category === 'memory') {
        await db.query(`insert into memories(owner_user_id,content,provenance,pinned,confirmed_at,created_at,migration_batch_id,source_provenance,content_fingerprint)
          values ($1,$2,$3,$4,now(),clock_timestamp(),$5,$6,$7)`, [scope.ownerUserId, item.content,
          item.memoryProvenance ?? `Imported from ${item.provenance.source}`, item.pinned ?? false, batchId, json(item.provenance), memoryKey(item.content!)]);
      } else {
        await db.query(`insert into migration_archives(owner_user_id,migration_batch_id,source_provenance,content,fingerprint)
          values ($1,$2,$3,$4,$5)`, [scope.ownerUserId, batchId, json(item.provenance), item.content, hash(item.content!)]);
      }
      receipt.created++;
    }
    await db.query('update migration_batches set receipt = $1 where id = $2 and owner_user_id = $3 and installation_id = $4',
      [json(receipt), batchId, scope.ownerUserId, scope.installationId]);
    await appendEvent(db, { actorUserId: scope.ownerUserId, actor: 'user', kind: 'migration.committed', subjectType: 'migration_batch', subjectId: batchId,
      payload: { created: receipt.created, counts } });
    return receipt;
}

export async function listMigrationBatches(db: Db, scope: MigrationScope, offset = 0) {
  await assertScope(db, scope);
  return db.query<{ id: string; created_at: string; rolled_back_at: string | null; receipt: Omit<MigrationReceipt, 'items'> }>(
    `select id, created_at, rolled_back_at,
      jsonb_build_object('batchId', id, 'created', receipt->'created', 'counts', receipt->'counts') as receipt
      from migration_batches where owner_user_id = $1 and installation_id = $2
      order by created_at desc, id desc limit 20 offset $3`, [scope.ownerUserId, scope.installationId, offset]);
}

export async function readMigrationBatch(db: Db, scope: MigrationScope, id: string) {
  await assertScope(db, scope);
  if (!UUID.test(id)) throw new MigrationError('Not found.', 404);
  const [batch] = await db.query<{ receipt: MigrationReceipt; rolled_back_at: string | null }>(
    'select receipt, rolled_back_at from migration_batches where id = $1 and owner_user_id = $2 and installation_id = $3',
    [id, scope.ownerUserId, scope.installationId]);
  if (!batch) throw new MigrationError('Not found.', 404);
  return batch;
}

export async function rollbackMigration(db: Db, scope: MigrationScope, batchId: string): Promise<{ removed: number }> {
  if (!db.transaction) throw new MigrationError('Atomic transactions are unavailable.', 503);
  return db.transaction(tx => rollbackMigrationInTransaction(tx, scope, batchId));
}

/** Roll back on a transaction already pinned by the caller. */
export async function rollbackMigrationInTransaction(db: Db, scope: MigrationScope, batchId: string): Promise<{ removed: number }> {
    if (!UUID.test(batchId)) throw new MigrationError('Not found.', 404);
    await assertScope(db, scope, true);
    const [batch] = await db.query<{ rolled_back_at: string | null }>(
      `select rolled_back_at from migration_batches where id = $1 and owner_user_id = $2 and installation_id = $3 for update`,
      [batchId, scope.ownerUserId, scope.installationId]);
    if (!batch) throw new MigrationError('Not found.', 404);
    if (batch.rolled_back_at) return { removed: 0 };
    let removed = 0;
    for (const table of ['migration_archives', 'memories', 'persona_profiles'] as const) {
      const rows = await db.query(`delete from ${table} where migration_batch_id = $1 and owner_user_id = $2 returning id`, [batchId, scope.ownerUserId]);
      removed += rows.length;
    }
    // The receipt contains no imported text. Keep it so rollback is accountable.
    await db.query('update migration_batches set rolled_back_at = now() where id = $1 and owner_user_id = $2 and installation_id = $3',
      [batchId, scope.ownerUserId, scope.installationId]);
    await appendEvent(db, { actorUserId: scope.ownerUserId, actor: 'user', kind: 'migration.rolled_back', subjectType: 'migration_batch', subjectId: batchId, payload: { removed } });
    return { removed };
}

export async function searchMigrationArchives(db: Db, scope: MigrationScope, query = '', offset = 0) {
  await assertScope(db, scope);
  return db.query<{ id: string; source_provenance: MigrationItem['provenance']; created_at: string; excerpt: string }>(
    `select a.id, a.source_provenance, a.created_at, left(a.content, 240) as excerpt
     from migration_archives a join migration_batches b on b.id = a.migration_batch_id and b.owner_user_id = a.owner_user_id
     where a.owner_user_id = $1 and b.installation_id = $2 and b.rolled_back_at is null
       and ($3 = '' or to_tsvector('simple', a.content) @@ plainto_tsquery('simple', $3))
     order by a.created_at desc, a.id desc limit 20 offset $4`, [scope.ownerUserId, scope.installationId, query.slice(0, 200), offset]);
}
export async function readMigrationArchive(db: Db, scope: MigrationScope, id: string) {
  await assertScope(db, scope);
  if (!UUID.test(id)) throw new MigrationError('Not found.', 404);
  const [row] = await db.query<{ id: string; content: string; source_provenance: MigrationItem['provenance']; created_at: string }>(
    `select a.id, a.content, a.source_provenance, a.created_at from migration_archives a
     join migration_batches b on b.id = a.migration_batch_id and b.owner_user_id = a.owner_user_id
     where a.id = $1 and a.owner_user_id = $2 and b.installation_id = $3 and b.rolled_back_at is null`, [id, scope.ownerUserId, scope.installationId]);
  if (!row) throw new MigrationError('Not found.', 404);
  return row;
}
