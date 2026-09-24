// Can this machine actually run Josi?
//
// Two constraints shape every check here:
//
//   * The result is shown on an UNAUTHENTICATED page, because setup runs before
//     any account exists. So a check reports whether something is fine and what
//     to do about it — never a path, a version string, a byte count, a hostname
//     or an error from the operating system. "Not enough disk space" is
//     actionable; "/var/lib/docker has 412,336,128 bytes free" is a disclosure.
//
//   * No capacity claims (canonical map M97). These checks answer "can this
//     run at all", never "this machine supports N users".
import { statfsSync } from 'node:fs';
import { checkReadiness, masterKeyAvailable, type Db, type LoadOptions } from '@josi-ce/core';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface HostCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** One sentence an operator can act on. No internals. */
  detail: string;
  /** A failing mandatory check blocks setup from completing. */
  mandatory: boolean;
}

const MIN_NODE_MAJOR = 22;
/** Enough room for the database, a few images and some documents. Deliberately
 * modest: CE targets old hardware, and refusing to install on a small disk would
 * be a capacity claim by the back door. */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

export interface HostCheckOptions {
  masterKey?: LoadOptions | false;
  /** Injected in tests. */
  now?: () => Date;
  freeBytes?: (path: string) => number | null;
  nodeVersion?: string;
}

function freeBytesOf(path: string): number | null {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function runHostChecks(db: Db, opts: HostCheckOptions = {}): Promise<HostCheck[]> {
  const checks: HostCheck[] = [];

  // --- Node runtime ---
  const version = opts.nodeVersion ?? process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);
  checks.push({
    id: 'node_runtime',
    label: 'Application runtime',
    mandatory: true,
    status: major >= MIN_NODE_MAJOR ? 'pass' : 'fail',
    detail: major >= MIN_NODE_MAJOR
      ? 'The bundled runtime is supported.'
      : 'This image is running an unsupported runtime. Pull the current Josi CE image.',
  });

  // --- Database + schema ---
  // Reuses the readiness logic rather than asking the same questions a second
  // way, so the two can never disagree about what "migrated" means.
  const readiness = await checkReadiness(db, { masterKey: false });
  const dbUp = !readiness.blockers.includes('database');
  checks.push({
    id: 'database',
    label: 'Database connection',
    mandatory: true,
    status: dbUp ? 'pass' : 'fail',
    detail: dbUp
      ? 'Josi can reach its database.'
      : 'Josi cannot reach its database. Check that the database container is running.',
  });
  const migrated = dbUp && !readiness.blockers.includes('migrations');
  checks.push({
    id: 'migrations',
    label: 'Database schema',
    mandatory: true,
    status: migrated ? 'pass' : 'fail',
    detail: migrated
      ? 'The schema is up to date.'
      : 'The database has not been migrated. Restart the stack so the migration step runs.',
  });

  // --- Master key ---
  // Without it nothing can be sealed, so every later step that stores a secret
  // would fail. Better to say so on the first screen.
  const keyOk = opts.masterKey === false ? true : masterKeyAvailable(opts.masterKey ?? {});
  checks.push({
    id: 'master_key',
    label: 'Installation master key',
    mandatory: true,
    status: keyOk ? 'pass' : 'fail',
    detail: keyOk
      ? 'Found. Back it up separately — a database backup alone cannot restore your saved credentials.'
      : 'No usable master key. Run scripts/install.sh and mount it as a Docker secret, then reload.',
  });

  // --- Writable scratch space ---
  // The container runs with a read-only root filesystem and a small tmpfs. If
  // that is missing, uploads and exports fail later in confusing ways.
  let scratchOk = true;
  try {
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const probe = `/tmp/.josi-setup-probe-${process.pid}`;
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch {
    scratchOk = false;
  }
  checks.push({
    id: 'scratch_space',
    label: 'Temporary storage',
    mandatory: true,
    status: scratchOk ? 'pass' : 'fail',
    detail: scratchOk
      ? 'Josi can write temporary files.'
      : 'Josi cannot write temporary files. Check the container has a writable /tmp.',
  });

  // --- Disk headroom ---
  // Advisory. A warning, not a refusal: the operator knows their disk better
  // than a threshold does.
  //
  // Measured where data actually grows. /tmp in the hardened container is a
  // small tmpfs; measuring it warned about a 64 MB scratchpad while the data
  // volume sat on a nearly empty disk, which is a warning about the wrong
  // thing. /data/versions is a named volume on the host disk; /tmp is only
  // the fallback when no data volume is mounted (tests, bare runs).
  const gb = (n: number) => (n / (1024 ** 3)).toFixed(n >= 100 * (1024 ** 3) ? 0 : 1);
  const measure = opts.freeBytes ?? freeBytesOf;
  const free = measure('/data/versions') ?? measure('/tmp');
  checks.push({
    id: 'disk_space',
    label: 'Free disk space',
    mandatory: false,
    status: free === null ? 'warn' : free >= MIN_FREE_BYTES ? 'pass' : 'warn',
    detail: free === null
      ? 'Could not determine free space. Make sure there is room for the database to grow.'
      : free >= MIN_FREE_BYTES
        ? `There is room to install and grow: ${gb(free)} GB free where Josi stores its data.`
        : `Free space is low: ${gb(free)} GB free where Josi stores its data. Josi will install, but the database and documents need room.`,
  });

  return checks;
}

/** Setup may not complete while a mandatory check is failing. Warnings never
 * block: they are the operator's call. */
export function blockingFailures(checks: readonly HostCheck[]): HostCheck[] {
  return checks.filter((c) => c.mandatory && c.status === 'fail');
}
