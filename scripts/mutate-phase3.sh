#!/usr/bin/env bash
# Phase 3 mutation testing. Each mutation deliberately breaks one dangerous
# control; the suite must fail. Every mutation is restored afterwards and the
# full suite re-run green at the end.
set -uo pipefail
cd "$(dirname "$0")/.."

BACKUP=$(mktemp -d)
trap 'rm -rf "$BACKUP"' EXIT
for f in apps/api/src/http/setupGate.ts apps/api/src/setup/setupRoutes.ts apps/api/src/setup/steps.ts packages/db/migrations/0002_setup.sql; do
  mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"
done
restore() { for f in apps/api/src/http/setupGate.ts apps/api/src/setup/setupRoutes.ts apps/api/src/setup/steps.ts packages/db/migrations/0002_setup.sql; do cp "$BACKUP/$f" "$f"; done; }

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

# A mutation that silently fails to apply reports "not caught" and looks like a
# missing test. Every mutation must demonstrably change the tree first.
assert_mutated() {
  if diff -rq "$BACKUP/apps" apps >/dev/null 2>&1 && diff -rq "$BACKUP/packages" packages >/dev/null 2>&1; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"
    return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

echo
echo "=== M1: allow a non-setup route before completion ==="
python3 - <<'PY'
p='apps/api/src/http/setupGate.ts'; s=open(p).read()
s=s.replace("""      res.status(503).json({
        error: 'this installation has not been set up yet',
        setupRequired: true,
      });
      return;""","""      next();
      return;""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M2: return the wizard after completion ==="
python3 - <<'PY'
p='apps/api/src/http/setupGate.ts'; s=open(p).read()
s=s.replace("""    if (setupPath) {
      res.status(404).json({ error: 'not found' });
      return;
    }""","""    if (setupPath) {
      next();
      return;
    }""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M3: remove the single-use/concurrency guard on completion ==="
python3 - <<'PY'
p='apps/api/src/setup/setupRoutes.ts'; s=open(p).read()
s=s.replace("     where id = true and completed = false\n     returning completed_at","     where id = true\n     returning completed_at")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M4: permit step skipping ==="
python3 - <<'PY'
p='apps/api/src/setup/steps.ts'; s=open(p).read()
s=s.replace("  if (step !== expected) return { ok: false, reason: 'out_of_order', expected };\n","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M5: default telemetry ON ==="
python3 - <<'PY'
p='apps/api/src/setup/setupRoutes.ts'; s=open(p).read()
s=s.replace("      const enabled = body.enabled === true;","      const enabled = body.enabled !== false;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M6: store a plaintext secret ==="
python3 - <<'PY'
p='apps/api/src/setup/setupRoutes.ts'; s=open(p).read()
s=s.replace("      const sealedKey = key ? seal(key, { apiKey }) : null;","      const sealedKey = apiKey.isEmpty ? null : apiKey.reveal();")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M7: remove the external-provider acknowledgment requirement ==="
python3 - <<'PY'
p='apps/api/src/setup/setupRoutes.ts'; s=open(p).read()
s=s.replace("      if (isExternal && !acknowledged) {","      if (false) {")
# the DB check constraint would still bite, so drop it too — proving the app-layer test
p2='packages/db/migrations/0002_setup.sql'; s2=open(p2).read()
s2=s2.replace("""alter table llm_providers add constraint llm_external_requires_ack check (
  provider = 'openai_compatible' or external_acknowledged = true
);""","")
open(p,'w').write(s); open(p2,'w').write(s2)
PY
assert_mutated && run; restore

echo
echo "=== M8: return a secret in the review summary ==="
python3 - <<'PY'
p='apps/api/src/setup/setupRoutes.ts'; s=open(p).read()
s=s.replace("          apiKeySet: !!llm.api_key_enc,","          apiKeySet: !!llm.api_key_enc,\n          apiKeyCiphertext: llm.api_key_enc,")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== RESTORED — full suite must be green ==="
run
