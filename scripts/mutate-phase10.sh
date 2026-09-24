#!/usr/bin/env bash
# Phase 10 mutation testing.
#
#   M_FROM=1 M_TO=8 bash scripts/mutate-phase10.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/ops/src/backup.ts
  packages/db/migrations/0002_setup.sql
  packages/ops/src/diagnostics.ts
  packages/ops/src/update.ts
  packages/ops/src/telemetry.ts
  apps/api/src/http/opsRoutes.ts
  packages/db/migrations/0011_operations.sql
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  # Rebuild too, so a mutated dist never outlives its source.
  npx tsc -b >/dev/null 2>&1 || true
}
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

# Rebuild before running.
#
# A consumer that imports `@josi-ce/persona` resolves to the package's BUILT
# dist, not its source. Without this, a mutation to persona/src is invisible to
# every test in another package — which is exactly what happened: seven
# mutations were measured against stale compiled output and recorded as
# "survived" when they had never been applied to the code under test.
run() {
  npx tsc -b >/dev/null 2>&1
  npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1
}

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-999}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  local changed=0
  for f in "${FILES[@]}"; do
    cmp -s "$BACKUP/$f" "$f" || changed=1
  done
  if [[ $changed -eq 0 ]]; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

mut() { echo; echo "=== M$N: $1 ==="; }

# --------------------------------------------------------------------------
# The acceptance criterion.
# --------------------------------------------------------------------------
if should_run; then mut "a restore without the key reports credentials recovered — M100"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("    const credentialsRecovered = args.masterKeyPresent;","    const credentialsRecovered = true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a restore without the key gives no warning — M100"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("      warning: credentialsRecovered ? undefined : NO_KEY_WARNING,","      warning: undefined,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the missing key is not recorded on the attempt — M100"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("        credentialsRecovered ? null : 'no_master_key',","        null,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a backup may claim to contain the master key — M100"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
s=s.replace("  constraint backup_never_holds_the_key check (includes_master_key = false),","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup description omits the master-key warning — M100"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
i=s.index("  parts.push(\n    'It does NOT contain")
j=s.index("  parts.push(\n    masterKeyConfirmed")
s=s[:i]+s[j:]
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an unconfirmed key is described as reassuringly as a confirmed one"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("    masterKeyConfirmed\n      ?","    true\n      ?",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a portable export carries recovery copies — M63"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("  databaseRows: true, configuration: false, uploads: true, recoveryCopies: false,","  databaseRows: true, configuration: false, uploads: true, recoveryCopies: true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the database allows a portable export holding recovery copies — M63"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
before = """  constraint portable_excludes_recovery check (
    kind = 'full' or includes_recovery_copies = false
  )"""
s=s.replace(before, "  constraint portable_excludes_recovery check (true)", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a backup may be written outside Josi's own volume"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
s=s.replace("  constraint backup_inside_josi check (stored_path like '/data/backups/%'),","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a failed backup is recorded as complete"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("      `update backups set state = 'failed', error_category = $2, completed_at = now() where id = $1`,","      `update backups set state = 'complete', error_category = $2, completed_at = now() where id = $1`,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a failed restore is recorded as complete"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("      `update restore_attempts set state = 'failed', error_category = $2, finished_at = now()","      `update restore_attempts set state = 'complete', error_category = $2, finished_at = now()",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup filename is not sanitised"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '').replace(/\\.{2,}/g, '.');","  const cleaned = name;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup path reaches the audit log"
python3 - <<'MUT'
p='packages/ops/src/backup.ts'; s=open(p).read()
s=s.replace("      payload: { kind: args.kind, byteSize, masterKeyConfirmed: args.masterKeyConfirmed === true },","      payload: { kind: args.kind, byteSize, path: storedPath },",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Updates.
# --------------------------------------------------------------------------
if should_run; then mut "an update proceeds when the backup failed"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
before = """  } catch {
    return fail(
      'backup_failed',
      'The update did not start, because the pre-update backup failed. Nothing has changed.',
    );
  }"""
after = """  } catch {
    backupId = 'none';
  }"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup is taken AFTER applying"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  await setState('backing_up');
  let backupId: string;
  try {
    backupId = await args.steps.backup();""","""  await setState('backing_up');
  let backupId: string;
  try {
    await args.steps.apply(args.toVersion);
    backupId = await args.steps.backup();""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "there is no health check, so a broken version counts as working"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  if (!healthy) {""","""  if (false) {""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a rollback leaves the version recorded as the new one"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  await db.query(
    `update update_state set current_version = $1 where id = true`, [args.fromVersion],
  );""","""  await db.query(
    `update update_state set current_version = $1 where id = true`, [args.toVersion],
  );""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a failed rollback is softened into an ordinary failure"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("      failure: 'rollback_failed',","      failure: 'unknown',",1)
s=s.replace("      message: 'The update failed AND the rollback failed. This installation is between '\n        + `versions and needs manual attention. A backup was taken before the update started.`,","      message: 'The update did not complete.',",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "checking for an update applies it"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  await db.query(
    `update update_state set available_version = $1, last_check_at = now(), last_check_ok = $2
     where id = true`,
    [available, ok],
  );""","""  await db.query(
    `update update_state set available_version = $1, last_check_at = now(), last_check_ok = $2,
       current_version = coalesce($1, current_version)
     where id = true`,
    [available, ok],
  );""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a failed check invents a version"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  } catch {
    ok = false;
  }""","""  } catch {
    ok = false;
    available = '9.9.9';
  }""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "version comparison is lexical, so 0.1.10 is older than 0.1.9"
python3 - <<'MUT'
p='packages/ops/src/update.ts'; s=open(p).read()
s=s.replace("""  const parse = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(candidate);
  const [x, y, z] = parse(current);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;""","""  return candidate > current;""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an automatic-update setting exists"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
s=s.replace("  channel text not null default 'stable' check (channel in ('stable')),","  channel text not null default 'stable' check (channel in ('stable')),\n  auto_update boolean not null default false,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Diagnostics.
# --------------------------------------------------------------------------
if should_run; then mut "a bundle gains a section that carries messages — M113"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("  'counts',\n] as const;","  'counts',\n  'messages',\n] as const;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "redaction is disabled"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("""export function redact(text: string): { text: string; redactions: Redaction[] } {
  let out = text;""","""export function redact(text: string): { text: string; redactions: Redaction[] } {
  return { text, redactions: [] };
  let out = text;""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the final secret scan always passes"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("  return { clean: findings.length === 0, findings };","  return { clean: true, findings };",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "config VALUES are reported instead of whether they are set"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("          .map(([k, v]) => `${k}: ${v ? 'configured' : 'not configured'}`).join('\\n');","          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\\n');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a bundle may be approved without being read — M102"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("  if (!row.inspected_at) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the database allows submission without consent — M102"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
before = """  constraint bundle_submission_requires_consent check (
    submitted_at is null
    or (inspected_at is not null and approved_at is not null and secret_scan_passed_at is not null)
  )"""
s=s.replace(before, "  constraint bundle_submission_requires_consent check (true)", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the size cap is not enforced — M109"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("  if (args.built.byteSize > MAX_BUNDLE_BYTES) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "trimming keeps the OLDEST lines instead of the newest — M109"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("    for (let i = lines.length - 1; i >= 0; i -= 1) {","    for (let i = 0; i < lines.length; i += 1) {",1)
s=s.replace("      kept.unshift(lines[i]);","      kept.push(lines[i]);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "trimming is silent about what it dropped — M109"
python3 - <<'MUT'
p='packages/ops/src/diagnostics.ts'; s=open(p).read()
s=s.replace("        trimmed.push(`${i + 1} older log lines`);","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Telemetry.
# --------------------------------------------------------------------------
if should_run; then mut "telemetry sends while switched off — M98"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("  if (!state?.enabled) return { sent: false, reason: 'telemetry is off' };","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the payload allowlist is bypassed — M98"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("  for (const field of ALLOWED_FIELDS) {","  for (const field of Object.keys(facts) as typeof ALLOWED_FIELDS[number][]) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "free text is accepted in an allowlisted field — M98"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value)) {","      if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "nested objects keep their string values — M98"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("        if (typeof v === 'number' || typeof v === 'boolean') nested[k] = v;","        nested[k] = v as never;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "telemetry defaults to on — M98"
python3 - <<'MUT'
p='packages/db/migrations/0002_setup.sql'; s=open(p).read()
s=s.replace("  enabled boolean not null default false,","  enabled boolean not null default true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "turning telemetry off leaves the endpoint configured"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("       endpoint = case when $1 then $2 else null end,","       endpoint = coalesce($2, endpoint),",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Support.
# --------------------------------------------------------------------------
if should_run; then mut "a bug report needs no diagnostics — M105"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("  return category === 'bug_report' || category === 'paid_support';","  return false;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the acknowledgement is not required — M107"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("  if (!ticket.acknowledged_no_guarantee) {","  if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a bundle may be submitted without being read and scanned — M102"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("    if (!bundle?.inspected_at || !bundle.approved_at || !bundle.secret_scan_passed_at) {","    if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a ticket is anybody's to submit"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("  if (ticket.created_by !== args.userId) throw new SupportError('no such ticket');","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a ticket is marked submitted with no gateway configured — M115"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
before = """  if (!args.gatewayUrl) {
    return { submitted: false, reason: 'no support gateway is configured, so nothing was sent' };
  }"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the ticket description reaches the audit log"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
s=s.replace("    payload: { category: ticket.category, withBundle: !!ticket.bundle_id },","    payload: { category: ticket.category, description: (await db.query('select description from support_tickets where id = $1', [args.ticketId]))[0]?.description },",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the database allows a submitted bug report with no bundle — M105"
python3 - <<'MUT'
p='packages/db/migrations/0011_operations.sql'; s=open(p).read()
before = """  constraint ticket_requires_diagnostics check (
    state <> 'submitted'
    or category in ('feature_request', 'security_privacy')
    or bundle_id is not null
  ),"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# Over the wire.
# --------------------------------------------------------------------------
if should_run; then mut "a member may take a backup"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
before = """    '/admin/backups',
    requireSuperAdmin,
    handle(async (req, res) => {
      if (!ctx.backupWriter)"""
after = """    '/admin/backups',
    handle(async (req, res) => {
      if (!ctx.backupWriter)"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a member may read or change telemetry"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
before = """    '/admin/telemetry',
    requireSuperAdmin,
    handle(async (_req, res) => {"""
after = """    '/admin/telemetry',
    handle(async (_req, res) => {"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a colleague may read somebody else's diagnostics bundle"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
s=s.replace("      if (!row || row.created_by !== req.user!.id) throw new RouteError(404, 'not found');\n      await markInspected(db, id);","      if (!row) throw new RouteError(404, 'not found');\n      await markInspected(db, id);",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup path is returned to the caller"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
s=s.replace("""        `select id, kind, byte_size, state, error_category, includes_recovery_copies,
                master_key_confirmed, created_at, completed_at
         from backups order by created_at desc limit 50`,""","""        `select * from backups order by created_at desc limit 50`,""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a restore runs without confirmation"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
s=s.replace("      if (req.body?.confirm !== 'restore') {","      if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 999 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
