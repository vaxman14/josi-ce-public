#!/usr/bin/env bash
# Phase 12.2 mutation testing: first-run, presets, live preview, history.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/persona/src/presets.ts
  apps/api/src/http/personaRoutes.ts
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

if should_run; then mut "skipping first-run writes a profile anyway"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("      if (!skip && presetKey) {","      if (presetKey || skip) {",1)
s=s.replace("        const content = presetContent(presetKey);","        const content = presetContent(presetKey || 'warm');",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "first-run keeps being offered after it was skipped"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("        needed: !settings?.onboarding_skipped","        needed: true && !false && !settings?.onboarding_skipped === false ? true : true,\n        _unused: !settings?.onboarding_skipped",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "an unknown preset is accepted"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("        if (!content) throw new RouteError(400, 'no such preset');","        if (!content) return res.json({ done: true });",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a preset sets a field the schema does not have"
python3 - <<'MUT'
p='packages/persona/src/presets.ts'; s=open(p).read()
s=s.replace("    values: {\n      tone: 'brief',\n      relationship: 'professional',\n      humour: 'none',\n      verbosity: 'terse',\n    },","    values: {\n      tone: 'brief',\n      relationship: 'professional',\n      humour: 'none',\n      verbosity: 'terse',\n      allowed_tools: 'all',\n    },",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the preview returns the context instead of a model reply"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("          reply: outcome.response.text,","          reply: context.text,",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the preview uses somebody else's layers"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("      const layers = await loadAll(db, req.user!.id);\n      const { effective } = narrowPolicy(layers.agents_admin, layers.agents_user, CAUTION_ORDER);\n      const memories = await relevantMemories(db, { ownerUserId: req.user!.id, request });","      const layers = await loadAll(db, str(req.body?.asUser, 64) || req.user!.id);\n      const { effective } = narrowPolicy(layers.agents_admin, layers.agents_user, CAUTION_ORDER);\n      const memories = await relevantMemories(db, { ownerUserId: req.user!.id, request });",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the preview omits the core safety line"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("        core: PREVIEW_CORE,","        core: '',",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "the preview invents a reply when no model is configured"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("""      if (!stored || !stored.activated_at) {
        return res.status(503).json({""","""      if (false) {
        return res.status(503).json({""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "version history is somebody else's to read"
python3 - <<'MUT'
p='apps/api/src/http/personaRoutes.ts'; s=open(p).read()
s=s.replace("""      const versions = await listVersions(db, {
        kind, userId: kind === 'agents_admin' ? null : req.user!.id,
      });""","""      const versions = await listVersions(db, {
        kind, userId: kind === 'agents_admin' ? null : (str(req.query?.userId, 64) || req.user!.id),
      });""",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 999 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
