// Mapping a folder: the grant, and everything that ends it.
//
// M47 calls this dual-gated, and the two gates are not symmetric. The
// administrator decides whether a person MAY map folders at all; the person
// decides WHICH folder. The administrator cannot do the second half.
//
// That asymmetry is the whole control. An administrator who can create a
// mapping on someone's behalf is an administrator who can read their files by
// filling in a form — and since Josi indexes what it maps, the files would then
// be sitting in a search index the administrator also administers. So
// `createMapping` takes the owner from the session, never from the request
// body, and there is no admin route that reaches it.
import { appendEvent, resolveAccess, type Db } from '@josi-ce/core';
import { PathEscape, isInside, resolveWithin, safeRelativePath } from './paths.js';

export class MappingError extends Error {
  constructor(message: string, readonly code: string = 'refused') {
    super(message);
  }
}

export type Provider = 'local' | 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'nextcloud';

export interface StorageCapability {
  may_map_local: boolean;
  may_map_cloud: boolean;
  may_index: boolean;
  max_files: number | null;
  max_bytes: string | null;
}

const NO_CAPABILITY: StorageCapability = {
  may_map_local: false,
  may_map_cloud: false,
  may_index: false,
  max_files: null,
  max_bytes: null,
};

/** What this person has been allowed to do.
 *
 * Absent row means absent capability. M45's "deny by default" is this default,
 * and it is a default rather than a check the caller might forget. */
export async function capabilityFor(db: Db, userId: string): Promise<StorageCapability> {
  const [row] = await db.query<StorageCapability>(
    `select may_map_local, may_map_cloud, may_index, max_files, max_bytes
     from storage_capabilities where user_id = $1`,
    [userId],
  );
  return row ?? NO_CAPABILITY;
}

export interface CreateMappingArgs {
  /** From the session. Never from the request body — see the note above. */
  ownerUserId: string;
  provider: Provider;
  /** Local: which registered root, and where under it. */
  rootId?: string | null;
  relativePath?: string;
  /** Cloud: whose connection, and which folder of theirs. */
  connectionId?: string | null;
  remoteFolderId?: string | null;
  displayPath?: string;
  recursive?: boolean;
  /** Verifies the folder is really there before the grant is recorded. */
  statImpl?: (absolutePath: string) => Promise<{ isDirectory(): boolean }>;
}

export interface Mapping {
  id: string;
  owner_user_id: string;
  provider: Provider;
  root_id: string | null;
  relative_path: string;
  connection_id: string | null;
  remote_folder_id: string | null;
  display_path: string;
  recursive: boolean;
  may_create: boolean;
  may_edit: boolean;
  may_move: boolean;
  may_delete: boolean;
  indexing_enabled: boolean;
  status: 'active' | 'paused' | 'revoked';
  paused_reason: string | null;
}

/** The consent sentence a person has to agree to.
 *
 * M50 is explicit that a recursive scope must state it covers folders created
 * LATER, not merely the ones there today. Getting this wording right is a
 * security control, not copy: consent to "this folder and its 3 subfolders" is
 * not consent to a subfolder somebody adds next month.
 */
export function consentText(args: { displayPath: string; recursive: boolean; indexing: boolean }): string {
  const scope = args.recursive
    ? `${args.displayPath}, everything inside it, and any subfolder added to it in future`
    : `${args.displayPath} — files directly in this folder only, not its subfolders`;
  const read = `Josi will be able to read ${scope}.`;
  if (!args.indexing) {
    return `${read} Files are read only when something you ask for needs them. Nothing is copied or kept.`;
  }
  return `${read} Josi will also read every file in it now and keep the extracted text so it can search them, and will send that text to the language model you have configured when answering questions.`;
}

export async function createMapping(db: Db, args: CreateMappingArgs): Promise<Mapping> {
  const capability = await capabilityFor(db, args.ownerUserId);
  const allowed = args.provider === 'local' ? capability.may_map_local : capability.may_map_cloud;
  if (!allowed) {
    // Deliberately the same message either way. "You may not map local folders"
    // and "you may not map cloud folders" is a small thing to leak, but it is
    // free not to.
    throw new MappingError('an administrator has not enabled folder mapping for you', 'not_permitted');
  }

  if (args.provider === 'local') return createLocalMapping(db, args);
  return createCloudMapping(db, args);
}

async function createLocalMapping(db: Db, args: CreateMappingArgs): Promise<Mapping> {
  if (!args.rootId) throw new MappingError('choose one of the folders the administrator has made available');

  const [root] = await db.query<{ id: string; container_path: string; label: string; enabled: boolean }>(
    `select id, container_path, label, enabled from storage_roots where id = $1`,
    [args.rootId],
  );
  // A root that is not registered, or is switched off, is not a root. Both are
  // the same answer: there is nothing there to map.
  if (!root || !root.enabled) throw new MappingError('that folder is not available', 'no_such_root');

  const relativePath = safeRelativePath(args.relativePath ?? '');

  // Containment is checked HERE, at grant time, as well as on every later
  // access. Checking only at access time would let a mapping exist that names
  // somewhere outside the root, and a mapping that exists gets displayed,
  // counted, and eventually trusted.
  const resolved = await resolveWithin(root.container_path, relativePath, { mustExist: true });

  if (args.statImpl) {
    const stat = await args.statImpl(resolved.absolute).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new MappingError('that is not a folder', 'not_a_directory');
  }

  const displayPath = relativePath ? `${root.label}/${relativePath}` : root.label;
  const rows = await db.query<Mapping>(
    `insert into folder_mappings
       (owner_user_id, provider, root_id, relative_path, display_path, recursive)
     values ($1, 'local', $2, $3, $4, $5)
     returning *`,
    [args.ownerUserId, root.id, relativePath, displayPath, args.recursive === true],
  ).catch(rethrowDuplicate);

  await logMapping(db, rows[0], 'storage.mapping_created');
  return rows[0];
}

async function createCloudMapping(db: Db, args: CreateMappingArgs): Promise<Mapping> {
  if (!args.connectionId || !args.remoteFolderId) {
    throw new MappingError('choose a folder from your connected account');
  }
  // The connection has to be THEIRS. Phase 7 made connections never shareable
  // precisely because a connection carries an OAuth grant; mapping a folder
  // through somebody else's connection would be the same handover by a longer
  // route.
  const decision = await resolveAccess(db, {
    type: 'connection',
    resourceId: args.connectionId,
    accessor: { userId: args.ownerUserId, role: 'member' },
  });
  if (decision.level !== 'owner') {
    throw new MappingError('that account is not yours to map from', 'not_your_connection');
  }

  const rows = await db.query<Mapping>(
    `insert into folder_mappings
       (owner_user_id, provider, connection_id, remote_folder_id, display_path, recursive)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      args.ownerUserId, args.provider, args.connectionId, args.remoteFolderId,
      (args.displayPath ?? '').slice(0, 500) || 'a folder', args.recursive === true,
    ],
  ).catch(rethrowDuplicate);

  await logMapping(db, rows[0], 'storage.mapping_created');
  return rows[0];
}

function rethrowDuplicate(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/duplicate key|unique constraint/i.test(message)) {
    throw new MappingError('you have already mapped that folder', 'already_mapped');
  }
  throw err;
}

/** M72: metadata only.
 *
 * Not the display path, not the folder name. A folder called
 * "Q3-layoffs-legal-review" tells an administrator reading the audit log a
 * great deal, and the audit log is exactly where that must not accumulate. */
async function logMapping(db: Db, mapping: Mapping, kind: string): Promise<void> {
  await appendEvent(db, {
    actorUserId: mapping.owner_user_id,
    actor: 'user',
    kind,
    subjectType: 'folder_mapping',
    subjectId: mapping.id,
    payload: {
      provider: mapping.provider,
      recursive: mapping.recursive,
      indexing: mapping.indexing_enabled,
    },
  });
}

/** M47: permissions are granted one at a time, and only by the owner.
 *
 * `may_delete` is the odd one out and deliberately so: granting it does not
 * grant deleting. It grants the ability to ASK, and every individual delete
 * still raises an approval. */
export async function setPermissions(
  db: Db,
  args: {
    mappingId: string;
    ownerUserId: string;
    create?: boolean; edit?: boolean; move?: boolean; delete?: boolean;
  },
): Promise<Mapping> {
  const mapping = await requireOwnedMapping(db, args.mappingId, args.ownerUserId);

  // A root the operator declared read-only cannot be written through, whatever
  // the owner asks for. The operator's ceiling is a ceiling.
  if (mapping.provider === 'local') {
    const [root] = await db.query<{ writable: boolean }>(
      `select writable from storage_roots where id = $1`, [mapping.root_id],
    );
    const wantsWrite = args.create === true || args.edit === true || args.move === true || args.delete === true;
    if (wantsWrite && !root?.writable) {
      throw new MappingError('that folder was made available read-only', 'root_read_only');
    }
  }

  const [row] = await db.query<Mapping>(
    `update folder_mappings set
       may_create = coalesce($2, may_create),
       may_edit   = coalesce($3, may_edit),
       may_move   = coalesce($4, may_move),
       may_delete = coalesce($5, may_delete)
     where id = $1 returning *`,
    [args.mappingId, bool(args.create), bool(args.edit), bool(args.move), bool(args.delete)],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'storage.permissions_changed',
    subjectType: 'folder_mapping',
    subjectId: args.mappingId,
    payload: {
      create: row.may_create, edit: row.may_edit, move: row.may_move, delete: row.may_delete,
    },
  });
  return row;
}

const bool = (v: boolean | undefined): boolean | null => (typeof v === 'boolean' ? v : null);

/** M49: indexing is a separate consent, and turning it off purges.
 *
 * Consent to Josi opening a file when you ask a question is not consent to
 * Josi reading every file in the folder and keeping the text. */
export async function setIndexing(
  db: Db,
  args: { mappingId: string; ownerUserId: string; enabled: boolean },
): Promise<{ mapping: Mapping; purged: PurgeCounts | null }> {
  await requireOwnedMapping(db, args.mappingId, args.ownerUserId);
  if (args.enabled) {
    const capability = await capabilityFor(db, args.ownerUserId);
    if (!capability.may_index) {
      throw new MappingError('an administrator has not enabled indexing for you', 'not_permitted');
    }
  }

  // Turning indexing OFF is a revocation, and M54 says a revocation destroys
  // derived data immediately — not on the next sweep, not when a queue drains.
  const purged = args.enabled ? null : await purgeDerived(db, args.mappingId);

  const [row] = await db.query<Mapping>(
    `update folder_mappings
       set indexing_enabled = $2,
           indexing_consented_at = case when $2 then now() else null end
     where id = $1 returning *`,
    [args.mappingId, args.enabled],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: args.enabled ? 'storage.indexing_enabled' : 'storage.indexing_revoked',
    subjectType: 'folder_mapping',
    subjectId: args.mappingId,
    payload: purged ? { purged } : { recursive: row.recursive },
  });
  return { mapping: row, purged };
}

export interface PurgeCounts {
  documents: number;
}

/** M54: everything derived from a folder, destroyed.
 *
 * Counted per artefact type rather than left to a cascade. The cascade is real
 * and does the work, but a count is what lets a test assert that each KIND of
 * derived data went — and the list grows in 9b and 9c, where extracted text,
 * OCR output, FTS rows and embeddings arrive. A silent cascade would let a new
 * table be added in a later phase and quietly not be purged.
 */
export async function purgeDerived(db: Db, mappingId: string): Promise<PurgeCounts> {
  const [docs] = await db.query<{ n: number }>(
    `with removed as (delete from documents where mapping_id = $1 returning 1)
     select count(*)::int as n from removed`,
    [mappingId],
  );
  return { documents: docs?.n ?? 0 };
}

/** Unmapping. The grant ends and every derived byte goes with it. */
export async function unmapFolder(
  db: Db,
  args: { mappingId: string; ownerUserId: string },
): Promise<PurgeCounts> {
  await requireOwnedMapping(db, args.mappingId, args.ownerUserId);
  const purged = await purgeDerived(db, args.mappingId);
  await db.query(`delete from folder_mappings where id = $1`, [args.mappingId]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'storage.unmapped',
    subjectType: 'folder_mapping',
    subjectId: args.mappingId,
    payload: { purged },
  });
  return purged;
}

/** M78: the mapping stops, the owner is told, and nothing is deleted.
 *
 * A pause is not a revocation. Expired provider access is usually a person
 * needing to sign in again, and destroying their index every time a token
 * lapses would be a far worse outcome than a paused folder. */
export async function pauseMapping(
  db: Db,
  args: { mappingId: string; reason: 'token_expired' | 'admin_paused' | 'quota_exceeded' | 'source_missing' },
): Promise<void> {
  const [row] = await db.query<{ owner_user_id: string }>(
    `update folder_mappings set status = 'paused', paused_reason = $2
     where id = $1 and status <> 'revoked' returning owner_user_id`,
    [args.mappingId, args.reason],
  );
  if (!row) return;
  await appendEvent(db, {
    actorUserId: row.owner_user_id,
    actor: 'system',
    kind: 'storage.mapping_paused',
    subjectType: 'folder_mapping',
    subjectId: args.mappingId,
    payload: { reason: args.reason },
  });
}

/** Ownership, checked once, here.
 *
 * Not "owner or share": these operations change the GRANT, and M68 plus the
 * Phase 8 sharing lesson say that someone given access must not be able to
 * widen or end it. Read access to a mapping's contents is a different question,
 * answered by `resolveAccess` at the route. */
export async function requireOwnedMapping(db: Db, mappingId: string, userId: string): Promise<Mapping> {
  const [row] = await db.query<Mapping>(
    `select * from folder_mappings where id = $1 and owner_user_id = $2`,
    [mappingId, userId],
  );
  // 404, never 403 — the Phase 1 rule. Telling somebody "that mapping exists
  // but is not yours" confirms a colleague mapped a folder.
  if (!row) throw new MappingError('not found', 'not_found');
  return row;
}

/** M70: removing a person must never leave their data ownerless.
 *
 * The private case is a cascade. The shared case is not, and that is the point
 * of the decision: a shared mapping has to be explicitly transferred or purged
 * by a human, because silently deleting something a colleague depends on and
 * silently reassigning someone's private files are both wrong. */
export async function mappingsBlockingUserRemoval(
  db: Db,
  userId: string,
): Promise<Array<{ id: string; display_path: string; shared_with: number }>> {
  return db.query(
    `select m.id, m.display_path, count(s.*)::int as shared_with
     from folder_mappings m
     join resource_shares s
       on s.resource_type = 'folder_mapping' and s.resource_id = m.id
     where m.owner_user_id = $1
     group by m.id, m.display_path`,
    [userId],
  );
}

export { PathEscape };

/** Where bind-mounted folders are allowed to appear.
 *
 * Compose mounts every shared folder under one directory, and a root outside it
 * is a misconfiguration rather than a choice — most likely someone pointing at
 * a host path that happens to be visible. Overridable so tests can exercise the
 * rule against real directories; there is no route that sets it.
 */
export const ROOT_BASE = process.env.JOSI_STORAGE_ROOT_BASE || '/data/roots';

/** Registering a root is the operator's half of M45, and it is deliberately not
 * reachable over HTTP — a root is added by editing compose and running this,
 * so widening the blast radius takes a deployment change rather than a session. */
export async function registerRoot(
  db: Db,
  args: { containerPath: string; label: string; purpose?: string; writable?: boolean; base?: string },
): Promise<{ id: string; container_path: string; label: string }> {
  const base = args.base ?? ROOT_BASE;
  const path = args.containerPath;
  if (!path.startsWith('/')) throw new MappingError('a root must be an absolute path', 'bad_root');
  if (path.includes('..') || path.includes('\0')) {
    throw new MappingError('that root path is not in the expected form', 'bad_root');
  }
  // Structural containment, the same rule the resolver uses: a sibling whose
  // name merely starts with the base is not inside it.
  if (!isInside(base, path)) {
    throw new MappingError('a root must be under the folder Josi mounts shared storage into', 'bad_root');
  }
  if (!args.label.trim()) throw new MappingError('give the folder a label people will recognise', 'bad_root');

  const [row] = await db.query<{ id: string; container_path: string; label: string }>(
    `insert into storage_roots (container_path, label, purpose, writable)
     values ($1, $2, $3, $4)
     on conflict (container_path) do update set
       label = excluded.label, purpose = excluded.purpose, writable = excluded.writable
     returning id, container_path, label`,
    [path, args.label.trim(), (args.purpose ?? '').slice(0, 500), args.writable === true],
  );
  return row;
}
