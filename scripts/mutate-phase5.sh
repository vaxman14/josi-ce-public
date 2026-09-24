#!/usr/bin/env bash
# Phase 5 mutation testing.
#
# The dangerous controls this phase adds are all about one thing: whose content
# is it. A green suite proves nothing on its own, so each mutation below breaks
# one of them and the suite must go red.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/core/src/ownership.ts
  packages/core/src/tasks.ts
  packages/core/src/conversations.ts
  packages/core/src/approvals.ts
  packages/core/src/stepUp.ts
  packages/core/src/metrics.ts
  packages/core/src/locks.ts
  packages/core/src/events.ts
  packages/agent/src/assistantAgent.ts
  apps/api/src/http/assistantRoutes.ts
  apps/worker/src/jobs.ts
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

assert_mutated() {
  if diff -rq "$BACKUP/apps" apps >/dev/null 2>&1 && diff -rq "$BACKUP/packages" packages >/dev/null 2>&1; then
    echo "  !! MUTATION DID NOT APPLY — result below is meaningless"
    return 1
  fi
  return 0
}

echo "=== BASELINE ==="; run

echo
echo "=== M1: the super admin can read anyone's private resource ==="
python3 - <<'PY'
p='packages/core/src/ownership.ts'; s=open(p).read()
s=s.replace("  if (row.owner_user_id === args.accessor.userId) {","  if (row.owner_user_id === args.accessor.userId || args.accessor.role === 'super_admin') {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M2: a non-owner gets 403 instead of 404 (existence confirmed) ==="
python3 - <<'PY'
p='apps/api/src/http/assistantRoutes.ts'; s=open(p).read()
# force the ownership guard to reveal existence by looking it up directly
s=s.replace("""  r.get(
    '/threads/:id',
    requireOwnership({ db }, { type: 'thread', need: 'read' }),""","""  r.get(
    '/threads/:id',
    asyncRoute(async (req, res, ) => {
      const rows = await db.query(`select id from threads where id = $1`, [param(req, 'id')]);
      if (rows.length && (await getThread(db, param(req, 'id')))!.owner_user_id !== req.user!.id) {
        return res.status(403).json({ error: 'not yours' });
      }
      return res.status(404).json({ error: 'not found' });
    }),""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M3: tasks are workspace-wide instead of owner-scoped ==="
python3 - <<'PY'
p='packages/core/src/tasks.ts'; s=open(p).read()
s=s.replace("""    `select * from tasks
     where owner_user_id = $1
       and ($2::boolean or state not in ('closed', 'confirmed', 'cancelled', 'failed'))""","""    `select * from tasks
     where ($1::uuid is not null)
       and ($2::boolean or state not in ('closed', 'confirmed', 'cancelled', 'failed'))""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M4: conversation text is copied into the audit log ==="
python3 - <<'PY'
p='packages/core/src/conversations.ts'; s=open(p).read()
s=s.replace("""      inboundChars: args.inbound.length,
      replyChars: args.reply.length,""","""      inboundChars: args.inbound.length,
      replyChars: args.reply.length,
      transcript: `${args.inbound} / ${args.reply}`,""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M5: slot VALUES are written to the audit log ==="
python3 - <<'PY'
p='packages/core/src/tasks.ts'; s=open(p).read()
s=s.replace("    payload: { keys: Object.keys(patch) },","    payload: { keys: Object.keys(patch), values: Object.values(patch).join(',') },")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M6: the admin's ceiling can LOOSEN a user's approval level ==="
python3 - <<'PY'
p='packages/core/src/approvals.ts'; s=open(p).read()
s=s.replace("  return STRICTNESS[user] <= STRICTNESS[admin] ? user : admin;","  return admin;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M7: a risky action obeys the routine setting ==="
python3 - <<'PY'
p='packages/core/src/approvals.ts'; s=open(p).read()
s=s.replace("  if (isRiskyAction(args.action)) return true;","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M8: an approval is not bound to the action it described ==="
python3 - <<'PY'
p='packages/core/src/approvals.ts'; s=open(p).read()
s=s.replace("  if (row.payload_hash !== approvalHash(args.payload)) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M9: anyone may decide someone else's approval ==="
python3 - <<'PY'
p='packages/core/src/approvals.ts'; s=open(p).read()
s=s.replace("  if (existing.owner_user_id !== args.decidedBy) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M10: an approval can be spent while still pending ==="
python3 - <<'PY'
p='packages/core/src/approvals.ts'; s=open(p).read()
s=s.replace("  if (row.status !== 'approved') return { ok: false, reason: 'not_approved' };","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M11: step-up stops gating destructive actions ==="
python3 - <<'PY'
p='packages/core/src/stepUp.ts'; s=open(p).read()
s=s.replace("  if (!isSensitiveAction(args.action)) return { allowed: true, reason: 'not_sensitive' };","  return { allowed: true, reason: 'not_sensitive' };")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M12: a step-up unlock is account-wide instead of session-scoped ==="
python3 - <<'PY'
p='packages/core/src/stepUp.ts'; s=open(p).read()
s=s.replace("     where user_id = $1 and session_key = $2 and expires_at > now()","     where user_id = $1 and ($2 is not null) and expires_at > now()")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M13: the step-up lockout never lifts (life sentence) ==="
python3 - <<'PY'
p='packages/core/src/stepUp.ts'; s=open(p).read()
s=s.replace("       and created_at > now() - make_interval(secs => $3)","       and ($3::int is not null)")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M14: an expired step-up unlock still counts ==="
python3 - <<'PY'
p='packages/core/src/stepUp.ts'; s=open(p).read()
s=s.replace("and session_key = $2 and expires_at > now()","and session_key = $2")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M15: the agent acts on a task belonging to someone else ==="
python3 - <<'PY'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("    `select id from tasks where id = $1 and owner_user_id = $2`,\n    [taskId, userId],","    `select id from tasks where id = $1 and ($2 is not null)`,\n    [taskId, userId],")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M16: the agent skips the step-up gate ==="
python3 - <<'PY'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("        if (!decision.allowed) {","        if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M17: tools are offered to a model never proven to call them ==="
python3 - <<'PY'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("  const tools = capabilities.toolCalling ? TASK_TOOLS.map((t) => t.def) : undefined;","  const tools = TASK_TOOLS.map((t) => t.def);")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M18: an unprobed model is used anyway ==="
python3 - <<'PY'
p='packages/agent/src/assistantAgent.ts'; s=open(p).read()
s=s.replace("  if (!capabilities || !stored.activated_at) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M19: a turn runs as the CALLER instead of the thread's owner ==="
python3 - <<'PY'
p='apps/api/src/http/assistantRoutes.ts'; s=open(p).read()
s=s.replace("        userId: thread.owner_user_id,","        userId: req.user!.id,")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M20: a read-only share may speak into the conversation ==="
python3 - <<'PY'
p='apps/api/src/http/assistantRoutes.ts'; s=open(p).read()
s=s.replace("""    '/threads/:id/talk',
    requireOwnership({ db }, { type: 'thread', need: 'write' }),""","""    '/threads/:id/talk',
    requireOwnership({ db }, { type: 'thread', need: 'read' }),""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M21: the admin assistant view returns member content ==="
python3 - <<'PY'
p='apps/api/src/http/assistantRoutes.ts'; s=open(p).read()
s=s.replace("""      const perUser = await db.query(""","""      const leak = await db.query(`select body from messages limit 5`);
      const perUser = await db.query(""")
s=s.replace("""        perUser,""","""        perUser, leak,""")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M22: the correction rate is scored over all tasks, not reviewed ones ==="
python3 - <<'PY'
p='packages/core/src/metrics.ts'; s=open(p).read()
s=s.replace("         and e.kind <> 'task.created'","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M23: the task state machine permits any transition ==="
python3 - <<'PY'
p='packages/core/src/tasks.ts'; s=open(p).read()
s=s.replace("  if (!TRANSITIONS[task.state].includes(to)) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M24: resource locks are not exclusive ==="
python3 - <<'PY'
p='packages/core/src/locks.ts'; s=open(p).read()
s=s.replace("     on conflict (resource_key) do nothing\n     returning task_id","     on conflict (resource_key) do update set task_id = excluded.task_id\n     returning task_id")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M25: the audit-payload content guard is removed ==="
# Initially NOT caught: the guard had been untested since Phase 1. Four tests
# were added in packages/core/test/assistant.test.ts; this now fails three.
python3 - <<'PY'
p='packages/core/src/events.ts'; s=open(p).read()
s=s.replace("  assertMetadataOnly(payload);","")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== M26: an unknown job kind is marked done instead of failing ==="
python3 - <<'PY'
p='apps/worker/src/jobs.ts'; s=open(p).read()
s=s.replace("      throw new Error(`no handler for job kind ${job.kind}`);","      return;")
open(p,'w').write(s)
PY
assert_mutated && run; restore

echo
echo "=== RESTORED — full suite must be green ==="
run
