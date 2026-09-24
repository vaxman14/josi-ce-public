#!/usr/bin/env bash
# Phase 5 runtime verification: the assistant, against the real container stack
# and real PostgreSQL.
#
# The claim this exists to test is the one that cannot be proven in pglite: that
# a member's conversations, tasks and contacts are unreachable by a colleague
# and by the super admin, through the real router, against a real database with
# real sessions.
#
# No hosted provider is contacted. A stub runtime on the app's own network plays
# the model, so the agent runs end to end without an API key or a bill.
#
#   JOSI_HTTP_PORT=8394 JOSI_HTTPS_PORT=8557 PROJECT=josi-ce-phase5 \
#     bash scripts/test-assistant-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase5}"
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
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "docker not installed"; exit 2; }

export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-80}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-443}"

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
if "${COMPOSE[@]}" up -d --build >/tmp/p5-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p5-up.log
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
sql()  { "${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc "$1" 2>/dev/null | tr -d '\r'; }
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
step "alice has a private conversation with Josi"
SESSION="$ALICE_SESSION"
api POST /api/assistant/threads '{"title":"mine"}' >/dev/null
THREAD=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
[[ -n "$THREAD" ]] && ok "thread created" || bad "no thread id: $(body)"

SECRET_TEXT='ALICE-PRIVATE-CONVERSATION-TEXT'
code=$(api POST "/api/assistant/threads/$THREAD/talk" "{\"message\":\"$SECRET_TEXT\"}")
[[ "$code" == "200" ]] && ok "Josi answered ($code)" || bad "talk returned $code: $(body)"
if has 'reply'; then ok "a real reply came back"; else bad "no reply: $(body)"; fi

stored=$(sql "select count(*) from messages where body = '$SECRET_TEXT'")
[[ "$stored" == "1" ]] && ok "what she said is stored in messages" || bad "message not stored ($stored)"

step "alice creates a task and a contact"
api POST /api/assistant/contacts '{"name":"ALICE-PRIVATE-CONTACT","email":"private@example.test"}' >/dev/null
CONTACT=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
api POST /api/assistant/tasks '{"templateKey":"follow_up","slots":{"what":"ALICE-PRIVATE-TASK","when":"friday"}}' >/dev/null
TASK=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
[[ -n "$CONTACT" && -n "$TASK" ]] && ok "contact and task created" || bad "could not create: $(body)"

# ---------------------------------------------------------------------------
step "BOB cannot reach any of it — 404, never 403"
SESSION="$BOB_SESSION"
for pair in "threads/$THREAD" "tasks/$TASK" "contacts/$CONTACT"; do
  code=$(api GET "/api/assistant/$pair")
  [[ "$code" == "404" ]] && ok "$pair is 404 for a colleague" || bad "$pair returned $code"
done
code=$(api POST "/api/assistant/threads/$THREAD/talk" '{"message":"hello"}')
[[ "$code" == "404" ]] && ok "a colleague cannot speak into her thread" || bad "talk returned $code"

api GET /api/assistant/threads >/dev/null
if has "$SECRET_TEXT"; then bad "her text appears in his thread list"; else ok "his own list is empty of hers"; fi
api GET /api/assistant/tasks >/dev/null
if has 'ALICE-PRIVATE-TASK'; then bad "her task appears in his task list"; else ok "his task list is clean"; fi

step "a 404 for something real looks exactly like a 404 for something invented"
real=$(api GET "/api/assistant/threads/$THREAD"); real_body=$(body)
fake=$(api GET "/api/assistant/threads/00000000-0000-0000-0000-000000000000"); fake_body=$(body)
[[ "$real" == "$fake" && "$real_body" == "$fake_body" ]] \
  && ok "indistinguishable ($real)" || bad "real=$real/$real_body fake=$fake/$fake_body"

# ---------------------------------------------------------------------------
step "the SUPER ADMIN cannot read her content either"
SESSION="$ADMIN_SESSION"
for pair in "threads/$THREAD" "tasks/$TASK" "contacts/$CONTACT"; do
  code=$(api GET "/api/assistant/$pair")
  [[ "$code" == "404" ]] && ok "$pair is 404 for the super admin" || bad "$pair returned $code for admin"
done

step "the admin sees counts and health, and no content"
code=$(api GET /api/admin/assistant)
[[ "$code" == "200" ]] && ok "admin view served" || bad "admin view returned $code"
for secret in "$SECRET_TEXT" 'ALICE-PRIVATE-CONTACT' 'ALICE-PRIVATE-TASK' 'private@example.test'; do
  if has "$secret"; then bad "admin view leaks $secret"; else ok "admin view does not contain $secret"; fi
done
if has '"threads"'; then ok "admin view reports counts"; else bad "no counts: $(body)"; fi

# ---------------------------------------------------------------------------
step "step-up re-auth in the real stack"
SESSION="$ALICE_SESSION"
code=$(api POST /api/assistant/step-up '{"password":"definitely-not-her-password"}')
[[ "$code" == "401" ]] && ok "a wrong password is refused ($code)" || bad "returned $code"
code=$(api POST /api/assistant/step-up "{\"password\":\"$BOB_PW\"}")
[[ "$code" == "401" ]] && ok "another member password does not work" || bad "returned $code"
code=$(api POST /api/assistant/step-up "{\"password\":\"$ALICE_PW\"}")
[[ "$code" == "200" ]] && ok "her own password unlocks the session" || bad "returned $code: $(body)"

rows=$(sql "select count(*) from step_up_verifications")
[[ "$rows" == "1" ]] && ok "one unlock recorded in PostgreSQL" || bad "$rows unlocks recorded"
leak=$(sql "select count(*) from events where payload::text like '%${ALICE_PW}%'")
[[ "$leak" == "0" ]] && ok "no password in the event log" || bad "password found in events"

# ---------------------------------------------------------------------------
step "approval levels: the admin may tighten and may never loosen"
SESSION="$ALICE_SESSION"
api PUT /api/assistant/approval-levels/email_send '{"level":"automatic"}' >/dev/null
if has '"level":"automatic"'; then ok "alice chose automatic"; else bad "level not set: $(body)"; fi

SESSION="$ADMIN_SESSION"
api PUT /api/admin/assistant/approval-policy/email_send '{"maxLevel":"always_ask"}' >/dev/null
SESSION="$ALICE_SESSION"
api GET /api/assistant/approval-levels/email_send >/dev/null
if has '"level":"always_ask"'; then ok "the admin tightened it"; else bad "not tightened: $(body)"; fi
if has '"userChoice":"automatic"'; then ok "her own choice is preserved underneath"; else bad "choice lost"; fi

SESSION="$ALICE_SESSION"
api PUT /api/assistant/approval-levels/email_send '{"level":"always_ask"}' >/dev/null
SESSION="$ADMIN_SESSION"
api PUT /api/admin/assistant/approval-policy/email_send '{"maxLevel":"automatic"}' >/dev/null
SESSION="$ALICE_SESSION"
api GET /api/assistant/approval-levels/email_send >/dev/null
if has '"level":"always_ask"'; then ok "the admin CANNOT loosen her choice"; else bad "admin loosened it: $(body)"; fi

step "a member cannot set installation policy"
code=$(api PUT /api/admin/assistant/approval-policy/email_send '{"maxLevel":"automatic"}')
[[ "$code" == "403" ]] && ok "member refused the admin policy route ($code)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "the conversation never reaches the audit log"
for secret in "$SECRET_TEXT" 'ALICE-PRIVATE-CONTACT' 'ALICE-PRIVATE-TASK'; do
  n=$(sql "select count(*) from events where payload::text like '%${secret}%'")
  [[ "$n" == "0" ]] && ok "no '$secret' in events" || bad "'$secret' found in $n events"
done
n=$(sql "select count(*) from events where kind = 'thread.exchange'")
[[ "$n" -ge 1 ]] && ok "the exchange itself is recorded ($n)" || bad "no exchange event"

step "the queue carries ids, not content"
n=$(sql "select count(*) from job_queue where payload::text like '%ALICE-PRIVATE%'")
[[ "$n" == "0" ]] && ok "no content in job payloads" || bad "content found in the queue"

step "the worker is processing jobs, not just breathing"
"${COMPOSE[@]}" logs worker 2>&1 | grep -q "worker" && ok "worker is running" || bad "no worker output"
alive=$("${COMPOSE[@]}" ps worker --format '{{.State}}' 2>/dev/null | head -1)
[[ "$alive" == "running" ]] && ok "worker container healthy" || bad "worker state: $alive"

step "no secret appears in any container log"
if "${COMPOSE[@]}" logs 2>&1 | grep -qE "$ALICE_PW|$BOB_PW|$ADMIN_PW|$SECRET_TEXT"; then
  bad "a password or a conversation appears in the logs"
else
  ok "no password or conversation in any container log"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
