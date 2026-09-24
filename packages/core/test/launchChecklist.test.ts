// LB7 — what the administrator still has to do.
//
// Setup finishing and an installation being ready to use are different things,
// and the gap was invisible: the person who ran setup landed on the ordinary
// user dashboard, identical to what every member sees, with nobody invited, no
// backup taken, the master key never copied off the server, and two setup steps
// skipped.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  CHECKLIST_ITEMS, ChecklistError, buildChecklist, confirmMasterKeyBackup,
  dismissChecklistItem, isDismissible, markChecklistSeen, restoreChecklistItem,
  type ChecklistFacts,
} from '../src/index.js';

/** A brand-new installation: setup finished, nothing else done. */
const fresh = (over: Partial<ChecklistFacts> = {}): ChecklistFacts => ({
  masterKeyBackupConfirmed: false,
  backupCount: 0,
  restoreVerified: false,
  verifications: new Map(),
  userCount: 1,
  approvalPolicySet: false,
  unacknowledgedPolicyChanges: 0,
  connectorsConfigured: 0,
  connectorsUnavailableReason: null,
  securityReviewed: false,
  updateChannelKnown: false,
  diagnosticsSeen: false,
  dismissed: new Set(),
  ...over,
});

const find = (list: ReturnType<typeof buildChecklist>, key: string) =>
  list.items.find((i) => i.key === key)!;

describe('LB7.3 — the checklist covers what an administrator has to decide', () => {
  const required = [
    'model', 'connectors', 'smtp', 'users', 'approval_policy',
    'backup_taken', 'master_key_backup', 'security_review', 'diagnostics', 'updates',
  ];

  for (const key of required) {
    it(`includes ${key}`, () => {
      expect(CHECKLIST_ITEMS.map((i) => i.key)).toContain(key);
    });
  }

  it('says what goes wrong for every one of them', () => {
    for (const item of CHECKLIST_ITEMS) {
      // A checklist that lists tasks without consequences is a chore list.
      expect(item.why.length, item.key).toBeGreaterThan(40);
    }
  });

  it('sends nobody to a screen that does not exist', () => {
    // The first version of this file pointed backups, updates and diagnostics
    // at `/admin/operations`, which is not a route. Pressing "Do this" fell
    // through the router's catch-all and silently returned the administrator
    // to the USER dashboard — the exact place LB7 exists to stop them landing.
    //
    // Every href is now checked against the routes the app actually declares.
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/src/App.tsx'),
      'utf8',
    );
    const adminBlock = app.slice(app.indexOf('path="/admin"'));
    const routes = new Set(
      [...adminBlock.matchAll(/path="([a-z-]+)"/g)].map((m) => `/admin/${m[1]}`),
    );
    routes.add('/admin');

    for (const item of CHECKLIST_ITEMS) {
      if (item.href === null) continue;
      expect(routes.has(item.href), `${item.key} links to ${item.href}, which is not a route`).toBe(true);
    }
  });

  it('says where the work happens when there is no screen for it', () => {
    // Null is allowed, silence is not. An item with no screen has to say where
    // the operator actually does it.
    for (const item of CHECKLIST_ITEMS) {
      if (item.href !== null) continue;
      expect(item.insteadOfScreen, `${item.key} has no screen and does not say where to go`).toBeTruthy();
      expect(item.insteadOfScreen!.length, item.key).toBeGreaterThan(40);
    }
  });

  it('is honest about a brand-new installation', () => {
    const list = buildChecklist(fresh(), false);
    expect(list.complete).toBe(false);
    expect(find(list, 'users').state).toBe('outstanding');
    expect(find(list, 'users').detail).toMatch(/only your own account/i);
    expect(find(list, 'master_key_backup').state).toBe('outstanding');
    expect(find(list, 'backup_taken').state).toBe('done');
    expect(find(list, 'backup_taken').detail).toMatch(/optional/i);
  });
});

describe('LB7.3 — every item is derived, not asserted', () => {
  it('marks the model done only when its verification passed', () => {
    const passed = new Map([['llm', { status: 'passed' as const, detail: 'gpt-4.1 answered.' }]]);
    expect(find(buildChecklist(fresh({ verifications: passed }), false), 'model').state).toBe('done');

    const failed = new Map([['llm', { status: 'failed' as const, detail: 'The key was rejected.' }]]);
    const list = buildChecklist(fresh({ verifications: failed }), false);
    expect(find(list, 'model').state).toBe('failed');
    expect(find(list, 'model').detail).toBe('The key was rejected.');
  });

  it('carries a skipped setup step through as outstanding work', () => {
    // LB7.3: "every skipped or failed setup item". A skip is a decision at the
    // time and a thing still not done afterwards, and the checklist is where
    // the second half lives.
    const skipped = new Map([['smtp', { status: 'skipped' as const, detail: null }]]);
    const list = buildChecklist(fresh({ verifications: skipped }), false);
    expect(find(list, 'smtp').state).toBe('outstanding');
    expect(find(list, 'smtp').detail).toMatch(/skipped/i);
  });

  it('reports backup and restore state neutrally because backups are optional', () => {
    const taken = buildChecklist(fresh({ backupCount: 3 }), false);
    expect(find(taken, 'backup_taken').state).toBe('done');
    expect(find(taken, 'backup_taken').detail).toMatch(/optional/i);

    const proven = buildChecklist(fresh({ backupCount: 3, restoreVerified: true }), false);
    expect(find(proven, 'backup_taken').state).toBe('done');
  });

  it('reports connectors as unavailable rather than outstanding on a LAN-only host', () => {
    const list = buildChecklist(fresh({ connectorsUnavailableReason: 'No public address.' }), false);
    // Outstanding would mean work the operator can do, and they cannot.
    expect(find(list, 'connectors').state).toBe('unavailable');
    expect(find(list, 'connectors').detail).toBe('No public address.');
  });

  it('surfaces an unacknowledged policy migration as work', () => {
    const list = buildChecklist(fresh({ unacknowledgedPolicyChanges: 4 }), false);
    expect(find(list, 'approval_policy').state).toBe('outstanding');
    expect(find(list, 'approval_policy').detail).toMatch(/4 action/);
  });
});

describe('LB7.4 — optional work can be put aside; material risk cannot', () => {
  it('refuses to make a critical item dismissible', () => {
    for (const item of CHECKLIST_ITEMS) {
      expect(isDismissible(item.severity), item.key).toBe(item.severity !== 'critical');
    }
    // The master key can lose data permanently; backups remain optional.
    expect(isDismissible('critical')).toBe(false);
    expect(CHECKLIST_ITEMS.find((i) => i.key === 'master_key_backup')!.severity).toBe('critical');
    expect(CHECKLIST_ITEMS.find((i) => i.key === 'backup_taken')!.severity).toBe('optional');
  });

  it('honours a dismissal of optional work', () => {
    const list = buildChecklist(fresh({ dismissed: new Set(['connectors']) }), false);
    expect(find(list, 'connectors').state).toBe('dismissed');
    expect(list.progress.done).toBeGreaterThan(0);
  });

  it('ignores a dismissal of something that is failing', () => {
    // Putting aside "I have not done this" is a decision. Putting aside "this
    // is broken" is hiding, and a dismissal must not be able to do it.
    const failed = new Map([['connector_google', { status: 'failed' as const, detail: 'Rejected.' }]]);
    const list = buildChecklist(
      fresh({ verifications: failed, dismissed: new Set(['connectors']) }),
      false,
    );
    expect(find(list, 'connectors').state).toBe('failed');
  });

  it('keeps reminding about anything critical and outstanding', () => {
    const list = buildChecklist(fresh(), false);
    const keys = list.reminders.map((r) => r.key);
    expect(keys).toContain('master_key_backup');
    expect(keys).not.toContain('backup_taken');
    expect(keys).toContain('model');
    // Optional work never nags.
    expect(keys).not.toContain('connectors');
    expect(keys).not.toContain('diagnostics');
  });

  it('counts dismissed and unavailable items as settled, but not as done work', () => {
    const list = buildChecklist(
      fresh({ dismissed: new Set(['connectors', 'diagnostics']), connectorsUnavailableReason: null }),
      false,
    );
    expect(list.progress.total).toBe(CHECKLIST_ITEMS.length);
    expect(list.progress.done).toBe(3);
    // Settled is not finished: the critical items are still outstanding.
    expect(list.complete).toBe(false);
  });

  it('is complete only when nothing is outstanding or failing', () => {
    const everything = buildChecklist(fresh({
      masterKeyBackupConfirmed: true,
      backupCount: 1,
      restoreVerified: true,
      verifications: new Map([
        ['llm', { status: 'passed', detail: null }],
        ['smtp', { status: 'passed', detail: null }],
      ]),
      userCount: 4,
      approvalPolicySet: true,
      connectorsConfigured: 1,
      securityReviewed: true,
      updateChannelKnown: true,
      diagnosticsSeen: true,
    }), true);
    expect(everything.complete).toBe(true);
  });
});

describe('LB7.2 / LB7.5 — seen once, then out of the way', () => {
  let db: TestDb;
  let admin: string;

  beforeEach(async () => {
    db = await testDb();
    admin = (await createUser(db, { email: 'a@ce.test', username: 'admin', role: 'super_admin' })).id;
  });

  it('starts unseen, so the first sign-in can be routed here', async () => {
    const [row] = await db.query<{ seen_at: string | null }>(
      `select seen_at from admin_checklist_state where id = true`,
    );
    expect(row.seen_at).toBeNull();
  });

  it('records being seen exactly once', async () => {
    await markChecklistSeen(db, admin);
    const [first] = await db.query<{ seen_at: string }>(
      `select seen_at from admin_checklist_state where id = true`,
    );
    expect(first.seen_at).toBeTruthy();

    await markChecklistSeen(db, admin);
    const events = await db.query(`select id from events where kind = 'checklist.seen'`);
    expect(events, 'seeing it twice is not two events').toHaveLength(1);
  });
});

describe('LB7 — the writes it accepts, and the ones it does not', () => {
  let db: TestDb;
  let admin: string;

  beforeEach(async () => {
    db = await testDb();
    admin = (await createUser(db, { email: 'a@ce.test', username: 'admin', role: 'super_admin' })).id;
  });

  it('records the master-key backup as a confirmation, with who made it', async () => {
    await confirmMasterKeyBackup(db, admin);
    const [row] = await db.query<{ confirmed_by: string; at: string }>(
      `select master_key_backup_confirmed_by as confirmed_by,
              master_key_backup_confirmed_at as at
       from admin_checklist_state where id = true`,
    );
    expect(row.at).toBeTruthy();
    expect(row.confirmed_by).toBe(admin);
    const [event] = await db.query(`select id from events where kind = 'checklist.master_key_backup_confirmed'`);
    expect(event).toBeTruthy();
  });

  it('refuses to dismiss anything critical, over the whole catalogue', async () => {
    for (const item of CHECKLIST_ITEMS.filter((i) => i.severity === 'critical')) {
      await expect(
        dismissChecklistItem(db, item.key, admin),
        item.key,
      ).rejects.toBeInstanceOf(ChecklistError);
    }
    expect(await db.query(`select item from admin_checklist_dismissals`)).toHaveLength(0);
  });

  it('refuses an item that does not exist', async () => {
    await expect(dismissChecklistItem(db, 'not_a_thing', admin)).rejects.toBeInstanceOf(ChecklistError);
  });

  it('records a dismissal with who and when, and lets it be undone', async () => {
    await dismissChecklistItem(db, 'connectors', admin);
    const [row] = await db.query<{ dismissed_by: string }>(
      `select dismissed_by from admin_checklist_dismissals where item = 'connectors'`,
    );
    expect(row.dismissed_by).toBe(admin);

    await restoreChecklistItem(db, 'connectors', admin);
    expect(await db.query(`select item from admin_checklist_dismissals`)).toHaveLength(0);

    const kinds = await db.query<{ kind: string }>(
      `select kind from events where kind in ('checklist.dismissed', 'checklist.restored') order by kind`,
    );
    expect(kinds.map((k) => k.kind)).toEqual(['checklist.dismissed', 'checklist.restored']);
  });
});
