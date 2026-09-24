#!/usr/bin/env bash
# Phase 4 mutation testing.
#
# A green suite proves nothing on its own: it might be green because the
# assertions are decorative. Each mutation below deliberately breaks one
# dangerous control, and the suite must go red. A mutation that leaves the suite
# green is a missing test, and is reported as such rather than explained away.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/llm/src/registry.ts
  packages/llm/src/metering.ts
  packages/llm/src/probe.ts
  packages/llm/src/ssrf.ts
  packages/llm/src/types.ts
  apps/api/src/http/llmRoutes.ts
  packages/db/migrations/0003_llm.sql
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  # Rebuild too, so a mutated dist never outlives its source.
  npx tsc -b >/dev/null 2>&1 || true
}

# Restore on INT/TERM as well as a normal exit. Killing this script used to
# leave a mutation applied in the working tree, which is a silently broken
# product waiting to be committed.
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

assert_mutated() {
  if diff -rq "$BACKUP/apps" apps >/dev/null 2>&1 && diff -rq "$BACKUP/packages" packages >/dev/null 2>&1; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"
    return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

echo
echo "=== M1: Local-only mode stops refusing hosted providers ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("  if (external && (await isLocalOnly(opts.db))) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M2: the spending cap warns but never stops ==="
python3 - <<'PY'
p='packages/llm/src/metering.ts'; s=open(p).read()
s=s.replace("  if (status === 'blocked') {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M3: the cap is checked after the call instead of before ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("""  if (chatOpts.enforceCaps !== false && !cap.allowed) {
    throw new LlmError(cap.message, { needsReconfiguration: true });
  }""","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M4: the fallback fires on any failure, including a bad key ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("    if (!fallback || !fallback.activated_at || !retryable) throw err;","    if (!fallback) throw err;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M5: an unprobed provider may be used ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("""  if (!primary.activated_at) {
    throw new LlmError('the configured model has not been tested yet, so Josi will not use it', {
      needsReconfiguration: true,
    });
  }""","")
# the check constraint would still bite; drop it so this tests the app layer
p2='packages/db/migrations/0003_llm.sql'; s2=open(p2).read()
s2=s2.replace("""alter table llm_providers add constraint llm_active_requires_probe check (
  activated_at is null or (probed_at is not null and cap_chat = true)
);""","")
open(p,'w').write(s); open(p2,'w').write(s2)
PY
assert_mutated && run; restore

echo
echo "=== M6: capabilities are assumed present rather than observed ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("    toolCalling: stored.cap_tool_calling === true,","    toolCalling: stored.cap_tool_calling !== false,")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M7: an unprobed model is treated as fully capable ==="
python3 - <<'PY'
p='packages/llm/src/types.ts'; s=open(p).read()
s=s.replace("""  if (!capabilities) {""","""  if (false) {""")
s=s.replace("""  return FEATURE_GATES.filter((g) => !capabilities[g.requires]).map((g) => ({""","""  return FEATURE_GATES.filter((g) => capabilities !== null && !capabilities[g.requires]).map((g) => ({""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M8: the probe believes the request was accepted instead of reading the reply ==="
python3 - <<'PY'
p='packages/llm/src/probe.ts'; s=open(p).read()
s=s.replace("""      passed = typeof value === 'object' && value !== null && 'ok' in value;
    } catch {
      passed = false;
    }""","""      passed = true;
    } catch {
      passed = true;
    }""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M9: a tool call is inferred rather than observed ==="
python3 - <<'PY'
p='packages/llm/src/probe.ts'; s=open(p).read()
s=s.replace("    const passed = res.toolCalls.some((c) => c.name === PROBE_TOOL.name);","    const passed = true;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M10: cloud metadata stops being blocked ==="
python3 - <<'PY'
p='packages/llm/src/ssrf.ts'; s=open(p).read()
s=s.replace("  { base: '169.254.0.0', bits: 16, why: 'link-local / cloud metadata' },","")
s=s.replace("  { prefix: 'fe80', why: 'link-local' },","")
s=s.replace("  { prefix: 'fd00:ec2', why: 'cloud metadata' },","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M11: redirects are followed ==="
python3 - <<'PY'
p='packages/llm/src/ssrf.ts'; s=open(p).read()
s=s.replace("      redirect: 'manual',","      redirect: 'follow',")
s=s.replace("""    if (res.status >= 300 && res.status < 400) {
      throw new UnsafeEndpointError(
        'that endpoint redirected, which is not followed — point the base URL directly at the API',
      );
    }""","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M12: only the first resolved address is checked ==="
python3 - <<'PY'
p='packages/llm/src/ssrf.ts'; s=open(p).read()
s=s.replace("  for (const address of addresses) {","  for (const address of addresses.slice(0, 1)) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M13: addresses are checked at save time only, not at request time ==="
python3 - <<'PY'
p='packages/llm/src/ssrf.ts'; s=open(p).read()
s=s.replace("  await validateEndpoint(rawUrl, opts);","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M14: reported and estimated cost are blended into one number ==="
python3 - <<'PY'
p='packages/llm/src/metering.ts'; s=open(p).read()
s=s.replace("    source: 'estimated',","    source: 'reported',")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M15: a self-hosted call is priced as if it cost money ==="
python3 - <<'PY'
p='packages/llm/src/metering.ts'; s=open(p).read()
s=s.replace("  if (!args.external) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M16: the acknowledgment is no longer required at call time ==="
python3 - <<'PY'
p='packages/llm/src/registry.ts'; s=open(p).read()
s=s.replace("  if (external && !stored.external_acknowledged) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M17: saving a provider keeps the previous probe result ==="
python3 - <<'PY'
p='apps/api/src/http/llmRoutes.ts'; s=open(p).read()
s=s.replace("""           activated_at = null, probed_at = null, probe_steps = '[]',
           cap_chat = null, cap_structured_output = null, cap_tool_calling = null,
           cap_context_tokens = null`,""","""           probe_steps = probe_steps`,""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M18: the admin config endpoint returns the sealed key ==="
python3 - <<'PY'
p='apps/api/src/http/llmRoutes.ts'; s=open(p).read()
s=s.replace("    apiKeySet: !!stored.api_key_enc,","    apiKeySet: !!stored.api_key_enc,\n    apiKeyCiphertext: stored.api_key_enc,")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M21: ciphertext leaks under a field name the guard does not know ==="
# M18 is caught by assertMetadataOnly's key list. This one uses a name that list
# has never heard of, so only the response-shape assertion can catch it — which
# is the point: prove the test, not just the guard.
python3 - <<'PY'
p='apps/api/src/http/llmRoutes.ts'; s=open(p).read()
s=s.replace("    probeSteps: steps?.probe_steps ?? [],","    probeSteps: steps?.probe_steps ?? [],\n    storedBlob: stored.api_key_enc,")
s=s.replace("  probeSteps: unknown;","  probeSteps: unknown;\n  storedBlob?: string | null;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M19: a member's status endpoint reports the whole installation's usage ==="
python3 - <<'PY'
p='apps/api/src/http/llmRoutes.ts'; s=open(p).read()
s=s.replace("        usage: await usageSummary(db, req.user!.id),","        usage: await usageSummary(db),")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M20: subscription options are offered as available ==="
python3 - <<'PY'
p='apps/api/src/http/llmRoutes.ts'; s=open(p).read()
s=s.replace("  available: false,","  available: true,")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== RESTORED — full suite must be green ==="
run
