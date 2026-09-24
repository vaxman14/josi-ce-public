#!/usr/bin/env bash
# Phase 13.0 mutation testing: the edition capability boundary.
#
# Every mutation here is a plausible edit that WIDENS the boundary — the
# direction that matters. A test suite that only proves CE has CE's
# capabilities would survive all of them.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/core/src/edition.ts
  scripts/stamp-edition.mjs
)

BACKUP=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BACKUP/$(dirname "$f")"; cp "$f" "$BACKUP/$f"; done
restore() {
  for f in "${FILES[@]}"; do cp "$BACKUP/$f" "$f"; done
  npx tsc -b >/dev/null 2>&1 || true
}
trap 'restore; rm -rf "$BACKUP"; echo; echo "(interrupted — sources restored)"; exit 130' INT TERM
trap 'restore; rm -rf "$BACKUP"' EXIT

run() {
  npx tsc -b >/dev/null 2>&1
  npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1
}

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-999}"; N=0
should_run() { N=$((N+1)); [[ $N -ge $M_FROM && $N -le $M_TO ]]; }

assert_mutated() {
  local changed=0
  for f in "${FILES[@]}"; do cmp -s "$BACKUP/$f" "$f" || changed=1; done
  if [[ $changed -eq 0 ]]; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"; return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run
mut() { echo; echo "=== M$N: $1 ==="; }

if should_run; then mut "an unrecognised stamp falls open to CE"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace("const FAIL_CLOSED: Edition = 'hosted';","const FAIL_CLOSED: Edition = 'ce';",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the environment can grant a capability"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  const granted = BY_EDITION[edition].filter((cap) => !disabled.has(cap));",
  "  const extra = (args.env ?? process.env).JOSI_ENABLED_CAPABILITIES ?? '';\n"
  "  const added = extra.split(',').map((c) => c.trim()).filter(isCapability);\n"
  "  const granted = [...new Set([...BY_EDITION[edition], ...added])].filter((cap) => !disabled.has(cap));",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the environment can override the edition"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  const stamp = args.stamp ?? BUILD_EDITION;",
  "  const stamp = (args.env ?? process.env).JOSI_EDITION ?? args.stamp ?? BUILD_EDITION;",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "narrowing is ignored"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  const granted = BY_EDITION[edition].filter((cap) => !disabled.has(cap));",
  "  const granted = BY_EDITION[edition].filter(() => true);",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the prerequisite check is dropped"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  const capabilities = granted.filter((cap) => {\n"
  "    const needs = REQUIRES[cap];\n"
  "    return !needs || granted.includes(needs);\n"
  "  });",
  "  const capabilities = granted;",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the profile is not frozen"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  return Object.freeze({\n    edition,\n    capabilities: Object.freeze(capabilities),\n    stampRecognised,\n  });",
  "  return {\n    edition,\n    capabilities,\n    stampRecognised,\n  };",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the capability table is not frozen"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace("    capabilities: Object.freeze(capabilities),","    capabilities,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "edition matching becomes case-insensitive"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  return typeof value === 'string' && (EDITIONS as readonly string[]).includes(value);",
  "  return typeof value === 'string'\n"
  "    && (EDITIONS as readonly string[]).includes(value.trim().toLowerCase());",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "assertCapability warns instead of refusing"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace(
  "  if (!hasCapability(capability, profile)) {\n    throw new CapabilityUnavailable(capability, profile.edition);\n  }",
  "  if (!hasCapability(capability, profile)) {\n    console.warn(`capability ${capability} unavailable`);\n  }",
  1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "hosted gets local command execution"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace("  hosted: Object.freeze([] as const),","  hosted: Object.freeze(['local_command_execution'] as const),",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "describeEdition aliases the live capability list"
python3 - <<'MUT'
p='packages/core/src/edition.ts'; s=open(p).read()
s=s.replace("    capabilities: [...profile.capabilities],","    capabilities: profile.capabilities as Capability[],",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the stamp script accepts any edition string"
python3 - <<'MUT'
p='scripts/stamp-edition.mjs'; s=open(p).read()
s=s.replace("const EDITIONS = ['ce', 'hosted', 'business', 'white_label'];","const EDITIONS = ['ce', 'hosted', 'business', 'white_label', 'enterprise'];",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the stamp script stops verifying that it stamped anything"
python3 - <<'MUT'
p='scripts/stamp-edition.mjs'; s=open(p).read()
s=s.replace("    console.error(`stamp-edition: could not stamp the ${what} — buildStamp.ts is not the shape this script expects`);\n    process.exit(3);","    void what;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

echo
echo "=== DONE (restoring sources) ==="
