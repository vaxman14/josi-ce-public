// The administrator's launch checklist.
//
// Every fact here is read from what the installation actually contains. There
// is no "mark as done" for anything Josi can observe: the only writes this
// router accepts are the master-key backup confirmation, which Josi cannot
// observe because the file leaves the server, and a dismissal of optional work.
//
// Super-admin only, and it is mounted under `/admin`, so the existing guard
// covers it. Nothing here returns content — it returns counts and states.
import { Router } from 'express';
import {
  CHECKLIST_ITEMS, ChecklistError, buildChecklist, confirmMasterKeyBackup,
  dismissChecklistItem, getVerifications, markChecklistSeen, restoreChecklistItem,
  type ChecklistFacts, type Db,
} from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { publicHttpsBase } from '../setup/setupRoutes.js';

export function checklistRoutes(db: Db): Router {
  const r = Router();

  async function facts(): Promise<ChecklistFacts> {
    const [state] = await db.query<{ seen_at: string | null; master_key_backup_confirmed_at: string | null }>(
      `select seen_at, master_key_backup_confirmed_at from admin_checklist_state where id = true`,
    );
    const [vault] = await db.query<{ recovery_confirmed_at: string | null }>(
      `select recovery_confirmed_at from vault_state where id = true`,
    );
    const [backups] = await db.query<{ n: string }>(`select count(*)::text as n from backups`);
    const [restores] = await db.query<{ n: string }>(
      `select count(*)::text as n from restore_attempts where state = 'complete'`,
    );
    const [users] = await db.query<{ n: string }>(`select count(*)::text as n from users`);
    const [policy] = await db.query<{ n: string }>(
      `select count(*)::text as n from events where kind in ('approval.ceiling_set', 'approval.ceiling_relaxed')`,
    );
    const [pending] = await db.query<{ n: string }>(
      `select count(*)::text as n from approval_policy_migration where acknowledged_at is null`,
    );
    const [clients] = await db.query<{ n: string }>(`select count(*)::text as n from oauth_clients`);
    const [updates] = await db.query<{ last_check_at: string | null }>(
      `select last_check_at from update_state where id = true`,
    );
    const [diagnostics] = await db.query<{ n: string }>(`select count(*)::text as n from diagnostic_bundles`);
    const [security] = await db.query<{ n: string }>(
      `select count(*)::text as n from events where kind = 'security.policy_reviewed'`,
    );
    const dismissals = await db.query<{ item: string }>(`select item from admin_checklist_dismissals`);

    const verifications = new Map(
      [...(await getVerifications(db)).entries()].map(([key, v]) => [
        key, { status: v.status, detail: v.detail },
      ]),
    );

    return {
      masterKeyBackupConfirmed: !!state?.master_key_backup_confirmed_at || !!vault?.recovery_confirmed_at,
      backupCount: Number(backups?.n ?? 0),
      restoreVerified: Number(restores?.n ?? 0) > 0,
      verifications,
      userCount: Number(users?.n ?? 0),
      approvalPolicySet: Number(policy?.n ?? 0) > 0,
      unacknowledgedPolicyChanges: Number(pending?.n ?? 0),
      connectorsConfigured: Number(clients?.n ?? 0),
      connectorsUnavailableReason: (await publicHttpsBase(db))
        ? null
        : 'Google and Microsoft need a public HTTPS address. This installation is reachable only on your network.',
      securityReviewed: Number(security?.n ?? 0) > 0,
      updateChannelKnown: !!updates?.last_check_at,
      diagnosticsSeen: Number(diagnostics?.n ?? 0) > 0,
      dismissed: new Set(dismissals.map((d) => d.item)),
    };
  }

  async function seen(): Promise<boolean> {
    const [row] = await db.query<{ seen_at: string | null }>(
      `select seen_at from admin_checklist_state where id = true`,
    );
    return !!row?.seen_at;
  }

  r.get(
    '/launch-checklist',
    asyncRoute(async (_req, res) => res.json(buildChecklist(await facts(), await seen()))),
  );

  /** Recorded when the administrator has actually looked.
   *
   * This is what stops sign-in redirecting them here forever, so it is a
   * deliberate POST rather than a side effect of the GET — a preflight, a link
   * preview or a monitoring probe must not be able to mark it seen. */
  r.post(
    '/launch-checklist/seen',
    asyncRoute(async (req, res) => {
      await markChecklistSeen(db, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  r.post(
    '/launch-checklist/master-key-backed-up',
    asyncRoute(async (req, res) => {
      await confirmMasterKeyBackup(db, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  r.post(
    '/launch-checklist/dismiss/:item',
    asyncRoute(async (req, res) => {
      try {
        await dismissChecklistItem(db, param(req, 'item'), req.user!.id);
        return res.json({ ok: true });
      } catch (err) {
        if (err instanceof ChecklistError) return res.status(409).json({ error: err.message });
        throw err;
      }
    }),
  );

  r.post(
    '/launch-checklist/restore/:item',
    asyncRoute(async (req, res) => {
      const item = param(req, 'item');
      if (!CHECKLIST_ITEMS.some((i) => i.key === item)) {
        return res.status(404).json({ error: 'there is no checklist item by that name' });
      }
      await restoreChecklistItem(db, item, req.user!.id);
      return res.json({ ok: true });
    }),
  );

  return r;
}
