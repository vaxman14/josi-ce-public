// Private by default.
//
// This is the single most important file in Josi CE, because it enforces the
// one thing the commercial engine never had to. There, isolation ran along
// `tenant_id` and an operator sat above every tenant by design. Here everyone is
// inside one workspace, and the question is not "which business?" but "is this
// row *yours*?".
//
// Three rules, and they are absolute:
//
//   1. Being a member of the workspace grants nothing.
//   2. Being the super admin grants nothing either — policy is not content.
//   3. Access comes from owning the row, or from an explicit share the owner
//      created. Nothing else.
//
// Every private resource goes through `resolveAccess`. There is one decision
// point on purpose: a second one is how a leak gets written.
import type { Db } from './db.js';

export type ResourceType =
  | 'connection'
  | 'folder_mapping'
  | 'email_thread'
  // Phase 5. These are owner-scoped for the same reason the three above are:
  // the canonical map says content is private unless its owner shares it, and
  // says workspace membership and super-admin status never grant access. The
  // extraction map had proposed making them workspace-shared, carried over from
  // the engine where one tenant IS one business; PHASE_5_EVIDENCE.md records
  // why that does not transfer.
  | 'task'
  | 'thread'
  | 'contact';

export type AccessLevel = 'none' | 'read' | 'write' | 'owner';

export interface Accessor {
  userId: string;
  role: 'super_admin' | 'member';
}

export interface AccessDecision {
  level: AccessLevel;
  /** True when the row exists but this person may not see it. Callers turn this
   * into a 404 rather than a 403 — telling someone "that exists but is not
   * yours" confirms the existence of a colleague's private resource. */
  existsButHidden: boolean;
  ownerUserId?: string;
}

/** Tables that hold owner-scoped rows. Keeping this map here rather than
 * accepting a caller-supplied table name means a typo cannot turn into SQL
 * injection or an accidental read of an unrelated table. */
const OWNED_TABLES: Record<ResourceType, string> = {
  connection: 'connections',
  folder_mapping: 'folder_mappings',
  email_thread: 'email_threads',
  task: 'tasks',
  thread: 'threads',
  contact: 'contacts',
};

/** Resource types that may never be shared, whatever the owner asks for.
 *
 * A connection carries an OAuth grant. Sharing it would hand someone else the
 * ability to act as the owner against Google or Microsoft, which is not a
 * sharing feature, it is account handover. The canonical map allows sharing
 * folders and threads; it does not allow this. */
const NEVER_SHAREABLE: ReadonlySet<ResourceType> = new Set<ResourceType>(['connection']);

export function isShareable(type: ResourceType): boolean {
  return !NEVER_SHAREABLE.has(type);
}

/** The decision point.
 *
 * Note what is absent: any branch on `accessor.role`. A super admin resolving a
 * resource they do not own gets exactly what any other non-owner gets. Admin
 * power is expressed by separate policy endpoints that return metadata, never
 * by widening this function. */
export async function resolveAccess(
  db: Db,
  args: { type: ResourceType; resourceId: string; accessor: Accessor },
): Promise<AccessDecision> {
  const table = OWNED_TABLES[args.type];
  if (!table) return { level: 'none', existsButHidden: false };
  // A malformed id is "not found", never a query.
  if (!/^[0-9a-fA-F-]{36}$/.test(args.resourceId)) {
    return { level: 'none', existsButHidden: false };
  }

  const rows = await db.query<{ owner_user_id: string }>(
    `select owner_user_id from ${table} where id = $1`,
    [args.resourceId],
  );
  const row = rows[0];
  if (!row) return { level: 'none', existsButHidden: false };

  if (row.owner_user_id === args.accessor.userId) {
    return { level: 'owner', existsButHidden: false, ownerUserId: row.owner_user_id };
  }

  if (!isShareable(args.type)) {
    return { level: 'none', existsButHidden: true, ownerUserId: row.owner_user_id };
  }

  const shares = await db.query<{ can_write: boolean }>(
    `select can_write from resource_shares
     where resource_type = $1 and resource_id = $2
       and (shared_with_user_id = $3 or shared_with_workspace = true)
     order by can_write desc
     limit 1`,
    [args.type, args.resourceId, args.accessor.userId],
  );
  if (shares.length) {
    return {
      level: shares[0].can_write ? 'write' : 'read',
      existsButHidden: false,
      ownerUserId: row.owner_user_id,
    };
  }

  return { level: 'none', existsButHidden: true, ownerUserId: row.owner_user_id };
}

export function canRead(level: AccessLevel): boolean {
  return level === 'read' || level === 'write' || level === 'owner';
}

export function canWrite(level: AccessLevel): boolean {
  return level === 'write' || level === 'owner';
}

/** Only an owner may change who else can see their resource. Not a co-editor
 * with write access, and not the super admin. */
export function canShare(level: AccessLevel): boolean {
  return level === 'owner';
}

export class NotShareableError extends Error {}

export async function shareResource(
  db: Db,
  args: {
    type: ResourceType;
    resourceId: string;
    ownerUserId: string;
    withUserId?: string | null;
    withWorkspace?: boolean;
    canWrite?: boolean;
  },
): Promise<void> {
  if (!isShareable(args.type)) {
    throw new NotShareableError(`${args.type} carries an account grant and cannot be shared`);
  }
  await db.query(
    `insert into resource_shares
       (resource_type, resource_id, owner_user_id, shared_with_user_id, shared_with_workspace, can_write)
     values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing`,
    [
      args.type,
      args.resourceId,
      args.ownerUserId,
      args.withUserId ?? null,
      args.withWorkspace ?? false,
      args.canWrite ?? false,
    ],
  );
}

export async function unshareResource(
  db: Db,
  args: { type: ResourceType; resourceId: string; withUserId?: string | null; withWorkspace?: boolean },
): Promise<void> {
  if (args.withWorkspace) {
    await db.query(
      `delete from resource_shares
       where resource_type = $1 and resource_id = $2 and shared_with_workspace = true`,
      [args.type, args.resourceId],
    );
    return;
  }
  await db.query(
    `delete from resource_shares
     where resource_type = $1 and resource_id = $2 and shared_with_user_id = $3`,
    [args.type, args.resourceId, args.withUserId ?? null],
  );
}

/** Every resource of a type this person may see, as ids. Used by list
 * endpoints so "list mine" and "may I read this one" cannot drift apart. */
export async function visibleResourceIds(
  db: Db,
  args: { type: ResourceType; accessor: Accessor },
): Promise<string[]> {
  const table = OWNED_TABLES[args.type];
  if (!table) return [];
  const owned = await db.query<{ id: string }>(
    `select id from ${table} where owner_user_id = $1`,
    [args.accessor.userId],
  );
  if (!isShareable(args.type)) return owned.map((r) => r.id);

  const shared = await db.query<{ resource_id: string }>(
    `select resource_id from resource_shares
     where resource_type = $1 and (shared_with_user_id = $2 or shared_with_workspace = true)`,
    [args.type, args.accessor.userId],
  );
  return [...new Set([...owned.map((r) => r.id), ...shared.map((r) => r.resource_id)])];
}
