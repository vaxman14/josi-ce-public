// Updating, and coming back from a failed one.
//
// "Never automatic" is the whole design, and it is enforced by absence: there is
// no setting anywhere that enables automatic updating. Not one defaulting to
// false — a setting that exists is a setting somebody can flip, or that a future
// migration can default differently. A test can prove a column does not exist;
// it cannot prove a column will stay false forever.
//
// The sequence is fixed and each step gates the next:
//
//   check → approve → BACK UP → apply → health check → (rollback on failure)
//
// The backup is not optional and not last. An update that cannot take a backup
// does not proceed, because the entire value of rollback is having something to
// roll back to.
import { appendEvent, type Db } from '@josi-ce/core';

export type UpdateState =
  | 'pending' | 'backing_up' | 'applying' | 'health_check'
  | 'complete' | 'rolling_back' | 'rolled_back' | 'failed';

export type UpdateFailure =
  | 'backup_failed' | 'download_failed' | 'migration_failed'
  | 'health_check_failed' | 'rollback_failed' | 'unknown';

export class UpdateError extends Error {
  constructor(message: string, readonly category: UpdateFailure = 'unknown') {
    super(message);
  }
}

export interface UpdateSteps {
  /** Fetch and stage the new image. */
  download(toVersion: string): Promise<void>;
  /** Take a backup first. Returns its id, which the run records. */
  backup(): Promise<string>;
  /** Apply: migrations and container replacement. */
  apply(toVersion: string): Promise<void>;
  /** Is the installation actually working afterwards? */
  healthCheck(): Promise<boolean>;
  /** Put the previous version back. */
  rollback(toVersion: string): Promise<void>;
}

export interface UpdateOutcome {
  state: 'complete' | 'rolled_back' | 'failed';
  fromVersion: string;
  toVersion: string;
  backupId: string | null;
  failure?: UpdateFailure;
  message: string;
}

/**
 * Run an approved update.
 *
 * The health check is what makes rollback meaningful. Without it "the update
 * worked" means "the container started", which is exactly the state a broken
 * migration leaves behind.
 *
 * A failed ROLLBACK is reported as its own category, and deliberately not
 * softened: an installation stuck between versions needs a human, and telling
 * the operator it merely "failed" would send them looking in the wrong place.
 */
export async function runUpdate(
  db: Db,
  args: { toVersion: string; approvedBy: string; steps: UpdateSteps },
): Promise<UpdateOutcome> {
  const [state] = await db.query<{ current_version: string }>(
    `select current_version from update_state where id = true`,
  );
  const fromVersion = state?.current_version ?? '0.0.0';

  const [run] = await db.query<{ id: string }>(
    `insert into update_runs (from_version, to_version, approved_by, state)
     values ($1, $2, $3, 'pending') returning id`,
    [fromVersion, args.toVersion, args.approvedBy],
  );

  const setState = (s: UpdateState) =>
    db.query(`update update_runs set state = $2 where id = $1`, [run.id, s]);

  const fail = async (category: UpdateFailure, message: string): Promise<UpdateOutcome> => {
    await db.query(
      `update update_runs set state = 'failed', failure_category = $2, finished_at = now()
       where id = $1`,
      [run.id, category],
    );
    await appendEvent(db, {
      actorUserId: args.approvedBy,
      actor: 'super_admin',
      kind: 'update.failed',
      subjectType: 'update_run',
      subjectId: run.id,
      payload: { fromVersion, toVersion: args.toVersion, category },
    });
    return { state: 'failed', fromVersion, toVersion: args.toVersion, backupId: null, failure: category, message };
  };

  // 1. Back up FIRST.
  await setState('backing_up');
  let backupId: string;
  try {
    backupId = await args.steps.backup();
  } catch {
    return fail(
      'backup_failed',
      'The update did not start, because the pre-update backup failed. Nothing has changed.',
    );
  }
  await db.query(`update update_runs set backup_id = $2 where id = $1`, [run.id, backupId]);

  // 2. Download.
  try {
    await args.steps.download(args.toVersion);
  } catch {
    const out = await fail(
      'download_failed',
      'The new version could not be downloaded. Nothing has changed.',
    );
    return { ...out, backupId };
  }

  // 3. Apply.
  await setState('applying');
  try {
    await args.steps.apply(args.toVersion);
  } catch {
    return rollback(db, {
      runId: run.id, fromVersion, toVersion: args.toVersion, backupId,
      approvedBy: args.approvedBy, steps: args.steps, because: 'migration_failed',
    });
  }

  // 4. Health check. Without this, "it started" would count as "it worked".
  await setState('health_check');
  let healthy = false;
  try {
    healthy = await args.steps.healthCheck();
  } catch {
    healthy = false;
  }
  if (!healthy) {
    return rollback(db, {
      runId: run.id, fromVersion, toVersion: args.toVersion, backupId,
      approvedBy: args.approvedBy, steps: args.steps, because: 'health_check_failed',
    });
  }

  await db.query(
    `update update_runs set state = 'complete', finished_at = now() where id = $1`, [run.id],
  );
  await db.query(
    `update update_state set current_version = $1, available_version = null where id = true`,
    [args.toVersion],
  );
  await appendEvent(db, {
    actorUserId: args.approvedBy,
    actor: 'super_admin',
    kind: 'update.completed',
    subjectType: 'update_run',
    subjectId: run.id,
    payload: { fromVersion, toVersion: args.toVersion },
  });

  return {
    state: 'complete', fromVersion, toVersion: args.toVersion, backupId,
    message: `Updated from ${fromVersion} to ${args.toVersion}.`,
  };
}

async function rollback(
  db: Db,
  args: {
    runId: string; fromVersion: string; toVersion: string; backupId: string;
    approvedBy: string; steps: UpdateSteps; because: UpdateFailure;
  },
): Promise<UpdateOutcome> {
  await db.query(`update update_runs set state = 'rolling_back' where id = $1`, [args.runId]);

  try {
    await args.steps.rollback(args.fromVersion);
  } catch {
    await db.query(
      `update update_runs set state = 'failed', failure_category = 'rollback_failed', finished_at = now()
       where id = $1`,
      [args.runId],
    );
    await appendEvent(db, {
      actorUserId: args.approvedBy,
      actor: 'super_admin',
      kind: 'update.rollback_failed',
      subjectType: 'update_run',
      subjectId: args.runId,
      payload: { fromVersion: args.fromVersion, toVersion: args.toVersion, because: args.because },
    });
    return {
      state: 'failed',
      fromVersion: args.fromVersion,
      toVersion: args.toVersion,
      backupId: args.backupId,
      failure: 'rollback_failed',
      // Not softened. This installation needs a person.
      message: 'The update failed AND the rollback failed. This installation is between '
        + `versions and needs manual attention. A backup was taken before the update started.`,
    };
  }

  await db.query(
    `update update_runs set state = 'rolled_back', failure_category = $2, finished_at = now()
     where id = $1`,
    [args.runId, args.because],
  );
  // The recorded version must still be the old one — the update did not happen.
  await db.query(
    `update update_state set current_version = $1 where id = true`, [args.fromVersion],
  );
  await appendEvent(db, {
    actorUserId: args.approvedBy,
    actor: 'super_admin',
    kind: 'update.rolled_back',
    subjectType: 'update_run',
    subjectId: args.runId,
    payload: { fromVersion: args.fromVersion, toVersion: args.toVersion, because: args.because },
  });

  return {
    state: 'rolled_back',
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    backupId: args.backupId,
    failure: args.because,
    message: args.because === 'health_check_failed'
      ? `Version ${args.toVersion} started but did not pass its health check, so Josi went `
        + `back to ${args.fromVersion}. Your installation is working.`
      : `Version ${args.toVersion} could not be applied, so Josi went back to `
        + `${args.fromVersion}. Your installation is working.`,
  };
}

/** Checking is a read. It never applies anything, and it is the only network
 * call in this file. */
export async function checkForUpdate(
  db: Db,
  args: { fetchLatest: () => Promise<string | null> },
): Promise<{ current: string; available: string | null }> {
  const [state] = await db.query<{ current_version: string }>(
    `select current_version from update_state where id = true`,
  );
  let available: string | null = null;
  let ok = true;
  try {
    available = await args.fetchLatest();
  } catch {
    ok = false;
  }
  await db.query(
    `update update_state set available_version = $1, last_check_at = now(), last_check_ok = $2
     where id = true`,
    [available, ok],
  );
  return { current: state?.current_version ?? '0.0.0', available };
}

/** Semantic-ish comparison, tolerant of a missing patch. Returns true when
 * `candidate` is newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(candidate);
  const [x, y, z] = parse(current);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}
