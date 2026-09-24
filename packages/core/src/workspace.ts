// The workspace is a singleton. Everything that would have been "which tenant?"
// in the commercial engine is simply "the workspace" here, and the database
// enforces that there is only one.
import { json, type Db } from './db.js';

export interface Workspace {
  id: boolean;
  name: string;
  timezone: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function getWorkspace(db: Db): Promise<Workspace | null> {
  const rows = await db.query<Workspace>(`select * from workspace where id = true`);
  return rows[0] ?? null;
}

/** Creates the workspace if it does not exist. Idempotent: the singleton
 * constraint turns a double call into a no-op rather than a second workspace. */
export async function ensureWorkspace(
  db: Db,
  args: { name?: string; timezone?: string } = {},
): Promise<Workspace> {
  await db.query(
    `insert into workspace (id, name, timezone) values (true, $1, $2)
     on conflict (id) do nothing`,
    [args.name ?? 'My workspace', args.timezone ?? 'UTC'],
  );
  const ws = await getWorkspace(db);
  if (!ws) throw new Error('workspace could not be created');
  return ws;
}

export async function updateWorkspace(
  db: Db,
  patch: { name?: string; timezone?: string; settings?: Record<string, unknown> },
): Promise<Workspace> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof patch.name === 'string' && patch.name.trim()) {
    params.push(patch.name.trim());
    sets.push(`name = $${params.length}`);
  }
  if (typeof patch.timezone === 'string' && patch.timezone.trim()) {
    params.push(patch.timezone.trim());
    sets.push(`timezone = $${params.length}`);
  }
  if (patch.settings && typeof patch.settings === 'object') {
    // Merge, never replace: a partial save must not drop unrelated settings.
    params.push(json(patch.settings));
    sets.push(`settings = settings || $${params.length}::jsonb`);
  }
  if (!sets.length) {
    const current = await getWorkspace(db);
    if (!current) throw new Error('no workspace');
    return current;
  }
  const rows = await db.query<Workspace>(
    `update workspace set ${sets.join(', ')} where id = true returning *`,
    params,
  );
  return rows[0];
}

/** The installation's support-correlation id. Random, local, and deliberately
 * not derived from anything about the hardware. */
export async function getInstallId(db: Db): Promise<string> {
  const rows = await db.query<{ install_id: string }>(
    `select install_id from install_identity where id = true`,
  );
  if (rows[0]) return rows[0].install_id;
  const created = await db.query<{ install_id: string }>(
    `insert into install_identity (id) values (true) returning install_id`,
  );
  return created[0].install_id;
}

// ---------------------------------------------------------------- setup state
export interface SetupState {
  completed: boolean;
  current_step: string;
  /** Steps the server has accepted. The state machine reads this, not
   * `current_step`, so a resume lands on the first genuinely incomplete step
   * rather than wherever a browser last was. */
  completed_steps: string[];
  progress: Record<string, unknown>;
  completed_at: string | null;
  install_id: string | null;
}

export async function getSetupState(db: Db): Promise<SetupState> {
  const rows = await db.query<SetupState>(
    `select completed, current_step, coalesce(completed_steps, '{}') as completed_steps,
            progress, completed_at, install_id
     from setup_state where id = true`,
  );
  return rows[0] ?? {
    completed: false, current_step: 'welcome', completed_steps: [],
    progress: {}, completed_at: null, install_id: null,
  };
}

export async function saveSetupProgress(
  db: Db,
  args: { step: string; progress?: Record<string, unknown> },
): Promise<SetupState> {
  await db.query(
    `update setup_state set current_step = $1, progress = progress || $2::jsonb where id = true`,
    [args.step, json(args.progress ?? {})],
  );
  return getSetupState(db);
}

/** The latch. Once setup is complete the wizard stops existing, and nothing in
 * the product reopens it — recreating a super admin has to go through an
 * authenticated path or a deliberate operator reset. */
export async function completeSetup(db: Db): Promise<SetupState> {
  await db.query(
    `update setup_state set completed = true, current_step = 'done', completed_at = now()
     where id = true and completed = false`,
  );
  return getSetupState(db);
}
