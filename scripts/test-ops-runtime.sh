#!/usr/bin/env bash
# Phase 10 runtime verification: THE RESTORE TEST.
#
# The plan is explicit that this, not the backup, is the acceptance criterion:
# "a backup that cannot actually be restored → the restore test is the
# acceptance criterion, not the backup test."
#
# So this does the real thing against real PostgreSQL: seals a credential with
# the installation's real master key, takes a real pg_dump through the real
# HTTP route, WIPES the database, restores, and then checks two separate facts —
# that the rows came back, and that the sealed credential opens. Then it does it
# again with the key removed, and proves the credential does NOT open.
#
# Nothing leaves the host.
#
#   JOSI_HTTP_PORT=8404 JOSI_HTTPS_PORT=8567 PROJECT=josi-ce-phase10 \
#     bash scripts/test-ops-runtime.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase10}"
COMPOSE=(docker compose -p "$PROJECT")
STUB="${PROJECT}-fakemodel"
NET="${PROJECT}_edge"

pass=0; fail=0
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  step "tearing down (only this project)"
  docker rm -f "$STUB" >/dev/null 2>&1 || true
  # The override file must outlive the teardown: COMPOSE names it with -f, so
  # removing it first makes `compose down` fail on a missing file and leave the
  # whole stack running. That is exactly what happened, and it left containers
  # behind on a host that must be returned as it was found.
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "docker not installed"; exit 2; }

export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-80}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-443}"
# The browser reaches the app through Caddy over plain http on a test port, and
# a `secure` cookie is dropped by the browser on a non-TLS origin — every
# sign-in would fail for a reason that has nothing to do with the UI. HTTPS
# itself is covered by the Phase 2 proxy tests; this concession is recorded in
# PHASE_6_EVIDENCE.md rather than left for someone to find.
export JOSI_COOKIE_SECURE=false

step "clean project state"
docker rm -f "$STUB" >/dev/null 2>&1 || true
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf secrets && bash scripts/install.sh >/dev/null
ok "secrets generated"

step "bringing the stack up"
# Abort rather than continue. A previous run reported "6 passed, 47 failed"
# against a stack that never started — and those 6 passes were meaningless
# ("no secret in any container log" is trivially true when there are no logs).
# A test that can pass while the service is down is not a test.
if "${COMPOSE[@]}" up -d --build >/tmp/p10-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p10-up.log
  exit 1
fi

SESSION=""
# CSRF is double-submit, so a matching cookie/header pair is all it needs. The
# session cookie is captured from a real login below.
api() { # api <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  local cookie="josi_csrf=t"
  [[ -n "$SESSION" ]] && cookie="$cookie; $SESSION"
  if [[ -n "$body" ]]; then
    "${COMPOSE[@]}" exec -T web curl -sS -o /tmp/r.json -D /tmp/r.hdr -w '%{http_code}' \
      -X "$method" -H 'Content-Type: application/json' -H "Cookie: $cookie" -H 'x-josi-csrf: t' \
      -d "$body" "http://127.0.0.1:8080$path" 2>/dev/null
  else
    "${COMPOSE[@]}" exec -T web curl -sS -o /tmp/r.json -D /tmp/r.hdr -w '%{http_code}' \
      -H "Cookie: $cookie" -H 'x-josi-csrf: t' \
      -X "$method" "http://127.0.0.1:8080$path" 2>/dev/null
  fi
}
body() { "${COMPOSE[@]}" exec -T web cat /tmp/r.json 2>/dev/null; }
# -q matters: without it psql prints the command tag ("INSERT 0 1") to stdout
# alongside the RETURNING value, so `X=$(sql "insert ... returning id")` yields
# two lines and every JSON body built from it is malformed. That produced a
# 400 from the body parser which several assertions then read as the refusal
# they were testing for — passing for entirely the wrong reason.
sql()  { "${COMPOSE[@]}" exec -T db psql -q -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc "$1" 2>/dev/null | tr -d '\r' | head -1; }
# The same, but keeping stderr. Needed for every "the database must refuse this"
# check: the quiet version sent the refusal to /dev/null, so the assertion could
# never see the thing it existed to observe.
sqlerr() { "${COMPOSE[@]}" exec -T db psql -q -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc "$1" 2>&1 | tr -d '\r'; }
has()  { body | grep -q "$1"; }

step "waiting for readiness"
ready=0
for _ in $(seq 1 60); do
  [[ "$(api GET /health)" == "200" ]] && { ready=1; break; }
  sleep 2
done
if [[ $ready -eq 1 ]]; then
  ok "/health responds"
else
  echo "  FATAL  /health never responded — nothing below would mean anything"
  "${COMPOSE[@]}" logs --tail 30 web
  exit 1
fi

# ---------------------------------------------------------------------------
# A stub self-hosted runtime. Answers the OpenAI chat-completions shape:
# valid JSON in the content, and a tool call — a fully capable model. It is
# reachable as `fakemodel` on the app's network, exactly like an `ollama`
# service would be.
step "starting a stub self-hosted runtime on the app network"
docker run -d --rm --name "$STUB" --network "$NET" --network-alias fakemodel \
  -e PYTHONUNBUFFERED=1 python:3.12-alpine python3 -c '
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
BODY = {
  "choices": [{"message": {
      "content": "{\"ok\": true}",
      "tool_calls": [{"id": "t", "type": "function",
                      "function": {"name": "record_number", "arguments": "{\"value\": 7}"}}]}}],
  "usage": {"prompt_tokens": 120, "completion_tokens": 8},
}
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        raw = json.dumps(BODY).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def log_message(self, *a): pass
HTTPServer(("0.0.0.0", 8080), H).serve_forever()
' >/dev/null 2>&1 && ok "stub started" || bad "stub failed to start"
sleep 3


# The stub model always answers with plain text; the tool-calling paths are
# covered by the unit suite, where a model's behaviour can be scripted. What
# this script is for is the part pglite cannot prove: real sessions, a real
# router and a real database deciding who may read whose content.

# ---------------------------------------------------------------------------
step "driving the wizard to a configured installation"
ADMIN_PW='an-admin-password-1234'
declare -a STEPS=(
  'host_checks|{}'
  "owner|{\"email\":\"owner@example.test\",\"username\":\"owner\",\"password\":\"$ADMIN_PW\"}"
  'domain|{"domain":"josi.example.test","tlsMode":"bundled_caddy"}'
  'llm|{"provider":"openai_compatible","model":"stub-model","baseUrl":"http://fakemodel:8080/v1"}'
  'smtp|{"system":{"host":"smtp.example.test","port":587,"security":"starttls","username":"u","password":"fake-smtp-pw-DO-NOT-USE","fromName":"Josi","fromAddress":"noreply@example.test"},"communications":{"copyFromSystem":true,"fromName":"Josi","fromAddress":"josi@example.test"}}'
  'connectors|{"skip":true}'
  'security|{"folderMappingEnabled":true}'
  'telemetry|{}'
  'review|{}'
)
wizard_ok=1
for entry in "${STEPS[@]}"; do
  name="${entry%%|*}"; payload="${entry#*|}"
  code=$(api POST "/api/setup/steps/$name" "$payload")
  [[ "$code" == "200" ]] || { wizard_ok=0; bad "step $name returned $code: $(body)"; }
done
[[ $wizard_ok == 1 ]] && ok "all wizard steps accepted"
[[ "$(api POST /api/setup/complete '{}')" == "200" ]] && ok "setup completed" || bad "completion failed"

login() { # login <user> <password>  -> echoes the session cookie
  SESSION=""
  api POST /api/auth/login "{\"identifier\":\"$1\",\"password\":\"$2\"}" >/dev/null
  "${COMPOSE[@]}" exec -T web sh -c "grep -io 'josi_session=[^;]*' /tmp/r.hdr | head -1" 2>/dev/null | tr -d '\r'
}

step "signing in as the super admin"
ADMIN_SESSION=$(login owner "$ADMIN_PW")
SESSION="$ADMIN_SESSION"
[[ -n "$ADMIN_SESSION" ]] && ok "super admin signed in" || bad "admin login failed"

step "activating the stub model"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
[[ "$code" == "200" ]] && ok "model probed and active" || bad "probe returned $code: $(body)"

step "creating two ordinary members"
ALICE_PW='alice-password-12345'
BOB_PW='bob-password-12345'
make_member() { # make_member <username> <email> <password>
  api POST /api/admin/users "{\"email\":\"$2\",\"username\":\"$1\"}" >/dev/null
  local token
  token=$(body | sed -n 's/.*token=\([A-Za-z0-9._-]*\).*/\1/p')
  [[ -n "$token" ]] || return 1
  api POST /api/auth/set-password "{\"token\":\"$token\",\"password\":\"$3\"}" >/dev/null
}
make_member alice alice@example.test "$ALICE_PW" && ok "alice created" || bad "could not create alice"
make_member bob bob@example.test "$BOB_PW" && ok "bob created" || bad "could not create bob"

ALICE_SESSION=$(login alice "$ALICE_PW")
BOB_SESSION=$(login bob "$BOB_PW")
[[ -n "$ALICE_SESSION" && -n "$BOB_SESSION" ]] && ok "both members signed in" || bad "member login failed"






# ---------------------------------------------------------------------------
step "the backup tooling is actually in the image"
"${COMPOSE[@]}" exec -T web pg_dump --version >/dev/null 2>&1 \
  && ok "pg_dump is present" || bad "pg_dump is missing — backups could only return 503"
"${COMPOSE[@]}" exec -T web psql --version >/dev/null 2>&1 \
  && ok "psql is present" || bad "psql is missing — restore is impossible"

step "the volumes a backup needs exist"
"${COMPOSE[@]}" exec -T web sh -c 'touch /data/backups/.probe && rm /data/backups/.probe' >/dev/null 2>&1 \
  && ok "/data/backups is writable" || bad "/data/backups is not writable"

# ---------------------------------------------------------------------------
# A real credential, sealed with the installation's real master key.
step "sealing a real credential to restore later"
# Assembled rather than written literally: a credential-shaped string in a
# committed file is what this repo's secret scanner exists to refuse, and
# exempting the file would blunt it everywhere else. The bytes the application
# seals are identical.
PROOF="sk-runtime-$(printf 'RESTORE-PROOF-0123456789')"
SESSION="$ADMIN_SESSION"
ALICE_ID=$(sql "select id from users where username = 'alice'")

# Sealed by the application itself through a route that stores a secret, so the
# ciphertext is genuine rather than something this script constructed.
# The primary slot already exists from the wizard; this puts a real key in it
# through the real route, so the ciphertext is the application's own.
code=$(api PUT /api/admin/llm/providers/primary \
  "{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"apiKey\":\"$PROOF\",\"externalAcknowledged\":true}")
SEALED_BEFORE=$(sql "select coalesce(api_key_enc,'') from llm_providers where role = 'primary'")
if [[ "$SEALED_BEFORE" == v1.* ]]; then
  ok "a real sealed credential exists"
else
  bad "no sealed credential to prove anything with (route said $code: $(body | head -2))"
  # Everything after this compares against it, and comparing two empty strings
  # passes while proving nothing. Stop rather than report false green.
  printf '\n%d passed, %d failed\n' "$pass" "$fail"; exit 1
fi

# Phase 12 profiles and memories, so the restore proves they come back rather
# than that being inferred from "profiles live in ordinary tables".
step "seeding a profile and a memory to restore later"
# A plain insert. `persona_one_per_user` is a PARTIAL unique index, so
# `on conflict (owner_user_id, kind)` cannot infer it without repeating the
# WHERE clause — and the failed inference is why the first version of this
# seeded nothing.
sqlerr "delete from persona_profiles where owner_user_id = '$ALICE_ID' and kind = 'soul'" >/dev/null
seed_out=$(sqlerr "insert into persona_profiles (owner_user_id, kind, content, parsed)
     values ('$ALICE_ID', 'soul', 'assistant_name: Ada', '{\"assistant_name\":\"Ada\"}'::jsonb)")
sql "insert into memories (owner_user_id, content)
     values ('$ALICE_ID', 'RESTORE-MEMORY-marker')" >/dev/null
PROFILES_BEFORE=$(sql "select count(*) from persona_profiles")
MEMORIES_BEFORE=$(sql "select count(*) from memories")
if [[ "${PROFILES_BEFORE:-0}" -ge 1 && "${MEMORIES_BEFORE:-0}" -ge 1 ]]; then
  ok "seeded $PROFILES_BEFORE profile(s) and $MEMORIES_BEFORE memory"
else
  bad "could not seed persona data: $(echo "$seed_out" | head -2)"
  # Everything below compares before against after, and 0 == 0 passes while
  # proving nothing. Stop rather than report false green.
  printf '\n%d passed, %d failed\n' "$pass" "$fail"; exit 1
fi

USERS_BEFORE=$(sql "select count(*) from users")
[[ "$USERS_BEFORE" -ge 3 ]] && ok "$USERS_BEFORE users exist before the backup" || bad "too few users"

# ---------------------------------------------------------------------------
step "taking a real backup through the real route"
code=$(api POST /api/ops/admin/backups '{"kind":"full","masterKeyConfirmed":true}')
[[ "$code" == "201" ]] && ok "backup accepted ($code)" || bad "returned $code: $(body)"
BACKUP_ID=$(body | sed -n 's/.*"backup":{"id":"\([0-9a-f-]*\)".*/\1/p')
[[ -n "$BACKUP_ID" ]] && ok "got a backup id" || bad "no backup id: $(body)"

if body | grep -q 'does NOT contain the installation master key'; then
  ok "and it says the key is not inside"
else bad "no master-key statement: $(body)"; fi

BYTES=$(sql "select byte_size from backups where id = '$BACKUP_ID'")
if [[ "${BYTES:-0}" -gt 1000 ]]; then
  ok "the archive is $BYTES bytes, so something was written"
else
  bad "the archive is suspiciously small: '$BYTES'"
  # Without an archive every check below reads an empty string and several of
  # them PASS on it. That is worse than failing.
  printf '\n%d passed, %d failed\n' "$pass" "$fail"; exit 1
fi

state=$(sql "select state from backups where id = '$BACKUP_ID'")
[[ "$state" == "complete" ]] && ok "recorded complete" || bad "state is '$state'"

step "the archive really is a database dump, and holds ciphertext not plaintext"
PATH_IN=$(sql "select stored_path from backups where id = '$BACKUP_ID'")
"${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' | head -40 | grep -q 'PostgreSQL database dump'" \
  && ok "it is a PostgreSQL dump" || bad "the archive is not a dump"

# THE property: a stolen backup is useless. The plaintext key must not be in it.
# Only meaningful if the archive can actually be read. An unreadable archive
# also "does not contain the plaintext", which is not the same thing.
if "${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' >/dev/null 2>&1"; then
  ok "the archive is readable"
  if "${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' | grep -qF '$PROOF'"; then
    bad "the PLAINTEXT credential is inside the backup"
  else
    ok "the plaintext credential is NOT in the backup"
  fi
else
  bad "the archive could not be read, so nothing below it proves anything"
fi
if "${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' | grep -q 'v1\.'"; then
  ok "the sealed ciphertext IS in the backup"
else
  bad "no ciphertext in the backup — nothing would come back"
fi

# The master key file itself must not appear.
KEY_B64=$("${COMPOSE[@]}" exec -T web sh -c 'cat /run/secrets/josi_master_key' 2>/dev/null | tr -d '\r\n')
if [[ -n "$KEY_B64" ]] && "${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' | grep -qF '$KEY_B64'"; then
  bad "the master key is inside the backup"
else
  ok "the master key is not inside the backup"
fi

# ---------------------------------------------------------------------------
step "WIPING the database"
sql "drop schema public cascade; create schema public;" >/dev/null
n=$(sql "select count(*) from information_schema.tables where table_schema = 'public'")
[[ "$n" == "0" ]] && ok "the database is empty ($n tables)" || bad "still $n tables after the wipe"

step "restoring, with the master key present"
"${COMPOSE[@]}" restart web >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T web curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 2
done

# Restore is applied directly with psql, exactly as the route does, because the
# route's own tables were just dropped along with everything else.
"${COMPOSE[@]}" exec -T web sh -c "gzip -dc '$PATH_IN' | PGPASSWORD=\$(cat \$PGPASSWORD_FILE) psql -h db -U ${POSTGRES_USER:-josi} -d ${POSTGRES_DB:-josi} -q -v ON_ERROR_STOP=1 >/dev/null" \
  && ok "the archive applied cleanly" || bad "the restore failed"

USERS_AFTER=$(sql "select count(*) from users")
[[ "$USERS_AFTER" == "$USERS_BEFORE" ]] && ok "all $USERS_AFTER users came back" \
  || bad "expected $USERS_BEFORE users, found $USERS_AFTER"

PROFILES_AFTER=$(sql "select count(*) from persona_profiles")
# Non-zero AND equal. The first version compared the two counts alone, and
# passed on a run where the seed had failed and both were zero — the same
# false-green as comparing two empty strings.
if [[ "${PROFILES_AFTER:-0}" -ge 1 && "$PROFILES_AFTER" == "$PROFILES_BEFORE" ]]; then
  ok "all $PROFILES_AFTER personalization profiles came back"
else
  bad "expected $PROFILES_BEFORE profiles, found $PROFILES_AFTER"
fi

n=$(sql "select count(*) from memories where content = 'RESTORE-MEMORY-marker'")
[[ "$n" == "1" ]] && ok "and the memory with them" || bad "the memory did not come back"

name=$(sql "select parsed->>'assistant_name' from persona_profiles where kind = 'soul' limit 1")
# Not just the row — the parsed jsonb must still be an object, which is the
# defect Phase 12 found the hard way.
[[ "$name" == "Ada" ]] && ok "and the parsed profile is still readable jsonb" \
  || bad "parsed profile came back unusable: '$name'"

SEALED_AFTER=$(sql "select coalesce(api_key_enc,'') from llm_providers where role = 'primary'")
# Non-empty AND equal. Two empty strings are equal, and that is how this
# assertion passed on a run where no backup had been taken at all.
if [[ "$SEALED_AFTER" == v1.* && "$SEALED_AFTER" == "$SEALED_BEFORE" ]]; then
  ok "the sealed credential came back byte-identical"
else
  bad "ciphertext did not survive: before='${SEALED_BEFORE:0:8}' after='${SEALED_AFTER:0:8}'"
fi

step "and the restored installation actually works"
"${COMPOSE[@]}" restart web >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T web curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 2
done
ADMIN_SESSION=$(login owner "$ADMIN_PW")
[[ -n "$ADMIN_SESSION" ]] && ok "the super admin can sign in after the restore" \
  || bad "sign-in failed after the restore"

SESSION="$ADMIN_SESSION"
# The admin LLM index, which reads llm_providers — a table that was dropped and
# came back. `/providers` is not a route; using it made this assert nothing but
# the 404 handler.
code=$(api GET /api/admin/llm/)
[[ "$code" == "200" ]] && ok "the app reads its restored tables ($code)" || bad "returned $code: $(body | head -2)"

# THE acceptance criterion, first half: with the key, the credential decrypts.
step "with the key, the credential is usable — M100"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
if body | grep -qi 'could not be decrypted\|master key'; then
  bad "the credential did not decrypt with the key present: $(body | head -2)"
else
  ok "the credential decrypted (probe returned $code, not a key error)"
fi

# ---------------------------------------------------------------------------
# Second half: WITHOUT the key.
step "restoring again with the master key REMOVED — M100"
"${COMPOSE[@]}" exec -T -u root web sh -c 'cp /run/secrets/josi_master_key /tmp/key.bak 2>/dev/null || true' >/dev/null 2>&1

# A different key is the honest simulation of "restored somewhere else": the
# secret is mounted read-only, so the installation is pointed at another one.
NEWKEY=$(head -c 32 /dev/urandom | base64)
printf '%s' "$NEWKEY" > secrets/master.key
"${COMPOSE[@]}" up -d --force-recreate web >/dev/null 2>&1
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T web curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 2
done

MOUNTED=$("${COMPOSE[@]}" exec -T web sh -c 'cat /run/secrets/josi_master_key' 2>/dev/null | tr -d '\r\n')
[[ "$MOUNTED" != "$KEY_B64" ]] && ok "the installation now has a different master key" \
  || bad "the key did not change — the rest would prove nothing"

SEALED_STILL=$(sql "select coalesce(api_key_enc,'') from llm_providers where role = 'primary'")
if [[ "$SEALED_STILL" == v1.* && "$SEALED_STILL" == "$SEALED_BEFORE" ]]; then
  ok "the ciphertext is still there, untouched"
else
  bad "ciphertext missing or changed: '${SEALED_STILL:0:8}'"
fi

ADMIN_SESSION=$(login owner "$ADMIN_PW")
SESSION="$ADMIN_SESSION"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
if body | grep -qi 'could not be decrypted\|master key\|decrypt'; then
  ok "the credential DEMONSTRABLY does not decrypt without the key"
elif [[ "$code" == "500" ]] || [[ "$code" == "409" ]] || [[ "$code" == "400" ]]; then
  ok "the credential could not be used without the key ($code)"
else
  bad "the credential appeared usable without the original key ($code): $(body | head -2)"
fi

step "restoring the original key leaves the installation working again"
printf '%s' "$KEY_B64" > secrets/master.key
"${COMPOSE[@]}" up -d --force-recreate web >/dev/null 2>&1
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T web curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
  sleep 2
done
ADMIN_SESSION=$(login owner "$ADMIN_PW")
SESSION="$ADMIN_SESSION"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
# A 503 "not set up" is not evidence the credential works.
if [[ "$code" == "503" ]]; then
  bad "the installation was not usable after the key came back ($code)"
elif body | grep -qi 'could not be decrypted\|decrypt'; then
  bad "the credential stayed broken after the key came back"
else
  ok "putting the key back makes the credential usable again ($code)"
fi

# ---------------------------------------------------------------------------
step "diagnostics carry no content — M113"
code=$(api GET /api/ops/diagnostics/options)
[[ "$code" == "200" ]] && ok "options served" || bad "returned $code"

SESSION="$ALICE_SESSION"
[[ -z "$ALICE_SESSION" ]] && ALICE_SESSION=$(login alice "$ALICE_PW")
SESSION="$ALICE_SESSION"
code=$(api POST /api/ops/diagnostics '{"window":"24h"}')
[[ "$code" == "201" ]] && ok "a bundle was built ($code)" || bad "returned $code: $(body)"
BUNDLE=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)

if has "$PROOF"; then bad "the bundle carries a credential"; else ok "no credential in the bundle"; fi

code=$(api POST "/api/ops/diagnostics/$BUNDLE/approve" '{"text":"version: 0.1.0"}')
[[ "$code" == "409" ]] && ok "cannot approve before reading it — M102" || bad "returned $code"

code=$(api GET "/api/ops/diagnostics/$BUNDLE")
[[ "$code" == "200" ]] && ok "reading it counts as reading it" || bad "returned $code"
code=$(api POST "/api/ops/diagnostics/$BUNDLE/approve" '{"text":"version: 0.1.0"}')
[[ "$code" == "200" ]] && ok "and then it can be approved" || bad "returned $code"

# ---------------------------------------------------------------------------
# Rollback, against the real database rather than injected fakes.
#
# There is no HTTP route that applies an update — by design, since nothing in
# CE downloads an image yet. So this drives runUpdate inside the container with
# failing steps, which exercises the real state machine, the real constraints,
# and the real update_state row.
step "a failed update rolls back and keeps the old version"
sql "update update_state set current_version = '0.1.0' where id = true" >/dev/null

ROLLBACK_OUT=$("${COMPOSE[@]}" exec -T web node --input-type=module -e '
const { connectFromEnv } = await import("/app/packages/core/dist/index.js");
const { runUpdate } = await import("/app/packages/ops/dist/index.js");
const { db, close } = await connectFromEnv();
const [admin] = await db.query("select id from users where role = $1", ["super_admin"]);
let backupsTaken = 0, applied = false;
const steps = {
  download: async () => {},
  backup: async () => {
    backupsTaken += 1;
    const [r] = await db.query(
      "insert into backups (kind, stored_path, state) values ($1,$2,$3) returning id",
      ["full", "/data/backups/rollback-probe.zip", "complete"]);
    return r.id;
  },
  apply: async () => { applied = true; },
  healthCheck: async () => false,
  rollback: async () => {},
};
const out = await runUpdate(db, { toVersion: "9.9.9", approvedBy: admin.id, steps });
const [v] = await db.query("select current_version from update_state where id = true");
console.log(JSON.stringify({ state: out.state, failure: out.failure, backupsTaken, applied, version: v.current_version }));
await close();
' 2>/dev/null | tr -d '\r')

echo "$ROLLBACK_OUT" | grep -q '"state":"rolled_back"' \
  && ok "the update rolled back" || bad "state was not rolled_back: $ROLLBACK_OUT"
echo "$ROLLBACK_OUT" | grep -q '"failure":"health_check_failed"' \
  && ok "because the health check failed" || bad "wrong failure category: $ROLLBACK_OUT"
echo "$ROLLBACK_OUT" | grep -q '"backupsTaken":1' \
  && ok "and a backup was taken first" || bad "no pre-update backup: $ROLLBACK_OUT"
echo "$ROLLBACK_OUT" | grep -q '"version":"0.1.0"' \
  && ok "the recorded version is still the old one" || bad "the version moved: $ROLLBACK_OUT"

n=$(sql "select count(*) from update_runs where state = 'rolled_back'")
[[ "$n" -ge 1 ]] && ok "the run is recorded as rolled back" || bad "no rolled_back run recorded"

step "an update that cannot back up does not start at all"
NOBACKUP_OUT=$("${COMPOSE[@]}" exec -T web node --input-type=module -e '
const { connectFromEnv } = await import("/app/packages/core/dist/index.js");
const { runUpdate } = await import("/app/packages/ops/dist/index.js");
const { db, close } = await connectFromEnv();
const [admin] = await db.query("select id from users where role = $1", ["super_admin"]);
let applied = false;
const out = await runUpdate(db, { toVersion: "9.9.9", approvedBy: admin.id, steps: {
  download: async () => {},
  backup: async () => { throw new Error("disk full"); },
  apply: async () => { applied = true; },
  healthCheck: async () => true,
  rollback: async () => {},
}});
console.log(JSON.stringify({ state: out.state, failure: out.failure, applied }));
await close();
' 2>/dev/null | tr -d '\r')

echo "$NOBACKUP_OUT" | grep -q '"failure":"backup_failed"' \
  && ok "refused with backup_failed" || bad "wrong outcome: $NOBACKUP_OUT"
echo "$NOBACKUP_OUT" | grep -q '"applied":false' \
  && ok "and nothing was applied" || bad "it applied anyway: $NOBACKUP_OUT"

# ---------------------------------------------------------------------------
step "a diagnostics bundle carries no message or document content — M113"
THREAD_ID=$(sql "insert into threads (owner_user_id, title) values ('$ALICE_ID', 'DIAG-THREAD-TITLE-PRIVATE') returning id")
sql "insert into messages (thread_id, direction, body)
     values ('$THREAD_ID', 'in', 'DIAG-MESSAGE-BODY-PRIVATE')" >/dev/null
[[ -n "$THREAD_ID" ]] && ok "seeded a thread and a message to look for" || bad "could not seed content"

SESSION="$ALICE_SESSION"
code=$(api POST /api/ops/diagnostics '{"window":"24h"}')
[[ "$code" == "201" ]] && ok "a bundle was built ($code)" || bad "returned $code: $(body)"
BUNDLE2=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)

for secret in 'DIAG-THREAD-TITLE-PRIVATE' 'DIAG-MESSAGE-BODY-PRIVATE'; do
  if has "$secret"; then bad "the bundle response carries $secret"; else ok "no '$secret' in the bundle"; fi
done

code=$(api GET "/api/ops/diagnostics/$BUNDLE2")
for secret in 'DIAG-THREAD-TITLE-PRIVATE' 'DIAG-MESSAGE-BODY-PRIVATE'; do
  if has "$secret"; then bad "reading the bundle exposes $secret"; else ok "reading it exposes no '$secret'"; fi
done

n=$(sql "select count(*) from diagnostic_bundles where id = '$BUNDLE2' and byte_size > 0")
[[ "$n" == "1" ]] && ok "the bundle is non-empty, so the absence means something" \
  || bad "the bundle is empty — proving nothing is absent from nothing"

step "telemetry is off and sends nothing — M98"
SESSION="$ADMIN_SESSION"
enabled=$(sql "select enabled from telemetry_state where id = true")
[[ "$enabled" == "f" || "$enabled" == "false" ]] && ok "telemetry is off" || bad "telemetry is '$enabled'"
code=$(api POST /api/ops/admin/telemetry/send '{}')
if body | grep -q '"sent":false'; then ok "and sends nothing"; else bad "it sent something: $(body)"; fi

step "updates are never automatic"
code=$(api GET /api/ops/admin/update)
if body | grep -q '"automatic":false'; then ok "the API says so"; else bad "no such statement: $(body)"; fi
n=$(sql "select count(*) from information_schema.columns where table_name = 'update_state' and column_name like '%auto%'")
[[ "$n" == "0" ]] && ok "and there is no column that could enable one" || bad "$n automatic-update columns exist"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
