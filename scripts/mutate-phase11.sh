#!/usr/bin/env bash
# Phase 11 mutation testing.
#
#   M_FROM=1 M_TO=8 bash scripts/mutate-phase11.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/core/src/ratelimit.ts
  packages/ops/src/telemetry.ts
  apps/api/src/http/opsRoutes.ts
  apps/api/src/http/storageRoutes.ts
  apps/api/test/threatModel.test.ts
  docs/THREAT_MODEL.md
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
# Rate limiting.
# --------------------------------------------------------------------------
if should_run; then mut "the allowance is never spent — T-35"
python3 - <<'MUT'
p='packages/core/src/ratelimit.ts'; s=open(p).read()
s=s.replace("    ok: count <= limit.max,","    ok: true,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the limit is global rather than per subject — T-35"
python3 - <<'MUT'
p='packages/core/src/ratelimit.ts'; s=open(p).read()
s=s.replace("    [limit.bucket, args.subject, limit.windowSeconds],","    [limit.bucket, 'global', limit.windowSeconds],",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the window never resets, so a limit is permanent"
python3 - <<'MUT'
p='packages/core/src/ratelimit.ts'; s=open(p).read()
before = """       window_started_at = case
         when rate_limits.window_started_at < now() - make_interval(secs => $3)
           then now() else rate_limits.window_started_at end,
       count = case
         when rate_limits.window_started_at < now() - make_interval(secs => $3)
           then 1 else rate_limits.count + 1 end"""
after = """       window_started_at = rate_limits.window_started_at,
       count = rate_limits.count + 1"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "peeking spends the allowance"
python3 - <<'MUT'
p='packages/core/src/ratelimit.ts'; s=open(p).read()
before = """  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `select count, extract(epoch from (now() - window_started_at))::int as age_seconds
     from rate_limits where bucket = $1 and subject = $2`,
    [args.limit.bucket, args.subject],
  );"""
after = """  return consume(db, { limit: args.limit, subject: args.subject });
  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `select count, extract(epoch from (now() - window_started_at))::int as age_seconds
     from rate_limits where bucket = $1 and subject = $2`,
    [args.limit.bucket, args.subject],
  );"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the count is read and then written, so two requests race"
python3 - <<'MUT'
p='packages/core/src/ratelimit.ts'; s=open(p).read()
before = """  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `insert into rate_limits (bucket, subject, window_started_at, count)"""
after = """  const [existing] = await db.query<{ count: number }>(
    `select count from rate_limits where bucket = $1 and subject = $2`,
    [limit.bucket, args.subject],
  );
  if ((existing?.count ?? 0) >= limit.max) {
    return { ok: false, remaining: 0, retryAfterSeconds: limit.windowSeconds };
  }
  const [row] = await db.query<{ count: number; age_seconds: number }>(
    `insert into rate_limits (bucket, subject, window_started_at, count)"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the backup route is not rate limited"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
s=s.replace("      if (!(await limited(req, res, LIMITS.backup))) return undefined;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the diagnostics route is not rate limited"
python3 - <<'MUT'
p='apps/api/src/http/opsRoutes.ts'; s=open(p).read()
s=s.replace("      if (!(await limited(req, res, LIMITS.diagnostics))) return undefined;","",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "search is not rate limited"
python3 - <<'MUT'
p='apps/api/src/http/storageRoutes.ts'; s=open(p).read()
s=s.replace("      if (!verdict.ok) {","      if (false) {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# SSRF on the URLs Phase 10 added.
# --------------------------------------------------------------------------
if should_run; then mut "the telemetry endpoint is not checked when set — T-11"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
before = """  if (args.enabled && args.endpoint) {
    await assertOutboundUrlSafe(args.endpoint, args.resolveImpl);
  }"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the telemetry endpoint is not re-checked when used — T-11"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
before = """  try {
    await assertOutboundUrlSafe(state.endpoint, args.resolveImpl);
  } catch (err) {"""
after = """  try {
    if (false) await assertOutboundUrlSafe(state.endpoint, args.resolveImpl);
  } catch (err) {"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the support gateway is not checked before a bundle leaves — T-11"
python3 - <<'MUT'
p='packages/ops/src/telemetry.ts'; s=open(p).read()
before = """  try {
    await assertOutboundUrlSafe(args.gatewayUrl, args.resolveImpl);
  } catch (err) {"""
after = """  try {
    if (false) await assertOutboundUrlSafe(args.gatewayUrl, args.resolveImpl);
  } catch (err) {"""
s=s.replace(before, after, 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

# --------------------------------------------------------------------------
# The threat-model checker, tested the only way that means anything: break the
# DOCUMENT and require the checker to notice.
#
# The first version of these mutations weakened the checker AND introduced the
# violation together, so of course nothing failed — there was no longer anything
# looking. A mutation has to remove exactly one control and leave whatever
# should catch it in place.
# --------------------------------------------------------------------------
if should_run; then mut "an entry names a test that does not exist"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("**Test:** refuses replaying a completed step","**Test:** a test which does not exist anywhere in this repository",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an entry names a control file that does not exist"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("**Control:** `packages/core/src/stepUp.ts`","**Control:** `packages/core/src/doesNotExist.ts`",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an entry has neither a control nor an acceptance"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
before = """**Control:** `packages/auth/src/ratelimit.ts` — failures counted per identifier
and per IP, forgotten on success, since what is being limited is guessing.
**Test:** locks out after repeated failures"""
s=s.replace(before, "", 1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a risk is accepted without a reason"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
i=s.index("### T-40 Deliverability and mail reputation")
j=s.index("### T-41")
s=s[:i]+"### T-40 Deliverability and mail reputation\n**Accepted:** yes.\n\n"+s[j:]
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an accepted risk also claims a control it does not have"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("""### T-37 A compromised host reads everything
**Accepted:**""","""### T-37 A compromised host reads everything
**Control:** `packages/core/src/masterKey.ts` — claims to defend against root, which it cannot do.
**Accepted:**""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the host-compromise risk is quietly dropped"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
i=s.index("### T-37 A compromised host reads everything")
j=s.index("### T-38")
s=s[:i]+s[j:]
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a surface the plan requires is not covered at all"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("rollback","")
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an entry does not say who the attacker is"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("""**Attacker:** a member with a mapping, or a crafted filename on disk.
**Impact:** reads anywhere the container can reach.""","""**Impact:** reads anywhere the container can reach.""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a control names a file but no mechanism"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("""**Control:** `packages/storage/src/paths.ts` — normalise, structural containment
check, resolve symlinks, check again; `startsWith` is explicitly not used.""",
"""**Control:** `packages/storage/src/paths.ts` — it.""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "two entries share an id"
python3 - <<'MUT'
p='docs/THREAT_MODEL.md'; s=open(p).read()
s=s.replace("### T-14 An archive expands until the disk is full","### T-13 An archive expands until the disk is full",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 999 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
