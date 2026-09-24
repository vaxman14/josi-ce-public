import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import type { Db } from '@josi-ce/core';

export const WORKSPACE_MOUNT_PATH = '/workspace';

export interface WorkspaceMountConfiguration {
  enabled: boolean;
  writable: boolean;
}

export interface WorkspaceMountProbe {
  available(path: string, writable: boolean): Promise<boolean>;
}

function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Confirm the path is a mount point, not merely a directory baked into the image. */
export const linuxWorkspaceMountProbe: WorkspaceMountProbe = {
  async available(path, writable) {
    try {
      if (!(await stat(path)).isDirectory()) return false;
      await access(path, constants.R_OK | (writable ? constants.W_OK : 0));
      const mountInfo = await readFile('/proc/self/mountinfo', 'utf8');
      return mountInfo.split('\n').some((line) => {
        const fields = line.split(' ');
        return fields.length > 4 && unescapeMountPath(fields[4]!) === path;
      });
    } catch {
      return false;
    }
  },
};

export function workspaceMountConfiguration(env: NodeJS.ProcessEnv = process.env): WorkspaceMountConfiguration {
  return {
    enabled: env.JOSI_WORKSPACE_ENABLED === '1',
    writable: env.JOSI_WORKSPACE_MODE === 'rw',
  };
}

export function workspaceMountRootAllowed(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return path === WORKSPACE_MOUNT_PATH && workspaceMountConfiguration(env).enabled;
}

export type WorkspaceMountReconcileResult =
  | { status: 'disabled' | 'unavailable' | 'awaiting_owner' | 'revoked' | 'awaiting_mapping' }
  | { status: 'ready'; rootId: string; mappingId: string; ownerUserId: string; writable: boolean };

/**
 * Reconcile the installer's one explicit workspace mount into the application
 * authorization model. The fixed container path is intentional: neither an
 * environment variable nor database content may turn this into host browsing.
 */
export async function reconcileWorkspaceMount(
  db: Db,
  configuration: WorkspaceMountConfiguration = workspaceMountConfiguration(),
  probe: WorkspaceMountProbe = linuxWorkspaceMountProbe,
): Promise<WorkspaceMountReconcileResult> {
  if (!configuration.enabled) {
    // A retained row is useful for a later re-enable, but it must disappear
    // from discovery while the explicit overlay is absent.
    await db.query(
      `update storage_roots set enabled = false where container_path = $1 and enabled = true`,
      [WORKSPACE_MOUNT_PATH],
    );
    return { status: 'disabled' };
  }
  if (!await probe.available(WORKSPACE_MOUNT_PATH, configuration.writable)) {
    // The flag alone is not authority. If an upgrade starts without the bind
    // mount, fail closed even when a grant from an earlier boot remains.
    await db.query(
      `update storage_roots set enabled = false where container_path = $1 and enabled = true`,
      [WORKSPACE_MOUNT_PATH],
    );
    return { status: 'unavailable' };
  }

  // CE has a database-enforced single owner. Requiring that active owner keeps
  // an upgrade from assigning a host mount to whichever member sorts first.
  const [owner] = await db.query<{ id: string }>(
    `select id from users
     where role = 'super_admin' and status = 'active'
     order by created_at, id limit 1`,
  );
  if (!owner) return { status: 'awaiting_owner' };

  const [priorRoot] = await db.query<{ id: string }>(
    `select id from storage_roots where container_path = $1`, [WORKSPACE_MOUNT_PATH],
  );
  const rootWasNew = !priorRoot;
  const [root] = priorRoot
    ? await db.query<{ id: string }>(
      `update storage_roots set writable = $2, enabled = true where id = $1 returning id`,
      [priorRoot.id, configuration.writable],
    )
    : await db.query<{ id: string }>(
      `insert into storage_roots (container_path, label, purpose, writable, enabled)
       values ($1, 'Workspace', 'Developer workspace selected during installation', $2, true)
       returning id`,
      [WORKSPACE_MOUNT_PATH, configuration.writable],
    );

  if (rootWasNew) {
    // The installer selection is authority for the first grant only. A later
    // capability revocation must survive every restart.
    await db.query(
      `insert into storage_capabilities (user_id, may_map_local, granted_by)
       values ($1, true, $1)
       on conflict (user_id) do update set
         may_map_local = true,
         granted_by = excluded.granted_by,
         updated_at = now()`,
      [owner.id],
    );
  } else {
    const [capability] = await db.query<{ may_map_local: boolean }>(
      `select may_map_local from storage_capabilities where user_id = $1`, [owner.id],
    );
    if (!capability?.may_map_local) return { status: 'revoked' };
  }

  const [existing] = await db.query<{ id: string; status: string }>(
    `select id,status from folder_mappings
     where owner_user_id = $1 and provider = 'local' and root_id = $2 and relative_path = ''
     order by (status <> 'revoked') desc, created_at, id limit 1`,
    [owner.id, root.id],
  );
  if (existing?.status === 'revoked') return { status: 'revoked' };
  if (!existing && !rootWasNew) return { status: 'awaiting_mapping' };
  const permissions = configuration.writable;
  let mappingId: string;
  if (existing) {
    await db.query(
      `update folder_mappings set
         display_path = $2,
         recursive = true,
         may_create = $3,
         may_edit = $3,
         may_move = $3,
         may_delete = $3,
         paused_reason = null
       where id = $1`,
      [existing.id, WORKSPACE_MOUNT_PATH, permissions],
    );
    mappingId = existing.id;
  } else {
    const [mapping] = await db.query<{ id: string }>(
      `insert into folder_mappings
         (owner_user_id, provider, root_id, relative_path, display_path, recursive,
          may_create, may_edit, may_move, may_delete)
       values ($1, 'local', $2, '', $3, true, $4, $4, $4, $4)
       returning id`,
      [owner.id, root.id, WORKSPACE_MOUNT_PATH, permissions],
    );
    mappingId = mapping.id;
  }

  return { status: 'ready', rootId: root.id, mappingId, ownerUserId: owner.id,
    writable: configuration.writable };
}
