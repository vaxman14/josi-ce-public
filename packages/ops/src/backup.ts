// Backup and restore.
//
// THE ACCEPTANCE CRITERION IS THE RESTORE, NOT THE BACKUP.
//
// The plan says so in as many words, and it is the correct emphasis: a backup
// that was produced is not evidence of anything. Producing one is easy and
// silent. The only thing worth asserting is that a wiped installation comes
// back — with its encrypted credentials intact when the master key is present,
// and demonstrably WITHOUT them when it is not.
//
// THE MASTER KEY IS NOT IN THE BACKUP (M100)
//
// This is deliberate and it cuts both ways. A stolen backup is useless for
// credentials, which is the property worth having. But an operator who backs up
// the database and forgets the key has a backup that restores their data and
// silently loses every provider key, OAuth token and SMTP password — and they
// will not find out until something stops sending.
//
// So this file refuses to be quiet about it. `describeBackup` states what will
// not come back, the record carries whether the operator confirmed they have the
// key stored separately, and a restore without a key reports
// `credentials_recovered: false` rather than appearing to succeed.
import { createHash } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export class BackupError extends Error {
  constructor(message: string, readonly category: BackupErrorCategory = 'unknown') {
    super(message);
  }
}

export type BackupErrorCategory =
  | 'disk_full' | 'permission_denied' | 'database_unavailable' | 'timeout' | 'unknown';

export type RestoreErrorCategory =
  | 'archive_corrupt' | 'wrong_installation' | 'version_too_new'
  | 'database_unavailable' | 'no_master_key' | 'unknown';

export type BackupKind = 'full' | 'portable';

/** Everything a backup may contain, named once.
 *
 * `masterKey` is absent from this type on purpose. There is no code path that
 * could add it, because there is no field to set. */
export interface BackupContents {
  databaseRows: boolean;
  configuration: boolean;
  uploads: boolean;
  /** M63: full backups include them; portable exports never do. */
  recoveryCopies: boolean;
}

export const FULL_CONTENTS: BackupContents = {
  databaseRows: true, configuration: true, uploads: true, recoveryCopies: true,
};

/** M63: "portable exports exclude them and carry only current portable data and
 * files". A portable export is for taking your data somewhere else, not for
 * restoring an installation, and shipping N copies of every document in it
 * would make it enormous for no benefit. */
export const PORTABLE_CONTENTS: BackupContents = {
  databaseRows: true, configuration: false, uploads: true, recoveryCopies: false,
};

export function contentsFor(kind: BackupKind): BackupContents {
  return kind === 'full' ? FULL_CONTENTS : PORTABLE_CONTENTS;
}

/**
 * What an operator is told before and after taking a backup.
 *
 * The master-key sentence is not a footnote. An operator who reads only one
 * line of this should still learn that the database backup alone cannot restore
 * their credentials.
 */
export function describeBackup(kind: BackupKind, masterKeyConfirmed: boolean): string {
  const parts: string[] = [];
  if (kind === 'full') {
    parts.push(
      'This is a full backup: every database row, your configuration, uploaded files, '
      + 'and any retained recovery copies.',
    );
  } else {
    parts.push(
      'This is a portable export: your current data and files in a readable form. '
      + 'It does not include previous versions or recovery copies, and it is not '
      + 'intended for restoring an installation.',
    );
  }

  parts.push(
    'It does NOT contain the installation master key. That is deliberate — a copy of '
    + 'this file is useless to anyone who does not also have the key.',
  );
  parts.push(
    masterKeyConfirmed
      ? 'You have confirmed the master key is stored separately. Keep it that way: without '
      + 'it, restoring this backup can reopen the Master Vault. The offline Vault recovery '
        + 'key is a separate recovery path and must also be kept outside this backup.'
      : 'You have NOT confirmed where the master key is stored. Back up '
        + '/run/secrets/josi_master_key separately and keep it somewhere else. Without it, '
        + 'restoring this backup cannot reopen saved credentials unless you kept the separate '
        + 'offline Vault recovery key. Neither key is included here.',
  );
  return parts.join(' ');
}

export interface BackupRow {
  id: string;
  kind: BackupKind;
  stored_path: string;
  byte_size: string | number;
  sha256: string | null;
  includes_recovery_copies: boolean;
  includes_documents: boolean;
  includes_master_key: boolean;
  master_key_confirmed: boolean;
  state: 'running' | 'complete' | 'failed';
  error_category: BackupErrorCategory | null;
  progress_percent: number;
  progress_phase: string;
  progress_step: number;
  progress_steps: number;
}

/** How the bytes are actually produced. Injected so the suite can drive the
 * whole lifecycle without a real `pg_dump`, and so the runtime test can use the
 * real one. */
export interface BackupWriter {
  /** Returns the archive bytes. Throws `BackupError` with a category. */
  write(args: { kind: BackupKind; contents: BackupContents; destination: string }): Promise<{
    byteSize: number;
    sha256: string;
  }>;
  read(path: string): Promise<Buffer>;
  remove(path: string): Promise<void>;
}

export const BACKUP_DIR = '/data/backups';

export async function createBackup(
  db: Db,
  args: {
    kind: BackupKind;
    createdBy: string;
    masterKeyConfirmed?: boolean;
    writer: BackupWriter;
    /** Supplied by the caller so paths are deterministic in tests. */
    filename: string;
    /** A validated mounted-share directory for full backups. */
    destinationDir?: string;
    /** Keep the row running while the caller writes and verifies an off-site copy. */
    deferCompletion?: boolean;
  },
): Promise<{ backup: BackupRow; description: string }> {
  const contents = contentsFor(args.kind);
  const storedPath = `${args.destinationDir ?? BACKUP_DIR}/${sanitiseFilename(args.filename)}`;

  const [row] = await db.query<BackupRow>(
    `insert into backups
       (kind, stored_path, includes_recovery_copies, includes_documents,
        master_key_confirmed, created_by, state)
     values ($1, $2, $3, $4, $5, $6, 'running')
     returning *`,
    [
      args.kind, storedPath, contents.recoveryCopies, contents.uploads,
      args.masterKeyConfirmed === true, args.createdBy,
    ],
  );

  try {
    await db.query(
      `update backups set progress_percent = 15, progress_phase = 'exporting database', progress_step = 1 where id = $1`,
      [row.id],
    );
    const { byteSize, sha256 } = await args.writer.write({
      kind: args.kind, contents, destination: storedPath,
    });
    const [done] = await db.query<BackupRow>(
      `update backups set state = $4, byte_size = $2, sha256 = $3,
          completed_at = case when $4 = 'complete' then now() else null end,
          progress_percent = case when $4 = 'complete' then 100 else 60 end,
          progress_phase = case when $4 = 'complete' then 'verified' else 'local archive ready' end,
          progress_step = case when $4 = 'complete' then progress_steps else 3 end
       where id = $1 returning *`,
      [row.id, byteSize, sha256, args.deferCompletion ? 'running' : 'complete'],
    );
    if (!args.deferCompletion) await appendEvent(db, {
      actorUserId: args.createdBy,
      actor: 'super_admin',
      kind: 'backup.created',
      subjectType: 'backup',
      subjectId: row.id,
      // Size and kind. Never the path — a path is deployment detail and this
      // log is read by whoever can read the audit trail.
      payload: { kind: args.kind, byteSize, masterKeyConfirmed: args.masterKeyConfirmed === true },
    });
    return { backup: done, description: describeBackup(args.kind, args.masterKeyConfirmed === true) };
  } catch (err) {
    const category = err instanceof BackupError ? err.category : 'unknown';
    await db.query(
      `update backups set state = 'failed', error_category = $2, completed_at = now(), progress_phase = 'failed' where id = $1`,
      [row.id, category],
    );
    await appendEvent(db, {
      actorUserId: args.createdBy,
      actor: 'super_admin',
      kind: 'backup.failed',
      subjectType: 'backup',
      subjectId: row.id,
      payload: { kind: args.kind, category },
    });
    throw err instanceof BackupError ? err : new BackupError('the backup could not be written', category);
  }
}

function sanitiseFilename(name: string): string {
  // Strip everything that is not a plain filename character, THEN collapse runs
  // of dots. Stripping alone is not enough: "nightly/../../etc/passwd.zip"
  // becomes "nightly....etcpasswd.zip", which still carries a "..", trips the
  // database's traversal constraint, and turns a bad filename into a database
  // error instead of a clean result. Found by a test written to exercise the
  // stripping rather than the leading-dot check.
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '').replace(/\.{2,}/g, '.');
  if (!cleaned || cleaned.startsWith('.')) throw new BackupError('that is not a usable filename');
  if (cleaned.includes('..') || cleaned.includes('/')) {
    throw new BackupError('that is not a usable filename');
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreReader {
  /** Applies the archive. Throws `RestoreError` with a category. */
  apply(args: { archive: Buffer }): Promise<{ rowsRestored: number }>;
}

export class RestoreError extends Error {
  constructor(message: string, readonly category: RestoreErrorCategory = 'unknown') {
    super(message);
  }
}

export interface RestoreOutcome {
  ok: boolean;
  rowsRestored: number;
  /** THE property. False when the master key was absent, and the caller is
   * expected to say so rather than reporting a clean success. */
  credentialsRecovered: boolean;
  masterKeyPresent: boolean;
  warning?: string;
}

/**
 * Restore, and be honest about what came back.
 *
 * `masterKeyPresent` is passed in rather than read here, because whether the key
 * is mounted is a property of the deployment, not of the archive. What this
 * function guarantees is that the two outcomes are DIFFERENT and both are
 * recorded — a restore without the key must not look like a restore with it.
 */
export async function restoreBackup(
  db: Db,
  args: {
    backupId: string | null;
    archive: Buffer;
    masterKeyPresent: boolean;
    reader: RestoreReader;
  },
): Promise<RestoreOutcome> {
  const [attempt] = await db.query<{ id: string }>(
    `insert into restore_attempts (backup_id, state, master_key_present)
     values ($1, 'running', $2) returning id`,
    [args.backupId, args.masterKeyPresent],
  );

  try {
    const { rowsRestored } = await args.reader.apply({ archive: args.archive });

    // Sealed values came back as ciphertext either way. What differs is whether
    // anything can open them.
    const credentialsRecovered = args.masterKeyPresent;

    await db.query(
      `update restore_attempts
         set state = 'complete', rows_restored = $2, credentials_recovered = $3,
             error_category = $4, finished_at = now()
       where id = $1`,
      [
        attempt.id, rowsRestored, credentialsRecovered,
        credentialsRecovered ? null : 'no_master_key',
      ],
    );

    return {
      ok: true,
      rowsRestored,
      credentialsRecovered,
      masterKeyPresent: args.masterKeyPresent,
      warning: credentialsRecovered ? undefined : NO_KEY_WARNING,
    };
  } catch (err) {
    const category = err instanceof RestoreError ? err.category : 'unknown';
    await db.query(
      `update restore_attempts set state = 'failed', error_category = $2, finished_at = now()
       where id = $1`,
      [attempt.id, category],
    );
    throw err instanceof RestoreError ? err : new RestoreError('the backup could not be restored', category);
  }
}

export const NO_KEY_WARNING =
  'Your data has been restored, but the installation master key was not present, so '
  + 'saved provider keys, connected accounts and mail passwords could NOT be decrypted. '
  + 'They are still stored, still encrypted, and unreadable without the original key. '
  + 'Restore that key and they will work again; without it they must be entered afresh.';

/** M100 stated once, for the setup and backup documentation to quote. */
export const MASTER_KEY_DOC =
  'The installation master key is stored outside the database, as a Docker secret at '
  + '/run/secrets/josi_master_key. It is never included in a backup. Back it up separately '
  + 'and store it somewhere other than your database backups — a backup and a key kept in '
  + 'the same place protect against disk failure but not against theft.';

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
