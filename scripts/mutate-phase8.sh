#!/usr/bin/env bash
# Phase 8 mutation testing.
#
# Foreground segments, as Phase 7 established: backgrounded runs on this machine
# get killed part-way, and two harnesses racing on the same files produce
# meaningless results.
#
#   M_FROM=1 M_TO=6 bash scripts/mutate-phase8.sh
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=(
  packages/mail/src/identity.ts
  packages/mail/src/send.ts
  packages/mail/src/inbound.ts
  packages/mail/src/threads.ts
  packages/mail/src/smtp.ts
  apps/api/src/http/mailRoutes.ts
  packages/db/migrations/0006_mail.sql
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

M_FROM="${M_FROM:-1}"; M_TO="${M_TO:-99}"; N=0
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

if should_run; then mut "the AI disclosure can be removed"
python3 - <<'PY'
p='packages/mail/src/identity.ts'; s=open(p).read()
s=s.replace("  if (text.length < MIN_DISCLOSURE_LENGTH) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the disclosure is simply not appended"
python3 - <<'PY'
p='packages/mail/src/identity.ts'; s=open(p).read()
s=s.replace("  return `${body}\\n\\n--\\n${text}`;","  return body;")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the database allows an empty disclosure"
python3 - <<'PY'
p='packages/db/migrations/0006_mail.sql'; s=open(p).read()
s=s.replace("  constraint mail_disclosure_present check (length(btrim(disclosure)) >= 10)","  constraint mail_disclosure_present check (true)")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "mail is sent from the person's own address (a forgery)"
python3 - <<'PY'
p='packages/mail/src/identity.ts'; s=open(p).read()
s=s.replace("    fromAddress: assertSafeAddress(args.profileFromAddress),","    fromAddress: assertSafeAddress(args.replyToAddress),")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "an address may carry a second header (injection)"
python3 - <<'PY'
p='packages/mail/src/identity.ts'; s=open(p).read()
s=s.replace("  if (/[\\r\\n\\0<>,;]/.test(value)) throw new MailIdentityError('that email address contains illegal characters');","")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "BCC is permitted"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("  if (args.bcc?.length) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the recipient ceiling is ignored"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("  if (total > args.maxRecipients) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "an attachment does not require approval — M44"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("  if (args.attachments.length) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "a new recipient does not require approval — M43"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("  if (args.newRecipients.length) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "an approval for a DIFFERENT message is accepted"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("      && approval.payload_hash === approvedHash;","")
s=s.replace("      && approval.owner_user_id === thread.owner_user_id","      && approval.owner_user_id === thread.owner_user_id;")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "a PENDING approval is treated as granted"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("      && approval.status === 'approved'","      && approval.status !== 'nonsense'")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the same message is sent twice"
python3 - <<'PY'
p='packages/mail/src/send.ts'; s=open(p).read()
s=s.replace("  if (already) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "exactly-once is not enforced by the database"
python3 - <<'PY'
p='packages/db/migrations/0006_mail.sql'; s=open(p).read()
s=s.replace("""create unique index email_messages_once
  on email_messages (thread_id, content_hash)
  where direction = 'out' and content_hash is not null;""","")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the SMTP server's own words reach the caller"
python3 - <<'PY'
p='packages/mail/src/smtp.ts'; s=open(p).read()
s=s.replace("        throw new MailError('the mail server refused the message', classifySmtpError(err));","        throw new MailError(String((err as Error).message), classifySmtpError(err));")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "inbound guesses an owner from the From address"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("  if (!token) return quarantine(db, message, 'no_routing_token');","  if (!token) token = 'guess';")
s=s.replace("""  const [thread] = await db.query<{ id: string; owner_user_id: string; deleted_at: string | null }>(
    `select id, owner_user_id, deleted_at from email_threads where routing_token = $1`,
    [token],
  );""","""  const [thread] = await db.query<{ id: string; owner_user_id: string; deleted_at: string | null }>(
    `select id, owner_user_id, deleted_at from email_threads where routing_token = $1 or true limit 1`,
    [token],
  );""")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "inbound runs even when the admin switched it off — M36"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("  if (!policy?.inbound_enabled) {","  if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "quarantine keeps the subject and the body"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("      message.subject.length,\n      message.bodyText.length,","      message.subject as unknown as number,\n      message.bodyText as unknown as number,")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "an automated reply is answered automatically"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("  if (looksAutomated(args.headers)) return false;","")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the loop budget never runs out"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("  return Number(count) < LOOP_MAX_AUTO_REPLIES;","  return true;")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "a reply to a trashed thread is delivered anyway"
python3 - <<'PY'
p='packages/mail/src/inbound.ts'; s=open(p).read()
s=s.replace("  if (thread.deleted_at) return quarantine(db, message, 'thread_deleted');","")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "deleting a thread destroys it instead of trashing it"
python3 - <<'PY'
p='packages/mail/src/threads.ts'; s=open(p).read()
s=s.replace("  if (policy.trash_days === 0) {","  if (true) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "trash is emptied before its time"
python3 - <<'PY'
p='packages/mail/src/threads.ts'; s=open(p).read()
s=s.replace("     where deleted_at is not null and purge_after is not null and purge_after < now()","     where deleted_at is not null")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "retention deletes even when no maximum is set"
python3 - <<'PY'
p='packages/mail/src/threads.ts'; s=open(p).read()
s=s.replace("  if (policy.retention_days !== null) {","  { const _ = policy.retention_days ?? 1;")
s=s.replace("      [policy.retention_days],","      [policy.retention_days ?? 1],")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "nobody is warned before retention deletes their mail — M39"
python3 - <<'PY'
p='packages/mail/src/threads.ts'; s=open(p).read()
s=s.replace("    return { retentionDays: policy.retention_days, affected: Number(row.affected), earliest: row.earliest };","    return { retentionDays: policy.retention_days, affected: 0, earliest: null };")
s=s.replace("""  return {
    retentionDays: policy.retention_days,
    affected: Number(row.affected),
    earliest: row.earliest,
  };""","""  return { retentionDays: policy.retention_days, affected: 0, earliest: null };""")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the admin metadata view joins in the message bodies — M38"
python3 - <<'PY'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("        `select s.id, u.username as initiated_by, s.recipient, s.status, s.attempts,","        `select m.subject, m.body_text, s.id, u.username as initiated_by, s.recipient, s.status, s.attempts,")
s=s.replace("         left join users u on u.id = s.initiating_user_id","         join email_messages m on m.id = s.message_id\n         left join users u on u.id = s.initiating_user_id")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "the admin may blank the disclosure through the API"
python3 - <<'PY'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("      if (disclosure && disclosure.length < 10) {","      if (false) {")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "mail is sent as whoever pressed the button, not the thread owner"
python3 - <<'PY'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("        `select display_name, username from users where id = $1`, [thread.owner_user_id],","        `select display_name, username from users where id = $1`, [req.user!.id],")
s=s.replace("        initiator: { id: thread.owner_user_id, name: person?.display_name ?? person?.username ?? '' },","        initiator: { id: req.user!.id, name: person?.display_name ?? person?.username ?? '' },")
open(p,'w').write(s)
PY
assert_mutated && run; restore; fi

if should_run; then mut "a colleague with write access can share the thread onward — M37"
python3 - <<'MUT'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("    '/threads/:id/share',\n    requireOwnership({ db }, { type: 'email_thread', need: 'owner' }),",
            "    '/threads/:id/share',\n    requireOwnership({ db }, { type: 'email_thread', need: 'write' }),",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "every share grants write, so a reader can send under the owner's name"
python3 - <<'MUT'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("      const canWriteShare = req.body?.canWrite === true;","      const canWriteShare = true;",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "unsharing does not actually revoke"
python3 - <<'MUT'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("      await unshareResource(db, {","      if (false) await unshareResource(db, {",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if should_run; then mut "a share may name a user who does not exist"
python3 - <<'MUT'
p='apps/api/src/http/mailRoutes.ts'; s=open(p).read()
s=s.replace("        if (!target) throw new RouteError(404, 'no such colleague');","        if (!target) { /* mutated */ }",1)
open(p,'w').write(s)
MUT
assert_mutated && run; restore; fi

if [[ "$M_TO" -ge 99 ]]; then
  echo; echo "=== RESTORED — full suite must be green ==="; run
fi
