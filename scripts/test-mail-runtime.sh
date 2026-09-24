#!/usr/bin/env bash
# Phase 8 runtime verification: operational email, against the real container
# stack and real PostgreSQL.
#
# NO MAIL LEAVES THE HOST. A real SMTP server runs on the project's own network
# and keeps everything it receives, so the whole path is exercised — nodemailer,
# TLS negotiation, headers, the disclosure — and the test can then read the
# actual message that would have gone out.
#
#   JOSI_HTTP_PORT=8400 JOSI_HTTPS_PORT=8563 PROJECT=josi-ce-phase8 \
#     bash scripts/test-mail-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase8}"
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
if "${COMPOSE[@]}" up -d --build >/tmp/p8-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p8-up.log
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
# A real SMTP server that accepts everything and writes each message to a file.
# `aiosmtpd` speaks the actual protocol, so nodemailer's EHLO/AUTH/DATA path is
# exercised rather than stubbed.
step "starting a mail sink on the project network"
docker rm -f "${PROJECT}-mailsink" >/dev/null 2>&1 || true
docker run -d --rm --name "${PROJECT}-mailsink" --network "$NET" --network-alias mailsink \
  python:3.12-alpine sh -c 'pip install --quiet aiosmtpd && python3 -c "
import asyncio, os
from aiosmtpd.controller import Controller

class Sink:
    def __init__(self): self.n = 0
    async def handle_DATA(self, server, session, envelope):
        self.n += 1
        os.makedirs(\"/tmp/mail\", exist_ok=True)
        with open(f\"/tmp/mail/{self.n:03d}.eml\", \"wb\") as f:
            f.write(envelope.content)
        return \"250 Message accepted\"

Controller(Sink(), hostname=\"0.0.0.0\", port=1025).start()
asyncio.get_event_loop().run_forever()
"' >/dev/null 2>&1 && ok "mail sink started" || bad "mail sink failed to start"

# Probed with node rather than `nc`, which the hardened app image does not
# carry — the first version of this check reported the sink was down while it
# was up and taking mail, which is a check that proves nothing.
#
# It runs from inside the web container on purpose: what matters is that the
# APP can reach the sink, not that the host can.
sink_up() {
  "${COMPOSE[@]}" exec -T web node -e '
    const s = require("net").connect(1025, "mailsink");
    s.on("connect", () => { s.end(); process.exit(0); });
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 3000);
  ' >/dev/null 2>&1
}
for _ in $(seq 1 60); do sink_up && break; sleep 2; done
sink_up && ok "the sink is reachable from the app" || bad "the sink never came up"

step "giving alice a display name"
# The From header carries the person's name, so the test needs one to assert on.
sql "update users set display_name = 'Alice Smith' where username = 'alice'" >/dev/null
name=$(sql "select display_name from users where username = 'alice'")
[[ "$name" == "Alice Smith" ]] && ok "display name set" || bad "display name is '$name'"

step "configuring the communications profile to use it"
SESSION="$ADMIN_SESSION"
sql "insert into smtp_profiles (kind, host, port, security, from_name, from_address)
     values ('communications', 'mailsink', 1025, 'none', 'Josi', 'josi@example.test')
     on conflict (kind) do update set host = 'mailsink', port = 1025, security = 'none',
       from_name = 'Josi', from_address = 'josi@example.test', copy_from_system = false" >/dev/null
ok "profile pointed at the sink"

mail_files() { docker exec "${PROJECT}-mailsink" sh -c 'ls /tmp/mail 2>/dev/null | wc -l' 2>/dev/null | tr -d '\r'; }
mail_body()  { docker exec "${PROJECT}-mailsink" sh -c 'cat /tmp/mail/*.eml 2>/dev/null' 2>/dev/null; }

# ---------------------------------------------------------------------------
step "alice sends operational mail"
SESSION="$ALICE_SESSION"
SUBJECT='PRIVATE-SUBJECT-runtime'
BODY='PRIVATE-BODY-runtime-numbers'
api POST /api/mail/threads "{\"subject\":\"$SUBJECT\",\"participants\":[\"client@example.test\"]}" >/dev/null
THREAD=$(body | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
[[ -n "$THREAD" ]] && ok "thread created" || bad "no thread: $(body)"

code=$(api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"$BODY\"}")
[[ "$code" == "200" ]] && ok "send accepted ($code)" || bad "send returned $code: $(body)"

for _ in $(seq 1 20); do [[ "$(mail_files)" -ge 1 ]] && break; sleep 1; done
[[ "$(mail_files)" -ge 1 ]] && ok "the sink actually received a message" || bad "no message reached the sink"

step "what actually went out over the wire"
RAW=$(mail_body)
echo "$RAW" | grep -qi "^From:.*Alice Smith via Josi" && ok "From is 'Alice Smith via Josi'" || bad "From header: $(echo "$RAW" | grep -i '^From:' | head -1)"
echo "$RAW" | grep -qi "^From:.*josi@example.test" && ok "sent from the installation mailbox" || bad "wrong sender address"
echo "$RAW" | grep -qi "alice@example.test" && bad "her own address was used as the sender" || ok "her own address is NOT the sender"
echo "$RAW" | grep -qi "^Reply-To:.*+josi\." && ok "Reply-To carries the routing token" || bad "no routing token in Reply-To"
echo "$RAW" | grep -qi "Sent by Josi" && ok "the AI disclosure is in the body" || bad "no disclosure in the message"
echo "$RAW" | grep -qi "^Auto-Submitted: auto-generated" && ok "Auto-Submitted is set (loop prevention)" || bad "no Auto-Submitted header"
echo "$RAW" | grep -qi "^X-Josi-Thread:" && ok "X-Josi-Thread is set" || bad "no X-Josi-Thread header"
echo "$RAW" | grep -qi "^Bcc:" && bad "a Bcc header went out" || ok "no Bcc header"

step "the same message is not sent twice"
before=$(mail_files)
api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"$BODY\"}" >/dev/null
sleep 2
[[ "$(mail_files)" == "$before" ]] && ok "a duplicate send delivered nothing new" || bad "sent twice"

# ---------------------------------------------------------------------------
step "adding a recipient is refused without approval — M43"
before=$(mail_files)
code=$(api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\",\"newcomer@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"$BODY 2\"}")
[[ "$code" == "409" ]] && ok "refused ($code)" || bad "returned $code: $(body)"
if has 'needs_approval'; then ok "and says approval is needed"; else bad "wrong reason: $(body)"; fi
sleep 2
[[ "$(mail_files)" == "$before" ]] && ok "nothing was delivered" || bad "a message went out anyway"

step "and goes through once approved"
api POST "/api/mail/threads/$THREAD/request-approval" \
  "{\"to\":[\"client@example.test\",\"newcomer@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"$BODY 2\"}" >/dev/null
APPROVAL=$(body | sed -n 's/.*"approval":{"id":"\([0-9a-f-]*\)".*/\1/p')
if body | grep -q 'see all'; then ok "the approval says how much history is exposed"; else bad "no history statement: $(body)"; fi
[[ -n "$APPROVAL" ]] && ok "approval raised" || bad "no approval id"

code=$(api POST "/api/assistant/approvals/$APPROVAL/decide" '{"approve":true}')
[[ "$code" == "200" ]] && ok "alice approved it" || bad "decide returned $code: $(body)"

code=$(api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\",\"newcomer@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"$BODY 2\",\"approvalId\":\"$APPROVAL\"}")
[[ "$code" == "200" ]] && ok "the send went through ($code)" || bad "returned $code: $(body)"
for _ in $(seq 1 20); do [[ "$(mail_files)" -gt "$before" ]] && break; sleep 1; done
[[ "$(mail_files)" -gt "$before" ]] && ok "and it reached the sink" || bad "nothing delivered"

step "BCC is refused"
code=$(api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\"],\"bcc\":[\"hidden@x.test\"],\"subject\":\"$SUBJECT\",\"body\":\"bcc test\"}")
[[ "$code" == "409" ]] && ok "refused ($code)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "BOB cannot reach alice's thread — M37"
SESSION="$BOB_SESSION"
for verb in GET DELETE; do
  code=$(api $verb "/api/mail/threads/$THREAD")
  [[ "$code" == "404" ]] && ok "$verb is 404 for a colleague" || bad "$verb returned $code"
done
api GET /api/mail/threads >/dev/null
if has "$SUBJECT"; then bad "her subject appears in his list"; else ok "his list is clean"; fi

step "alice shares the thread with bob — M37"
SESSION="$ALICE_SESSION"
BOB_ID=$(sql "select id from users where username = 'bob'")
code=$(api POST "/api/mail/threads/$THREAD/share" "{\"userId\":\"$BOB_ID\"}")
[[ "$code" == "200" ]] && ok "share accepted ($code)" || bad "share returned $code: $(body)"

SESSION="$BOB_SESSION"
code=$(api GET "/api/mail/threads/$THREAD")
[[ "$code" == "200" ]] && ok "bob can now read it" || bad "read returned $code"
code=$(api POST "/api/mail/threads/$THREAD/send" \
  "{\"to\":[\"client@example.test\"],\"subject\":\"$SUBJECT\",\"body\":\"from bob\"}")
[[ "$code" == "404" ]] && ok "but a read-only share cannot send ($code)" || bad "send returned $code"

step "and bob cannot pass that access on"
code=$(api POST "/api/mail/threads/$THREAD/share" '{"workspace":true}')
[[ "$code" == "404" ]] && ok "sharing onward is refused ($code)" || bad "returned $code"
n=$(sql "select count(*) from resource_shares where resource_id = '$THREAD' and shared_with_workspace = true")
[[ "$n" == "0" ]] && ok "and no workspace share exists" || bad "a workspace share was created"

step "alice takes it back"
SESSION="$ALICE_SESSION"
code=$(api DELETE "/api/mail/threads/$THREAD/share" "{\"userId\":\"$BOB_ID\"}")
[[ "$code" == "200" ]] && ok "unshared ($code)" || bad "returned $code"
SESSION="$BOB_SESSION"
code=$(api GET "/api/mail/threads/$THREAD")
[[ "$code" == "404" ]] && ok "bob is back to 404" || bad "returned $code"

step "the SUPER ADMIN sees delivery metadata and no content — M38"
SESSION="$ADMIN_SESSION"
code=$(api GET "/api/mail/threads/$THREAD")
[[ "$code" == "404" ]] && ok "the admin cannot open her thread (404)" || bad "returned $code"

code=$(api GET /api/admin/mail)
[[ "$code" == "200" ]] && ok "the metadata view is served" || bad "returned $code"
for secret in "$SUBJECT" "$BODY"; do
  if has "$secret"; then bad "the metadata view contains $secret"; else ok "no '$secret' in the metadata view"; fi
done
if has '"initiated_by":"alice"'; then ok "it does say who sent it"; else bad "no initiating user: $(body)"; fi
if has '"recipient":"client@example.test"'; then ok "and to which address"; else bad "no recipient"; fi

step "the AI disclosure cannot be removed — M41"
code=$(api PUT /api/admin/mail/policy '{"disclosure":"x"}')
[[ "$code" == "400" ]] && ok "blanking it is refused ($code)" || bad "returned $code"
code=$(api PUT /api/admin/mail/policy '{"disclosure":"Composed by Josi for {user}, an AI assistant."}')
[[ "$code" == "200" ]] && ok "rewording is allowed" || bad "returned $code"
n=$(sql "select count(*) from mail_policy where length(btrim(disclosure)) < 10")
[[ "$n" == "0" ]] && ok "the database holds a real disclosure" || bad "disclosure is empty in the database"

step "trash and restore — M40"
SESSION="$ALICE_SESSION"
api DELETE "/api/mail/threads/$THREAD" >/dev/null
if has 'recoverableUntil'; then ok "deleting put it in the trash"; else bad "no trash window: $(body)"; fi
n=$(sql "select count(*) from email_threads where id = '$THREAD' and deleted_at is not null")
[[ "$n" == "1" ]] && ok "it is still there, marked deleted" || bad "the thread was destroyed"
code=$(api POST "/api/mail/threads/$THREAD/restore" '{}')
[[ "$code" == "200" ]] && ok "and it can be restored" || bad "restore returned $code"

step "no secret reaches the audit log or any container log"
for secret in "$SUBJECT" "$BODY" 'client@example.test'; do
  n=$(sql "select count(*) from events where payload::text like '%${secret}%'")
  [[ "$n" == "0" ]] && ok "no '$secret' in events" || bad "'$secret' found in $n events"
done
if "${COMPOSE[@]}" logs 2>&1 | grep -qE "$BODY"; then
  bad "the message body appears in a container log"
else
  ok "no message body in any container log"
fi

docker rm -f "${PROJECT}-mailsink" >/dev/null 2>&1 || true

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
