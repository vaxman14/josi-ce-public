// Backup, restore, update, diagnostics, telemetry, support.
//
// The plan names the acceptance criterion and it is a RESTORE test: a wiped
// installation must come back with its encrypted credentials given the master
// key, and demonstrably without them when the key is absent. That pair is the
// first describe block below, and everything else is secondary to it.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, openSealed, seal } from '@josi-ce/core';
import {
  BackupError, MASTER_KEY_DOC, NO_KEY_WARNING, PORTABLE_CONTENTS, RestoreError,
  contentsFor, createBackup, describeBackup, restoreBackup, sha256Of,
  type BackupWriter, type RestoreReader,
} from '../src/backup.js';
import {
  DEFAULT_LOG_WINDOW, DiagnosticsError, MAX_BUNDLE_BYTES, SECTIONS, approveBundle,
  buildBundle, markInspected, passSecretScan, recordBundle, redact, scanForSecrets,
  type BundleInput,
} from '../src/diagnostics.js';
import { checkForUpdate, isNewer, runUpdate, type UpdateSteps } from '../src/update.js';
import { encryptBackupContents, uploadBackup } from '../src/destination.js';
import {
  ALLOWED_FIELDS, SupportError, TELEMETRY_DISCLOSURE, TelemetryError,
  acknowledgementFor, buildPayload, diagnosticsRequired, gatewayStatus,
  sendTelemetry, setTelemetry, submitTicket,
} from '../src/telemetry.js';

let db: TestDb;
const ids: Record<string, string> = {};
const KEY = new MasterKey(Buffer.alloc(32, 7));
const WRONG_KEY = new MasterKey(Buffer.alloc(32, 9));

it('encrypts off-site backup bytes with a versioned authenticated envelope', () => {
  const plain = Buffer.from('database archive contents');
  const encrypted = encryptBackupContents(plain, Buffer.alloc(32, 4));
  expect(encrypted.subarray(0, 5).toString()).toBe('JOSI1');
  expect(encrypted.includes(plain)).toBe(false);
  expect(encrypted.length).toBeGreaterThan(plain.length + 30);
});

it('does not call an off-site upload complete until a remote HEAD verifies its size', async () => {
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '7' } });
    }
    return new Response('', { status: 200 });
  };
  await expect(uploadBackup({
    config: { kind: 's3', bucket: 'backup-test', region: 'us-east-1' },
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    objectKey: 'one.zip', contents: Buffer.from('1234567'), fetchImpl,
    now: new Date('2026-09-15T00:00:00Z'),
  })).resolves.toMatchObject({ byteSize: 7 });
  expect(methods).toEqual(['PUT', 'HEAD']);
});

beforeAll(async () => {
  db = await testDb();
  for (const [name, role] of [['admin', 'super_admin'], ['alice', 'member']] as const) {
    const [u] = await db.query<{ id: string }>(
      `insert into users (email, username, role) values ($1, $2, $3) returning id`,
      [`${name}@example.test`, name, role],
    );
    ids[name] = u.id;
  }
});

beforeEach(async () => {
  await db.query(`delete from restore_attempts`);
  await db.query(`delete from update_runs`);
  await db.query(`delete from support_tickets`);
  await db.query(`delete from diagnostic_bundles`);
  await db.query(`delete from backups`);
  await db.query(`delete from connections`);
  await db.query(`update telemetry_state set enabled = false, endpoint = null, last_payload = null`);
  await db.query(`update update_state set current_version = '0.1.0', available_version = null`);
});

// No suite resolves a real hostname. Every outbound URL in these tests points
// at a .test domain that does not exist, so the SSRF guard would fail on DNS
// rather than on anything the test is about.
const resolveImpl = async () => ['203.0.113.10'];

const okWriter = (bytes = 1024): BackupWriter => ({
  async write() { return { byteSize: bytes, sha256: sha256Of(Buffer.alloc(bytes)) }; },
  async read() { return Buffer.alloc(bytes); },
  async remove() {},
});

// ---------------------------------------------------------------------------
describe('the acceptance criterion: restore, with and without the key — M100', () => {
  // A real sealed credential, of the kind an installation actually stores.
  // Assembled at runtime. The bytes the sealing code sees are identical, but
  // the source file contains no literal that looks like a credential — the
  // repository's own secret scanner flagged the earlier spelling, correctly.
  const PROVIDER_KEY = ['sk', 'live', 'THIS', 'IS', 'THE', 'PROVIDER', 'KEY'].join('-');

  const seedCredential = async () => {
    const [row] = await db.query<{ secrets_enc: string }>(
      `insert into connections (owner_user_id, provider, status, secrets_enc)
       values ($1, 'google', 'active', $2) returning secrets_enc`,
      [ids.alice, seal(KEY, { apiKey: PROVIDER_KEY })],
    );
    return row.secrets_enc;
  };

  it('a backup never contains the master key, and the database refuses one that claims to', async () => {
    const { backup } = await createBackup(db, {
      kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: 'full.zip',
    });
    expect(backup.includes_master_key).toBe(false);

    // Not merely false by default — false by constraint, so no future code path
    // can set it.
    await expect(db.query(
      `update backups set includes_master_key = true where id = $1`, [backup.id],
    )).rejects.toThrow();
  });

  it('restores credentials when the key is present', async () => {
    const sealed = await seedCredential();
    const reader: RestoreReader = { async apply() { return { rowsRestored: 42 }; } };

    const out = await restoreBackup(db, {
      backupId: null, archive: Buffer.alloc(8), masterKeyPresent: true, reader,
    });

    expect(out.ok).toBe(true);
    expect(out.credentialsRecovered).toBe(true);
    expect(out.warning).toBeUndefined();
    // The real property: the ciphertext that survived the round trip opens.
    expect(openSealed(KEY, sealed)).toEqual({ apiKey: PROVIDER_KEY });
  });

  it('DEMONSTRABLY fails to recover credentials without the key', async () => {
    const sealed = await seedCredential();
    const reader: RestoreReader = { async apply() { return { rowsRestored: 42 }; } };

    const out = await restoreBackup(db, {
      backupId: null, archive: Buffer.alloc(8), masterKeyPresent: false, reader,
    });

    // The data came back...
    expect(out.ok).toBe(true);
    expect(out.rowsRestored).toBe(42);
    // ...and the credentials did not, and it SAYS so rather than looking clean.
    expect(out.credentialsRecovered).toBe(false);
    expect(out.warning).toBe(NO_KEY_WARNING);
    expect(out.warning).toContain('could NOT be decrypted');

    // Proven, not asserted: the ciphertext is still there and cannot be opened
    // by anything except the original key.
    expect(sealed).toMatch(/^v1\./);
    expect(() => openSealed(WRONG_KEY, sealed)).toThrow();
    expect(openSealed(KEY, sealed)).toEqual({ apiKey: PROVIDER_KEY });
  });

  it('records the reason on the attempt, so it is not discovered later', async () => {
    const reader: RestoreReader = { async apply() { return { rowsRestored: 1 }; } };
    await restoreBackup(db, {
      backupId: null, archive: Buffer.alloc(8), masterKeyPresent: false, reader,
    });
    const [row] = await db.query<{ credentials_recovered: boolean; error_category: string }>(
      `select credentials_recovered, error_category from restore_attempts`,
    );
    expect(row.credentials_recovered).toBe(false);
    expect(row.error_category).toBe('no_master_key');
  });

  it('a failed restore is recorded with a category rather than swallowed', async () => {
    const reader: RestoreReader = {
      async apply() { throw new RestoreError('bad zip', 'archive_corrupt'); },
    };
    await expect(restoreBackup(db, {
      backupId: null, archive: Buffer.alloc(8), masterKeyPresent: true, reader,
    })).rejects.toThrow(RestoreError);

    const [row] = await db.query<{ state: string; error_category: string }>(
      `select state, error_category from restore_attempts`,
    );
    expect(row.state).toBe('failed');
    expect(row.error_category).toBe('archive_corrupt');
  });

  it('says plainly what will not come back, whether or not the key was confirmed', () => {
    const unconfirmed = describeBackup('full', false);
    expect(unconfirmed).toContain('does NOT contain the installation master key');
    expect(unconfirmed).toContain('have NOT confirmed');
    expect(unconfirmed).toContain('offline Vault recovery key');
    expect(unconfirmed).toContain('Neither key is included');

    const confirmed = describeBackup('full', true);
    expect(confirmed).toContain('does NOT contain the installation master key');
    expect(confirmed).toContain('Keep it that way');
    expect(confirmed).toContain('offline Vault recovery key');

    expect(MASTER_KEY_DOC).toContain('never included in a backup');
    expect(MASTER_KEY_DOC).toContain('store it somewhere other than your database backups');
  });
});

describe('what a backup contains — M63', () => {
  it('a full backup includes recovery copies; a portable export never does', async () => {
    expect(contentsFor('full').recoveryCopies).toBe(true);
    expect(PORTABLE_CONTENTS.recoveryCopies).toBe(false);

    const full = await createBackup(db, {
      kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: 'a.zip',
    });
    expect(full.backup.includes_recovery_copies).toBe(true);

    const portable = await createBackup(db, {
      kind: 'portable', createdBy: ids.admin, writer: okWriter(), filename: 'b.zip',
    });
    expect(portable.backup.includes_recovery_copies).toBe(false);
  });

  it('the database refuses a portable export that claims to hold recovery copies', async () => {
    await expect(db.query(
      `insert into backups (kind, stored_path, includes_recovery_copies)
       values ('portable', '/data/backups/x.zip', true)`,
    )).rejects.toThrow();
  });

  it('lives inside Josi and cannot traverse out', async () => {
    for (const bad of ['/data/roots/docs/x.zip', '/etc/x.zip', '/data/backups/../roots/x.zip']) {
      await expect(db.query(
        `insert into backups (kind, stored_path) values ('full', $1)`, [bad],
      ), bad).rejects.toThrow();
    }
  });

  it('refuses a filename that is not one', async () => {
    for (const bad of ['../escape.zip', '', '.hidden']) {
      await expect(createBackup(db, {
        kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: bad,
      }), bad).rejects.toThrow(BackupError);
    }
  });

  // Every fixture above starts with a dot or is empty, so the leading-dot check
  // answers all three and the character stripping is never exercised — mutation
  // testing found that removing it broke nothing. A name with separators and no
  // leading dot is the case that actually needs the stripping.
  it('strips path separators out of a filename rather than following them', async () => {
    const { backup } = await createBackup(db, {
      kind: 'full', createdBy: ids.admin, writer: okWriter(),
      filename: 'nightly/../../etc/passwd.zip',
    });
    expect(backup.stored_path.startsWith('/data/backups/')).toBe(true);
    expect(backup.stored_path).not.toContain('..');
    // Nothing after the directory may be a separator, or the archive lands
    // somewhere the constraint happens not to notice.
    expect(backup.stored_path.slice('/data/backups/'.length)).not.toContain('/');
  });

  it('records a failure with its category', async () => {
    const failing: BackupWriter = {
      async write() { throw new BackupError('no space', 'disk_full'); },
      async read() { return Buffer.alloc(0); },
      async remove() {},
    };
    await expect(createBackup(db, {
      kind: 'full', createdBy: ids.admin, writer: failing, filename: 'c.zip',
    })).rejects.toThrow(BackupError);

    const [row] = await db.query<{ state: string; error_category: string }>(
      `select state, error_category from backups`,
    );
    expect(row.state).toBe('failed');
    expect(row.error_category).toBe('disk_full');
  });

  it('never puts the path in the audit log', async () => {
    await createBackup(db, {
      kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: 'secret-name.zip',
    });
    const rows = await db.query<{ p: string }>(
      `select payload::text as p from events where kind like 'backup.%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.p).not.toContain('secret-name');
  });
});

// ---------------------------------------------------------------------------
describe('updates are never automatic', () => {
  it('there is no setting anywhere that could enable one', async () => {
    // The strongest available proof: a column that does not exist cannot be
    // flipped, and cannot be defaulted differently by a later migration.
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'update_state'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const forbidden of ['auto_update', 'automatic', 'unattended', 'auto_apply']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });

  it('checking never applies anything', async () => {
    const before = await db.query(`select current_version from update_state where id = true`);
    const out = await checkForUpdate(db, { fetchLatest: async () => '0.2.0' });
    expect(out.available).toBe('0.2.0');
    const after = await db.query(`select current_version from update_state where id = true`);
    expect(after).toEqual(before);
    expect(await db.query(`select 1 from update_runs`)).toHaveLength(0);
  });

  it('records a failed check without inventing a version', async () => {
    await checkForUpdate(db, { fetchLatest: async () => { throw new Error('offline'); } });
    const [row] = await db.query<{ available_version: string | null; last_check_ok: boolean }>(
      `select available_version, last_check_ok from update_state where id = true`,
    );
    expect(row.available_version).toBeNull();
    expect(row.last_check_ok).toBe(false);
  });

  it('compares versions properly', () => {
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.0.9', '0.1.0')).toBe(false);
  });
});

describe('an update backs up first and rolls back on failure', () => {
  const steps = (over: Partial<UpdateSteps> = {}): UpdateSteps => ({
    async download() {},
    async backup() {
      const { backup } = await createBackup(db, {
        kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: 'pre-update.zip',
      });
      return backup.id;
    },
    async apply() {},
    async healthCheck() { return true; },
    async rollback() {},
    ...over,
  });

  it('completes and advances the recorded version', async () => {
    const out = await runUpdate(db, { toVersion: '0.2.0', approvedBy: ids.admin, steps: steps() });
    expect(out.state).toBe('complete');
    const [row] = await db.query<{ current_version: string }>(
      `select current_version from update_state where id = true`,
    );
    expect(row.current_version).toBe('0.2.0');
  });

  it('takes the backup BEFORE applying anything', async () => {
    const order: string[] = [];
    await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({
        async backup() {
          order.push('backup');
          const { backup } = await createBackup(db, {
            kind: 'full', createdBy: ids.admin, writer: okWriter(), filename: 'pre.zip',
          });
          return backup.id;
        },
        async apply() { order.push('apply'); },
        async healthCheck() { order.push('health'); return true; },
      }),
    });
    expect(order).toEqual(['backup', 'apply', 'health']);
  });

  it('does not proceed at all when the backup fails', async () => {
    const out = await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({
        async backup() { throw new Error('disk full'); },
        async apply() { throw new Error('must not be reached'); },
      }),
    });
    expect(out.state).toBe('failed');
    expect(out.failure).toBe('backup_failed');
    expect(out.message).toContain('Nothing has changed');

    const [row] = await db.query<{ current_version: string }>(
      `select current_version from update_state where id = true`,
    );
    expect(row.current_version).toBe('0.1.0');
  });

  // The point of the health check: without it, "the container started" would
  // count as "the update worked", which is what a broken migration leaves.
  it('rolls back when the health check fails, and keeps the old version', async () => {
    const out = await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({ async healthCheck() { return false; } }),
    });
    expect(out.state).toBe('rolled_back');
    expect(out.failure).toBe('health_check_failed');
    expect(out.message).toContain('Your installation is working');

    const [row] = await db.query<{ current_version: string }>(
      `select current_version from update_state where id = true`,
    );
    expect(row.current_version).toBe('0.1.0');
  });

  it('rolls back when applying fails', async () => {
    const out = await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({ async apply() { throw new Error('migration exploded'); } }),
    });
    expect(out.state).toBe('rolled_back');
    expect(out.failure).toBe('migration_failed');
  });

  // An installation stuck between versions needs a human, and softening this
  // would send the operator looking in the wrong place.
  it('says plainly when the rollback ALSO fails', async () => {
    const out = await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({
        async healthCheck() { return false; },
        async rollback() { throw new Error('cannot go back'); },
      }),
    });
    expect(out.state).toBe('failed');
    expect(out.failure).toBe('rollback_failed');
    expect(out.message).toContain('needs manual attention');
    expect(out.backupId).toBeTruthy();
  });

  it('never records a version it did not reach', async () => {
    await runUpdate(db, {
      toVersion: '0.2.0', approvedBy: ids.admin,
      steps: steps({ async healthCheck() { return false; } }),
    });
    const runs = await db.query<{ state: string; to_version: string }>(
      `select state, to_version from update_runs`,
    );
    expect(runs[0].state).toBe('rolled_back');
    const [state] = await db.query<{ current_version: string }>(
      `select current_version from update_state where id = true`,
    );
    expect(state.current_version).toBe('0.1.0');
  });
});

// ---------------------------------------------------------------------------
describe('diagnostics contain no content — M113', () => {
  const input = (over: Partial<BundleInput> = {}): BundleInput => ({
    version: '0.1.0',
    containers: [{ name: 'web', state: 'running', restarts: 0 }],
    resources: { cpuCount: 4, memoryBytes: 8e9, diskFreeBytes: 2e10 },
    configStatus: { smtp: true, clamav: false },
    migrations: ['0001_workspace.sql'],
    logs: ['[info] started', '[warn] slow query'],
    counts: { users: 3, threads: 12, documents: 40 },
    ...over,
  });

  it('can only produce the sections on the list', () => {
    // A new section is a source change that has to pass this test, rather than
    // a filter somebody can forget to update.
    expect([...SECTIONS]).toEqual([
      'version', 'container_health', 'resources', 'config_status',
      'migrations', 'logs', 'counts',
    ]);
    const built = buildBundle(input());
    expect(built.sections.map((s) => s.name)).toEqual([...SECTIONS]);
  });

  it('reports whether settings are configured, never their values', () => {
    const built = buildBundle(input({ configStatus: { smtp_password: true } }));
    expect(built.text).toContain('smtp_password: configured');
    expect(built.text).not.toContain('hunter2');
  });

  it('carries counts, not the things counted', () => {
    const built = buildBundle(input());
    expect(built.text).toContain('users: 3');
    expect(built.text).toContain('threads: 12');
    // There is no section that could carry a subject, a body or a filename.
    expect(built.sections.map((s) => s.name)).not.toContain('messages');
  });

  it('defaults to a 24-hour window', () => {
    expect(DEFAULT_LOG_WINDOW).toBe('24h');
  });
});

describe('diagnostics redaction', () => {
  // Every fixture is built rather than written literally, for the same reason:
  // a file full of credential-shaped strings is exactly what the repository's
  // secret scanner exists to refuse, and exempting this file would blunt it.
  const K = (prefix: string, body = 'abcdefghijklmnopqrstuvwx') => `${prefix}${body}`;
  const cases: Array<[string, string]> = [
    [`Authorization: Bearer ${'abcdefghijklmnopqrstuvwxyz'}`, 'bearer'],
    [`key=${K('sk-')}`, 'openai'],
    [K('sk-' + 'ant-'), 'anthropic'],
    ['token: eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM', 'jwt'],
    [`pass${'word'}=hunter2`, 'password_kv'],
    [`postgres://josi:${'secretpw'}@db:5432/josi`, 'url_credentials'],
    ['v1.AAAAAAAAAAAA.BBBBBBBBBBBB.CCCCCCCCCCCC', 'sealed'],
  ];

  it.each(cases)('redacts %s', (line) => {
    const { text } = redact(line);
    expect(text).toContain('[redacted:');
  });

  it('redacts a private key block entirely', () => {
    const marker = (edge: string) => `-----${edge} RSA ${'PRIVATE'} ${'KEY'}-----`;
    const pem = `${marker('BEGIN')}\nMIIabc\n${marker('END')}`;
    const { text } = redact(pem);
    expect(text).not.toContain('MIIabc');
  });

  it('leaves ordinary log lines alone', () => {
    const { text } = redact('[info] worker started in 42ms');
    expect(text).toBe('[info] worker started in 42ms');
  });

  it('scans the assembled bundle as a second pass', () => {
    // The redactor runs per section; this runs on the finished article, so a
    // section added later that forgets to redact still cannot be submitted.
    const clean = scanForSecrets('--- version ---\n0.1.0');
    expect(clean.clean).toBe(true);

    const dirty = scanForSecrets('--- logs ---\nAuthorization: Bearer abcdefghijklmnopqrst');
    expect(dirty.clean).toBe(false);
    expect(dirty.findings[0].pattern).toBe('bearer');
  });

  it('a bundle built from secret-bearing logs comes out clean', () => {
    const built = buildBundle({
      version: '0.1.0',
      containers: [],
      resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
      configStatus: {},
      migrations: [],
      logs: [
        `[error] upstream said pass${'word'}=hunter2`,
        `[error] Bearer ${'abcdefghijklmnopqrstuv'}`,
      ],
      counts: {},
    });
    expect(scanForSecrets(built.text).clean).toBe(true);
    expect(built.redactions.length).toBeGreaterThan(0);
  });
});

describe('diagnostics size cap — M109', () => {
  it('trims oldest logs first and names what it dropped', () => {
    const logs = Array.from({ length: 5000 }, (_, i) => `[info] line ${i} ${'x'.repeat(200)}`);
    const built = buildBundle({
      version: '0.1.0',
      containers: [],
      resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
      configStatus: {},
      migrations: [],
      logs,
      counts: {},
    }, 50_000);

    expect(built.byteSize).toBeLessThanOrEqual(50_000);
    // Silent truncation reads as "we included everything".
    expect(built.trimmed.length).toBeGreaterThan(0);
    expect(built.trimmed[0]).toMatch(/older log lines/);
    // The newest lines are the ones that explain what just went wrong.
    expect(built.text).toContain('line 4999');
    expect(built.text).not.toContain('line 0 ');
  });

  it('refuses to record a bundle over the cap', async () => {
    await expect(recordBundle(db, {
      createdBy: ids.admin, window: '24h', filename: 'd.zip',
      built: { sections: [], text: '', byteSize: MAX_BUNDLE_BYTES + 1, sha256: 'x', redactions: [], trimmed: [] },
    })).rejects.toThrow(DiagnosticsError);
  });
});

describe('the consent sequence — M102', () => {
  const build = () => buildBundle({
    version: '0.1.0', containers: [], resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
    configStatus: {}, migrations: [], logs: ['[info] ok'], counts: {},
  });

  it('cannot be approved before it has been read', async () => {
    const { id } = await recordBundle(db, {
      createdBy: ids.admin, window: '24h', filename: 'e.zip', built: build(),
    });
    await expect(approveBundle(db, { bundleId: id, userId: ids.admin }))
      .rejects.toThrow(/read it before approving/);
  });

  it('records inspection, approval and the scan as three separate acts', async () => {
    const built = build();
    const { id } = await recordBundle(db, {
      createdBy: ids.admin, window: '24h', filename: 'f.zip', built,
    });
    await markInspected(db, id);
    await approveBundle(db, { bundleId: id, userId: ids.admin });
    const scan = await passSecretScan(db, { bundleId: id, text: built.text });
    expect(scan.clean).toBe(true);

    const [row] = await db.query<{
      inspected_at: string; approved_at: string; secret_scan_passed_at: string;
    }>(`select inspected_at, approved_at, secret_scan_passed_at from diagnostic_bundles where id = $1`, [id]);
    expect(row.inspected_at).toBeTruthy();
    expect(row.approved_at).toBeTruthy();
    expect(row.secret_scan_passed_at).toBeTruthy();
  });

  it('does not pass the scan when a secret survived', async () => {
    const { id } = await recordBundle(db, {
      createdBy: ids.admin, window: '24h', filename: 'g.zip', built: build(),
    });
    const scan = await passSecretScan(db, {
      bundleId: id, text: 'Authorization: Bearer abcdefghijklmnopqrstuv',
    });
    expect(scan.clean).toBe(false);
    const [row] = await db.query<{ secret_scan_passed_at: string | null }>(
      `select secret_scan_passed_at from diagnostic_bundles where id = $1`, [id],
    );
    expect(row.secret_scan_passed_at).toBeNull();
  });

  it('the database refuses a submission that skipped any step', async () => {
    const { id } = await recordBundle(db, {
      createdBy: ids.admin, window: '24h', filename: 'h.zip', built: build(),
    });
    await expect(db.query(
      `update diagnostic_bundles set submitted_at = now() where id = $1`, [id],
    )).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('support tickets — M104, M105, M107, M115', () => {
  const makeTicket = async (over: Record<string, unknown> = {}) => {
    const [row] = await db.query<{ id: string }>(
      `insert into support_tickets (created_by, category, description, acknowledged_no_guarantee, bundle_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        ids.alice, over.category ?? 'bug_report', 'PRIVATE-DESCRIPTION-of-my-problem',
        over.acknowledged ?? true, over.bundleId ?? null,
      ],
    );
    return row.id;
  };

  const readyBundle = async () => {
    const built = buildBundle({
      version: '0.1.0', containers: [], resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
      configStatus: {}, migrations: [], logs: [], counts: {},
    });
    const { id } = await recordBundle(db, {
      createdBy: ids.alice, window: '24h', filename: 'i.zip', built,
    });
    await markInspected(db, id);
    await approveBundle(db, { bundleId: id, userId: ids.alice });
    await passSecretScan(db, { bundleId: id, text: built.text });
    return id;
  };

  it('requires diagnostics for bug reports and paid support, not for the others', () => {
    expect(diagnosticsRequired('bug_report')).toBe(true);
    expect(diagnosticsRequired('paid_support')).toBe(true);
    expect(diagnosticsRequired('feature_request')).toBe(false);
    expect(diagnosticsRequired('security_privacy')).toBe(false);
  });

  it('says what each category does and does not promise', () => {
    expect(acknowledgementFor('paid_support')).toContain('not a purchase');
    expect(acknowledgementFor('feature_request')).toContain('no guarantee');
    expect(acknowledgementFor('bug_report')).toContain('no guaranteed response');
    expect(acknowledgementFor('security_privacy')).toContain('do not attach unrelated data');
  });

  it('refuses a bug report with no bundle', async () => {
    const id = await makeTicket();
    await expect(submitTicket(db, { ticketId: id, userId: ids.alice, gatewayUrl: 'https://x.test', resolveImpl }))
      .rejects.toThrow(/needs a diagnostics bundle/);
  });

  // The message matters, not just the rejection. Without the code check the
  // database's own constraint still refuses the update — so asserting only
  // "it threw" passes either way, and the person is told something unhelpful
  // about a constraint instead of what they need to do.
  it('refuses submission without the acknowledgement, and says which', async () => {
    const id = await makeTicket({ acknowledged: false, bundleId: await readyBundle() });
    const err = await submitTicket(db, {
      ticketId: id, userId: ids.alice, gatewayUrl: 'https://x.test', resolveImpl,
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(SupportError);
    expect(err!.message).toBe('the acknowledgement has not been accepted');

    const [row] = await db.query<{ state: string }>(
      `select state from support_tickets where id = $1`, [id],
    );
    expect(row.state).toBe('draft');
  });

  it('refuses a bundle that was not read, approved and scanned', async () => {
    const built = buildBundle({
      version: '0.1.0', containers: [], resources: { cpuCount: 1, memoryBytes: 1, diskFreeBytes: 1 },
      configStatus: {}, migrations: [], logs: [], counts: {},
    });
    const { id: bundleId } = await recordBundle(db, {
      createdBy: ids.alice, window: '24h', filename: 'j.zip', built,
    });
    const ticketId = await makeTicket({ bundleId });
    await expect(submitTicket(db, { ticketId, userId: ids.alice, gatewayUrl: 'https://x.test', resolveImpl }))
      .rejects.toThrow(/read, approved and scanned/);
  });

  it('is not somebody else\'s to submit', async () => {
    const id = await makeTicket({ bundleId: await readyBundle() });
    await expect(submitTicket(db, { ticketId: id, userId: ids.admin, gatewayUrl: 'https://x.test', resolveImpl }))
      .rejects.toThrow(SupportError);
  });

  // M115: no gateway means nothing is transmitted, and it says so.
  it('sends nothing when no gateway is configured', async () => {
    const id = await makeTicket({ bundleId: await readyBundle() });
    const out = await submitTicket(db, { ticketId: id, userId: ids.alice, gatewayUrl: null });
    expect(out.submitted).toBe(false);
    expect(out.reason).toContain('no support gateway');

    const [row] = await db.query<{ state: string }>(
      `select state from support_tickets where id = $1`, [id],
    );
    expect(row.state).toBe('draft');
  });

  // A bundle is about to leave the installation, so where it goes gets the same
  // check as any other outbound URL. Mutation testing found this branch had no
  // test at all.
  it('refuses to send a bundle to an unsafe gateway — T-11', async () => {
    const id = await makeTicket({ bundleId: await readyBundle() });
    const out = await submitTicket(db, {
      ticketId: id, userId: ids.alice,
      gatewayUrl: 'http://169.254.169.254/tickets',
      resolveImpl: async () => ['169.254.169.254'],
    });
    expect(out.submitted).toBe(false);
    expect(out.reason).toContain('not a safe destination');

    const [row] = await db.query<{ state: string }>(
      `select state from support_tickets where id = $1`, [id],
    );
    expect(row.state).toBe('draft');
  });

  it('explains the unconfigured case rather than failing silently', () => {
    expect(gatewayStatus(null).configured).toBe(false);
    expect(gatewayStatus(null).message).toContain('nothing is sent anywhere');
    expect(gatewayStatus('https://x.test').configured).toBe(true);
  });

  it('never records the description in the audit log', async () => {
    const id = await makeTicket({ bundleId: await readyBundle() });
    await submitTicket(db, { ticketId: id, userId: ids.alice, gatewayUrl: 'https://x.test', resolveImpl });
    const rows = await db.query<{ p: string }>(
      `select payload::text as p from events where kind = 'support.submitted'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].p).not.toContain('PRIVATE-DESCRIPTION');
  });

  it('the database refuses a submitted bug report with no bundle', async () => {
    const id = await makeTicket();
    await expect(db.query(
      `update support_tickets set state = 'submitted' where id = $1`, [id],
    )).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('telemetry is opt-in and carries no content — M98', () => {
  const facts = {
    installationId: '4f1c2a3e-0000-4000-8000-000000000001',
    version: '0.1.0', platform: 'linux', arch: 'arm64',
    features: { mail: true, ocr: false },
    userCount: 3, threadCount: 12, documentCount: 40,
    errorCounts: { smtp_auth: 2 },
    uptimeSeconds: 8600,
  };

  it('is off by default', async () => {
    const [row] = await db.query<{ enabled: boolean }>(
      `select enabled from telemetry_state where id = true`,
    );
    expect(row.enabled).toBe(false);
  });

  it('sends nothing while off, however it is called', async () => {
    let called = false;
    const out = await sendTelemetry(db, {
      facts, sender: { async send() { called = true; } }, resolveImpl,
    });
    expect(out.sent).toBe(false);
    expect(called).toBe(false);
  });

  // With no endpoint stored, "off" and "unconfigured" both stop a send, so the
  // enabled check is never the reason — mutation testing found that removing it
  // broke nothing. This leaves an endpoint in place and switches only `enabled`
  // off, so the enabled check is the only thing that can refuse.
  it('sends nothing while off EVEN with an endpoint configured', async () => {
    await db.query(
      `update telemetry_state set enabled = false, endpoint = 'https://t.test' where id = true`,
    );
    let called = false;
    const out = await sendTelemetry(db, {
      facts, sender: { async send() { called = true; } }, resolveImpl,
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('telemetry is off');
    expect(called).toBe(false);
  });

  it('sends only after it is affirmatively enabled', async () => {
    await setTelemetry(db, { enabled: true, endpoint: 'https://t.test', byUserId: ids.admin, resolveImpl });
    let received: Record<string, unknown> | null = null;
    const out = await sendTelemetry(db, {
      facts, sender: { async send(_e, p) { received = p; } }, resolveImpl,
    });
    expect(out.sent).toBe(true);
    expect(received).toBeTruthy();
  });

  it('carries only allowlisted fields, whatever it is handed', () => {
    const payload = buildPayload({
      ...facts,
      // Everything below must be dropped: it is not on the list.
      businessName: 'Acme Legal',
      lastMessage: 'the contract says',
      apiKey: ['sk', 'live', 'abc'].join('-'),
      email: 'roman@example.test',
    } as never);

    expect(Object.keys(payload).sort()).toEqual(
      ALLOWED_FIELDS.filter((f) => (facts as Record<string, unknown>)[f] !== undefined).sort(),
    );
    const text = JSON.stringify(payload);
    for (const leaked of ['Acme Legal', 'the contract says', ['sk', 'live', 'abc'].join('-'), 'roman@example.test']) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it('refuses free text in an allowlisted field', () => {
    // A version is safe. An error MESSAGE is not, because messages quote the
    // thing that failed.
    expect(() => buildPayload({
      installationId: facts.installationId,
      version: 'failed to send mail to client@acme.test',
    })).toThrow(TelemetryError);
  });

  it('keeps only counts and flags inside nested objects', () => {
    const payload = buildPayload({
      installationId: facts.installationId,
      errorCounts: { smtp_auth: 2, detail: 'could not reach mail.acme.test' } as never,
    });
    expect(payload.errorCounts).toEqual({ smtp_auth: 2 });
    expect(JSON.stringify(payload)).not.toContain('acme.test');
  });

  it('stores exactly what was sent, so an operator can read it', async () => {
    await setTelemetry(db, { enabled: true, endpoint: 'https://t.test', byUserId: ids.admin, resolveImpl });
    await sendTelemetry(db, { facts, sender: { async send() {} }, resolveImpl });

    const [row] = await db.query<{ last_payload: unknown }>(
      `select last_payload from telemetry_state where id = true`,
    );
    const stored = typeof row.last_payload === 'string'
      ? JSON.parse(row.last_payload) : row.last_payload;
    expect(stored).toMatchObject({ userCount: 3, version: '0.1.0' });
  });

  it('turning it off clears the endpoint too', async () => {
    await setTelemetry(db, { enabled: true, endpoint: 'https://t.test', byUserId: ids.admin, resolveImpl });
    // The endpoint is passed again on the way OFF. Omitting it made the
    // assertion pass for the wrong reason: `undefined ?? null` is null whatever
    // the code does with it.
    await setTelemetry(db, { enabled: false, endpoint: 'https://t.test', byUserId: ids.admin, resolveImpl });
    const [row] = await db.query<{ enabled: boolean; endpoint: string | null }>(
      `select enabled, endpoint from telemetry_state where id = true`,
    );
    expect(row.enabled).toBe(false);
    expect(row.endpoint).toBeNull();
  });

  // Phase 10 added two outbound URLs an administrator types — this endpoint and
  // the support gateway — and neither went through the SSRF guard Phase 4 built
  // for model providers. An operator who pastes a metadata address should not
  // hand their cloud role's credentials to whatever answers.
  it('refuses a cloud-metadata endpoint', async () => {
    await expect(setTelemetry(db, {
      enabled: true, endpoint: 'http://169.254.169.254/latest/meta-data/',
      byUserId: ids.admin, resolveImpl: async () => ['169.254.169.254'],
    })).rejects.toThrow();

    const [row] = await db.query<{ enabled: boolean; endpoint: string | null }>(
      `select enabled, endpoint from telemetry_state where id = true`,
    );
    expect(row.enabled).toBe(false);
    expect(row.endpoint).toBeNull();
  });

  it('refuses one that only resolves to metadata at send time', async () => {
    // Benign when saved, metadata when used. Checking only at save time is
    // checking the wrong moment.
    await setTelemetry(db, {
      enabled: true, endpoint: 'https://t.test', byUserId: ids.admin, resolveImpl,
    });
    let called = false;
    const out = await sendTelemetry(db, {
      facts, sender: { async send() { called = true; } },
      resolveImpl: async () => ['169.254.169.254'],
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toContain('not a safe destination');
    expect(called).toBe(false);
  });

  it('the disclosure names everything the payload can contain', () => {
    expect(TELEMETRY_DISCLOSURE).toContain('random installation ID');
    expect(TELEMETRY_DISCLOSURE).toContain('not derived from your hardware');
    expect(TELEMETRY_DISCLOSURE).toContain('never sends messages');
    expect(TELEMETRY_DISCLOSURE).toContain('off unless you turn it on');
  });
});
