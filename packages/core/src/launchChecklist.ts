// What the administrator still has to do.
//
// Setup finishing is not the same as an installation being ready to use, and
// the gap between them was invisible: the person who ran setup landed on the
// ordinary user dashboard, identical to what every member sees, with no
// indication that nobody had been invited, no backup had been taken, the
// master key had never been copied off the server, and two setup steps had been
// skipped.
//
// Every item here is DERIVED from what the installation contains. There is no
// "mark as done" for anything Josi can observe, because a checklist you can
// tick without doing the work is a checklist that measures optimism.
//
// The one exception is the master-key backup, and it is exception-shaped for a
// reason: the file is copied to somewhere Josi cannot see, so there is nothing
// to measure. It is a confirmation, it records who made it, and it is the only
// item of its kind.
import type { Db } from './db.js';
import { appendEvent } from './events.js';

export type ChecklistSeverity = 'critical' | 'important' | 'optional';

export type ChecklistState = 'done' | 'outstanding' | 'failed' | 'dismissed' | 'unavailable';

export interface ChecklistItemSpec {
  key: string;
  label: string;
  /** What goes wrong if this is left. Written as a consequence, not a nag. */
  why: string;
  severity: ChecklistSeverity;
  /** Where to go and do it, or null when Josi has no screen for it.
   *
   * Null is not a shortcut. Three of these — backups, updates and diagnostics —
   * are real work with a real API and NO user interface in this release, and
   * the first version of this file pointed all of them at `/admin/operations`,
   * a route that does not exist. Pressing "Do this" fell through the catch-all
   * and silently returned the administrator to the user dashboard. An item that
   * says where the work actually happens is better than a button that goes
   * nowhere. */
  href: string | null;
  /** Shown instead of a button when there is no screen. */
  insteadOfScreen?: string;
}

/** The whole checklist, in the order an administrator should work through it.
 *
 * Ordered by consequence rather than by convenience: the two things that lose
 * data permanently come first, then the things that stop Josi working at all,
 * then the things that make it useful. */
export const CHECKLIST_ITEMS: readonly ChecklistItemSpec[] = Object.freeze([
  {
    key: 'master_key_backup',
    label: 'Recovery keys are stored safely',
    why:
      'Every credential Josi stores depends on the installation key or the one-time offline Vault '
      + 'recovery key. Setup already records the Vault-key acknowledgement; this safeguard is complete '
      + 'when that acknowledgement or the later administrator confirmation exists.',
    severity: 'critical',
    href: '/admin/vault',
  },
  {
    key: 'backup_taken',
    label: 'Optional backups and restore checks',
    why: 'Backups are optional. If you choose to use them, a restore check confirms the backup is usable.',
    severity: 'optional',
    href: '/admin/backups',
  },
  {
    key: 'model',
    label: 'A working language model',
    why:
      'Josi cannot answer anybody without one. Nothing else on this list matters until a model '
      + 'has replied to a real request.',
    severity: 'critical',
    href: '/admin/model',
  },
  {
    key: 'approval_policy',
    label: 'Decide how much Josi may do without asking',
    why:
      'A new installation asks before every action, which is safe and quickly becomes tiring. '
      + 'Setting a ceiling deliberately beats loosening it in a hurry later.',
    severity: 'important',
    href: '/admin/policy',
  },
  {
    key: 'smtp',
    label: 'Email sending',
    why:
      'Without it Josi cannot send invitations or password resets, so nobody else can be given an '
      + 'account, and it cannot send mail on anyone\'s behalf.',
    severity: 'important',
    href: null,
    insteadOfScreen:
      'Mail is configured during installation. To change it afterwards, re-run setup on a fresh '
      + 'installation or edit it through the API — there is no mail screen in this release.',
  },
  {
    key: 'users',
    label: 'Invite the people who will use this',
    why: 'Right now this installation has one account. Josi is doing nothing for anybody else.',
    severity: 'important',
    href: '/admin/people',
  },
  {
    key: 'connectors',
    label: 'Google or Microsoft applications',
    why:
      'Until one is registered, nobody can connect their calendar or mail, so Josi cannot see a '
      + 'schedule or a message.',
    severity: 'optional',
    href: '/admin/connectors',
  },
  {
    key: 'security_review',
    label: 'Look at the security and privacy settings',
    why: 'They were set during installation from defaults. Confirm they match what this business needs.',
    severity: 'optional',
    href: '/admin/policy',
  },
  {
    key: 'updates',
    label: 'Know how updates happen',
    why:
      'Josi never updates itself. Nothing is downloaded and nothing is applied until an '
      + 'administrator asks for it, so somebody has to be the one who asks.',
    severity: 'optional',
    href: null,
    insteadOfScreen:
      'Nothing downloads or applies an update on its own. The procedure, including rollback, is in '
      + 'INSTALLATION.md §16.',
  },
  {
    key: 'diagnostics',
    label: 'Know what a diagnostics bundle contains',
    why:
      'If you ever send one for support, it is worth knowing in advance that it is redacted, '
      + 'secret-scanned, and carries no messages or documents.',
    severity: 'optional',
    href: null,
    insteadOfScreen:
      'A diagnostics bundle is produced through the API. What it contains, and what it deliberately '
      + 'does not, is in INSTALLATION.md §17.',
  },
]);

export interface ChecklistItem extends ChecklistItemSpec {
  state: ChecklistState;
  /** Present when there is something specific to say about this installation. */
  detail: string | null;
  /** Whether the administrator may put this aside. */
  dismissible: boolean;
}

export interface LaunchChecklist {
  seen: boolean;
  items: ChecklistItem[];
  /** Done or deliberately dismissed, over the total. */
  progress: { done: number; total: number };
  /** Outstanding items that carry real risk and cannot be dismissed. */
  reminders: ChecklistItem[];
  complete: boolean;
}

/** A critical item can never be dismissed.
 *
 * The point of dismissal is to let an administrator say "not for this
 * installation" about work that genuinely does not apply. Applied to the
 * master-key backup it would mean a single click permanently silencing the
 * warning about the one failure that cannot be recovered from. */
export function isDismissible(severity: ChecklistSeverity): boolean {
  return severity !== 'critical';
}

export interface ChecklistFacts {
  masterKeyBackupConfirmed: boolean;
  backupCount: number;
  restoreVerified: boolean;
  /** From `setup_verifications`, keyed by item. */
  verifications: Map<string, { status: 'passed' | 'failed' | 'skipped'; detail: string | null }>;
  userCount: number;
  /** Whether the administrator has explicitly set any approval ceiling. */
  approvalPolicySet: boolean;
  /** Ceilings seeded by migration that nobody has acknowledged. */
  unacknowledgedPolicyChanges: number;
  connectorsConfigured: number;
  /** Null when connectors are possible; a reason when they are not. */
  connectorsUnavailableReason: string | null;
  securityReviewed: boolean;
  updateChannelKnown: boolean;
  diagnosticsSeen: boolean;
  dismissed: Set<string>;
}

/** The whole computation, as a pure function of observed facts.
 *
 * Separated from the queries so every combination can be tested without
 * constructing an installation for each one. */
export function buildChecklist(facts: ChecklistFacts, seen: boolean): LaunchChecklist {
  const items: ChecklistItem[] = CHECKLIST_ITEMS.map((spec) => {
    const dismissible = isDismissible(spec.severity);
    const { state, detail } = evaluate(spec.key, facts);

    // A dismissal never overrides a FAILURE. Putting aside "I have not done
    // this" is a decision; putting aside "this is broken" is hiding.
    const dismissed = dismissible && facts.dismissed.has(spec.key) && state === 'outstanding';
    return {
      ...spec,
      dismissible,
      state: dismissed ? 'dismissed' : state,
      detail,
    };
  });

  const settled = items.filter((i) => i.state === 'done' || i.state === 'dismissed' || i.state === 'unavailable');
  const reminders = items.filter(
    (i) => (i.state === 'outstanding' || i.state === 'failed') && !i.dismissible,
  );

  return {
    seen,
    items,
    progress: { done: settled.length, total: items.length },
    reminders,
    complete: items.every((i) => i.state !== 'outstanding' && i.state !== 'failed'),
  };
}

function evaluate(key: string, f: ChecklistFacts): { state: ChecklistState; detail: string | null } {
  const verification = (item: string): { state: ChecklistState; detail: string | null } => {
    const v = f.verifications.get(item);
    if (!v) return { state: 'outstanding', detail: 'Nothing has been tested for this yet.' };
    if (v.status === 'passed') return { state: 'done', detail: v.detail };
    if (v.status === 'failed') return { state: 'failed', detail: v.detail };
    return { state: 'outstanding', detail: 'Skipped during installation.' };
  };

  switch (key) {
    case 'master_key_backup':
      return f.masterKeyBackupConfirmed
        ? { state: 'done', detail: 'Confirmed.' }
        : { state: 'outstanding', detail: 'Not confirmed. Josi cannot check this for you — the copy is somewhere it cannot see.' };

    case 'backup_taken':
      if (!f.backupCount) return { state: 'done', detail: 'Optional; no backup is configured.' };
      return f.restoreVerified
        ? { state: 'done', detail: `${f.backupCount} backup(s), and a restore has been verified.` }
        : { state: 'done', detail: `${f.backupCount} backup(s) taken. A restore check is optional and has not been run.` };

    case 'model':
      return verification('llm');

    case 'smtp':
      return verification('smtp');

    case 'connectors': {
      if (f.connectorsUnavailableReason) {
        return { state: 'unavailable', detail: f.connectorsUnavailableReason };
      }
      const google = f.verifications.get('connector_google');
      const microsoft = f.verifications.get('connector_microsoft');
      if (google?.status === 'failed' || microsoft?.status === 'failed') {
        return { state: 'failed', detail: (google?.status === 'failed' ? google.detail : microsoft?.detail) ?? null };
      }
      return f.connectorsConfigured
        ? { state: 'done', detail: `${f.connectorsConfigured} application(s) registered.` }
        : { state: 'outstanding', detail: 'None registered.' };
    }

    case 'users':
      return f.userCount > 1
        ? { state: 'done', detail: `${f.userCount} accounts.` }
        : { state: 'outstanding', detail: 'Only your own account exists.' };

    case 'approval_policy':
      if (f.unacknowledgedPolicyChanges > 0) {
        return {
          state: 'outstanding',
          detail: `${f.unacknowledgedPolicyChanges} action(s) had no ceiling and now ask for approval. Read what changed.`,
        };
      }
      return f.approvalPolicySet
        ? { state: 'done', detail: 'Reviewed.' }
        : { state: 'outstanding', detail: 'Still on the defaults, which ask before everything.' };

    case 'security_review':
      return f.securityReviewed ? { state: 'done', detail: null } : { state: 'outstanding', detail: null };

    case 'updates':
      return f.updateChannelKnown ? { state: 'done', detail: null } : { state: 'outstanding', detail: null };

    case 'diagnostics':
      return f.diagnosticsSeen ? { state: 'done', detail: null } : { state: 'outstanding', detail: null };

    default:
      return { state: 'outstanding', detail: null };
  }
}

// ------------------------------------------------------------------ storage

export async function markChecklistSeen(db: Db, actorUserId: string): Promise<void> {
  const rows = await db.query<{ seen_at: string }>(
    `update admin_checklist_state set seen_at = now() where id = true and seen_at is null returning seen_at`,
  );
  if (rows.length) {
    await appendEvent(db, {
      actorUserId, actor: 'super_admin', kind: 'checklist.seen', payload: {},
    });
  }
}

export async function confirmMasterKeyBackup(db: Db, actorUserId: string): Promise<void> {
  await db.query(
    `update admin_checklist_state
     set master_key_backup_confirmed_at = now(), master_key_backup_confirmed_by = $1
     where id = true`,
    [actorUserId],
  );
  await appendEvent(db, {
    actorUserId, actor: 'super_admin', kind: 'checklist.master_key_backup_confirmed', payload: {},
  });
}

export class ChecklistError extends Error {}

export async function dismissChecklistItem(db: Db, item: string, actorUserId: string): Promise<void> {
  const spec = CHECKLIST_ITEMS.find((i) => i.key === item);
  if (!spec) throw new ChecklistError('there is no checklist item by that name');
  if (!isDismissible(spec.severity)) {
    throw new ChecklistError(
      'this one cannot be put aside — it is the kind of thing that cannot be recovered from later',
    );
  }
  await db.query(
    `insert into admin_checklist_dismissals (item, dismissed_by) values ($1, $2)
     on conflict (item) do update set dismissed_at = now(), dismissed_by = excluded.dismissed_by`,
    [item, actorUserId],
  );
  await appendEvent(db, {
    actorUserId, actor: 'super_admin', kind: 'checklist.dismissed', payload: { item },
  });
}

export async function restoreChecklistItem(db: Db, item: string, actorUserId: string): Promise<void> {
  await db.query(`delete from admin_checklist_dismissals where item = $1`, [item]);
  await appendEvent(db, {
    actorUserId, actor: 'super_admin', kind: 'checklist.restored', payload: { item },
  });
}
