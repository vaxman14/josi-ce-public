#!/usr/bin/env bash
# Phase 4 runtime verification: model configuration, capability probing, caps
# and Local-only mode, against the real container stack and real PostgreSQL.
#
# No hosted provider is contacted. A disposable stub container on the app's own
# network plays the part of a self-hosted runtime (Ollama, vLLM, LM Studio),
# which is what `openai_compatible` exists to support — so the probe is
# exercised end to end without an API key, a bill, or a network egress.
#
#   JOSI_HTTP_PORT=8392 JOSI_HTTPS_PORT=8555 PROJECT=josi-ce-phase4 \
#     bash scripts/test-llm-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase4}"
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
if "${COMPOSE[@]}" up -d --build >/tmp/p4-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p4-up.log
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

# ---------------------------------------------------------------------------
step "driving the wizard to a configured installation"
OWNER_PW='a-long-enough-password'
declare -a STEPS=(
  'host_checks|{}'
  "owner|{\"email\":\"owner@example.test\",\"username\":\"owner\",\"password\":\"$OWNER_PW\"}"
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
code=$(api POST /api/setup/complete '{}')
[[ "$code" == "200" ]] && ok "setup completed" || bad "completion returned $code"

step "signing in as the owner"
code=$(api POST /api/auth/login "{\"identifier\":\"owner\",\"password\":\"$OWNER_PW\"}")
SESSION=$("${COMPOSE[@]}" exec -T web sh -c "grep -io 'josi_session=[^;]*' /tmp/r.hdr | head -1" 2>/dev/null | tr -d '\r')
[[ "$code" == "200" && -n "$SESSION" ]] && ok "signed in" || bad "login returned $code (session: '${SESSION:0:14}')"

# ---------------------------------------------------------------------------
step "a model is not usable until it has been probed"
api GET /api/admin/llm >/dev/null
if has '"active":false'; then ok "the configured provider is inactive"; else bad "provider is active before any probe: $(body)"; fi
act=$(sql "select coalesce(activated_at::text,'NULL') from llm_providers where role='primary'")
[[ "$act" == "NULL" ]] && ok "activated_at is null in PostgreSQL" || bad "activated_at is $act"

api GET /api/llm/status >/dev/null
if has '"ready":false'; then ok "members are told Josi is not ready"; else bad "status claims ready: $(body)"; fi
if has 'No model has been tested yet'; then ok "every feature is disabled with an honest reason"; else bad "no reason given: $(body)"; fi

step "probing against the stub runtime"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
[[ "$code" == "200" ]] && ok "probe ran ($code)" || bad "probe returned $code: $(body)"
if has '"chat":true'; then ok "chat observed"; else bad "chat not observed: $(body)"; fi
if has '"toolCalling":true'; then ok "tool calling observed"; else bad "tool calling not observed"; fi
if has '"structuredOutput":true'; then ok "structured output observed"; else bad "structured output not observed"; fi
if has '"disabledFeatures":\[\]'; then ok "no feature is disabled"; else bad "features still disabled: $(body)"; fi

probed=$(sql "select cap_tool_calling from llm_providers where role='primary'")
[[ "$probed" == "t" ]] && ok "capabilities persisted to PostgreSQL" || bad "cap_tool_calling is '$probed'"

api GET /api/llm/status >/dev/null
if has '"ready":true'; then ok "members are now told Josi is ready"; else bad "status still not ready: $(body)"; fi

step "the probe recorded usage, and no prompt or reply with it"
calls=$(sql "select count(*) from llm_usage where purpose = 'probe'")
[[ "$calls" -ge 4 ]] && ok "usage recorded for each probe step ($calls rows)" || bad "$calls usage rows"
src=$(sql "select distinct cost_source from llm_usage")
[[ "$src" == "none" ]] && ok "self-hosted calls carry no provider charge" || bad "cost_source is '$src'"
cost=$(sql "select coalesce(sum(cost_usd),0) from llm_usage")
[[ "$cost" == "0" || "$cost" == "0.000000" ]] && ok "recorded cost is 0" || bad "recorded cost is $cost"
cols=$(sql "select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name='llm_usage'")
if echo "$cols" | grep -qE 'prompt|reply|message|body|content'; then
  bad "llm_usage has a column that could hold conversation text: $cols"
else
  ok "llm_usage has nowhere to put a prompt or a reply"
fi

# ---------------------------------------------------------------------------
step "cloud metadata is refused as an endpoint, in the real container"
code=$(api PUT /api/admin/llm/providers/primary '{"provider":"openai_compatible","model":"m","baseUrl":"http://169.254.169.254/v1"}')
[[ "$code" == "400" ]] && ok "metadata endpoint refused ($code)" || bad "metadata endpoint returned $code: $(body)"
code=$(api PUT /api/admin/llm/providers/primary '{"provider":"openai_compatible","model":"m","baseUrl":"http://[fd00:ec2::254]/v1"}')
[[ "$code" == "400" ]] && ok "IPv6 metadata endpoint refused ($code)" || bad "IPv6 metadata returned $code"

step "a self-hosted endpoint on the container network is allowed"
code=$(api PUT /api/admin/llm/providers/primary '{"provider":"openai_compatible","model":"stub-model","baseUrl":"http://fakemodel:8080/v1"}')
[[ "$code" == "200" ]] && ok "the stub runtime is accepted ($code)" || bad "returned $code: $(body)"
if has '"active":false'; then ok "reconfiguring cleared the previous probe"; else bad "probe result survived a reconfiguration"; fi

# ---------------------------------------------------------------------------
step "Local-only mode refuses a hosted provider server-side"
code=$(api PUT /api/admin/llm/local-only '{"enabled":true}')
[[ "$code" == "200" ]] && ok "Local-only turned on" || bad "returned $code: $(body)"
flag=$(sql "select local_only from security_policy where id = true")
[[ "$flag" == "t" ]] && ok "recorded in PostgreSQL" || bad "local_only is '$flag'"

# Not key-shaped, deliberately: see the note in apps/api/test/llm.test.ts.
SECRET='PHASE4-RUNTIME-FIXTURE-not-a-real-credential'
code=$(api PUT /api/admin/llm/providers/primary "{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"apiKey\":\"$SECRET\",\"externalAcknowledged\":true}")
[[ "$code" == "409" ]] && ok "a hosted provider is refused ($code)" || bad "hosted provider returned $code: $(body)"
hosted=$(sql "select count(*) from llm_providers where provider <> 'openai_compatible'")
[[ "$hosted" == "0" ]] && ok "nothing hosted was written" || bad "$hosted hosted rows exist"
leak=$(sql "select count(*) from llm_providers where api_key_enc like '%RUNTIME-FIXTURE%'")
[[ "$leak" == "0" ]] && ok "the refused key was not stored" || bad "the refused key was stored"

step "the probe still works while Local-only is on"
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
[[ "$code" == "200" ]] && ok "the self-hosted model can still be probed" || bad "probe returned $code: $(body)"

step "turning Local-only off, then storing a hosted key"
api PUT /api/admin/llm/local-only '{"enabled":false}' >/dev/null
code=$(api PUT /api/admin/llm/providers/fallback "{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"apiKey\":\"$SECRET\",\"externalAcknowledged\":true}")
[[ "$code" == "200" ]] && ok "hosted fallback accepted once Local-only is off" || bad "returned $code: $(body)"
enc=$(sql "select api_key_enc from llm_providers where role='fallback'")
case "$enc" in v1.*) ok "the key is sealed ciphertext in PostgreSQL" ;; *) bad "key not sealed: ${enc:0:16}" ;; esac
leak=$(sql "select count(*) from llm_providers where api_key_enc like '%RUNTIME-FIXTURE%'")
[[ "$leak" == "0" ]] && ok "the plaintext key is absent from the column" || bad "plaintext key present"

api GET /api/admin/llm >/dev/null
if body | grep -qE "$SECRET|v1\."; then bad "the config endpoint returned a key or ciphertext"; else ok "the config endpoint returns neither key nor ciphertext"; fi

step "the acknowledgment is required"
api PUT /api/admin/llm/local-only '{"enabled":false}' >/dev/null
code=$(api PUT /api/admin/llm/providers/fallback '{"provider":"anthropic","model":"claude-x","apiKey":"another-key-DO-NOT-USE","externalAcknowledged":false}')
[[ "$code" == "400" ]] && ok "a hosted provider without acknowledgment is refused ($code)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "caps stop work at 100%, in the real database"
api PUT /api/admin/llm/caps '{"monthlyTokens":100}' >/dev/null
api GET /api/admin/llm/usage >/dev/null
if has '"status":"blocked"'; then
  ok "the cap reports blocked once the probe's own tokens exceeded it"
else
  bad "cap status not blocked: $(body)"
fi
code=$(api POST /api/admin/llm/providers/primary/probe '{}')
[[ "$code" == "200" ]] && ok "the probe itself is exempt from the cap (it is not billed work)" || bad "probe returned $code"

code=$(api PUT /api/admin/llm/caps '{"monthlyCostUsd":0}')
[[ "$code" == "400" ]] && ok "a zero cap is refused rather than read as unlimited" || bad "zero cap returned $code"
api PUT /api/admin/llm/caps '{}' >/dev/null

step "subscription options are offered as unavailable"
api GET /api/admin/llm >/dev/null
if has '"available":true'; then bad "a subscription option is offered as available"; else ok "no subscription option is available"; fi
if has 'licensed for one person'; then ok "the reason is stated honestly"; else bad "no honest reason: $(body)"; fi

step "a member cannot administer the model"
member_pw='member-password-1234'
api POST /api/admin/users '{"email":"m@example.test","username":"member"}' >/dev/null
link=$(body | sed -n 's/.*token=\([A-Za-z0-9._-]*\).*/\1/p')
if [[ -n "$link" ]]; then
  api POST /api/auth/set-password "{\"token\":\"$link\",\"password\":\"$member_pw\"}" >/dev/null
  ADMIN_SESSION="$SESSION"
  api POST /api/auth/login "{\"identifier\":\"member\",\"password\":\"$member_pw\"}" >/dev/null
  SESSION=$("${COMPOSE[@]}" exec -T web sh -c "grep -io 'josi_session=[^;]*' /tmp/r.hdr | head -1" 2>/dev/null | tr -d '\r')
  code=$(api GET /api/admin/llm)
  [[ "$code" == "403" ]] && ok "a member is refused the model configuration ($code)" || bad "member got $code"
  code=$(api GET /api/llm/status)
  [[ "$code" == "200" ]] && ok "a member can still see what Josi can do" || bad "status returned $code"
  if body | grep -qE 'stub-model|openai|baseUrl|fakemodel'; then
    bad "the member status endpoint leaks the model configuration"
  else
    ok "the member status endpoint names neither provider nor model"
  fi
  SESSION="$ADMIN_SESSION"
else
  bad "could not create a member to test with"
fi

step "no secret appears in any container log"
if "${COMPOSE[@]}" logs 2>&1 | grep -qE "$SECRET|another-key-DO-NOT-USE|$OWNER_PW|fake-smtp-pw"; then
  bad "a secret appears in the logs"
else
  ok "no secret in any container log"
fi

step "the stub runtime was the only thing contacted"
# The stub logs nothing, so this asserts the negative that matters: the app
# never resolved or dialled a hosted provider hostname.
if "${COMPOSE[@]}" logs web 2>&1 | grep -qiE 'api\.openai\.com|api\.anthropic\.com|api\.x\.ai'; then
  bad "a hosted provider hostname appears in the web log"
else
  ok "no hosted provider was contacted"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
