#!/usr/bin/env bash
# Phase 3 runtime verification: drive the real wizard against real PostgreSQL
# in the real container stack.
#
# The unit suite runs against pglite, which serialises queries. This does not —
# so the concurrency guards are exercised against a database that can genuinely
# run two statements at once.
#
#   JOSI_HTTP_PORT=8380 JOSI_HTTPS_PORT=8543 scripts/test-setup-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase3}"
COMPOSE=(docker compose -p "$PROJECT")

pass=0; fail=0
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  step "tearing down (only this project)"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || { echo "docker not installed"; exit 2; }

export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-80}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-443}"

step "clean project state"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf secrets && bash scripts/install.sh >/dev/null
ok "secrets generated"

step "bringing the stack up"
if "${COMPOSE[@]}" up -d --build >/tmp/p3-up.log 2>&1; then ok "compose up"; else bad "compose up failed"; tail -20 /tmp/p3-up.log; fi

# `web` runs with a read-only rootfs and no shell tooling beyond curl, which is
# all this needs.
api() { # api <method> <path> [json]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    "${COMPOSE[@]}" exec -T web curl -sS -o /tmp/r.json -w '%{http_code}' \
      -X "$method" -H 'Content-Type: application/json' -H 'Cookie: josi_csrf=t' -H 'x-josi-csrf: t' \
      -d "$body" "http://127.0.0.1:8080$path" 2>/dev/null
  else
    "${COMPOSE[@]}" exec -T web curl -sS -o /tmp/r.json -w '%{http_code}' \
      -H 'Cookie: josi_csrf=t' -H 'x-josi-csrf: t' \
      -X "$method" "http://127.0.0.1:8080$path" 2>/dev/null
  fi
}
body() { "${COMPOSE[@]}" exec -T web cat /tmp/r.json 2>/dev/null; }
sql()  { "${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc "$1" 2>/dev/null | tr -d '\r'; }

step "waiting for readiness"
ready=0
for _ in $(seq 1 60); do
  [[ "$(api GET /health)" == "200" ]] && { ready=1; break; }
  sleep 2
done
[[ $ready -eq 1 ]] && ok "/health responds" || bad "/health never responded"

step "before setup: only the wizard is reachable"
[[ "$(api GET /api/setup/state)" == "200" ]] && ok "setup state is served" || bad "setup state unavailable"
for p in /api/auth/me /api/auth/csrf /api/connections /api/admin/users /api/admin/workspace; do
  code=$(api GET "$p")
  [[ "$code" == "503" ]] && ok "refused $p ($code)" || bad "$p returned $code, expected 503"
done

step "driving the wizard"
declare -a STEPS=(
  'host_checks|{}'
  "owner|{\"email\":\"owner@example.test\",\"username\":\"owner\",\"password\":\"a-long-enough-password\",\"role\":\"member\"}"
  'domain|{"domain":"josi.example.test","tlsMode":"bundled_caddy"}'
  'llm|{"provider":"openai","model":"gpt-4o-mini","apiKey":"fake-runtime-key-DO-NOT-USE","externalAcknowledged":true}'
  'smtp|{"system":{"host":"smtp.example.test","port":587,"security":"starttls","username":"u","password":"fake-smtp-pw-DO-NOT-USE","fromName":"Josi","fromAddress":"noreply@example.test"},"communications":{"copyFromSystem":true,"fromName":"Josi","fromAddress":"josi@example.test"}}'
  'connectors|{"skip":true}'
  'security|{"folderMappingEnabled":true}'
  'telemetry|{}'
  'review|{}'
)
for entry in "${STEPS[@]}"; do
  name="${entry%%|*}"; payload="${entry#*|}"
  code=$(api POST "/api/setup/steps/$name" "$payload")
  [[ "$code" == "200" ]] && ok "step $name accepted" || bad "step $name returned $code: $(body)"
done

step "step ordering is enforced by the server"
code=$(api POST /api/setup/steps/owner '{"email":"x@y.test","username":"x","password":"a-long-enough-password"}')
[[ "$code" == "409" ]] && ok "replaying a completed step is refused ($code)" || bad "replay returned $code"

step "authority fields in the body changed nothing"
role=$(sql "select role from users limit 1")
[[ "$role" == "super_admin" ]] && ok "owner is super_admin despite body claiming member" || bad "role is $role"
count=$(sql "select count(*) from users")
[[ "$count" == "1" ]] && ok "exactly one user exists" || bad "$count users"

step "secrets are ciphertext in real PostgreSQL"
enc=$(sql "select api_key_enc from llm_providers where role='primary'")
case "$enc" in
  v1.*) ok "LLM key stored as sealed ciphertext" ;;
  *)    bad "LLM key not sealed: ${enc:0:20}" ;;
esac
leak=$(sql "select count(*) from llm_providers where api_key_enc like '%fake-runtime-key%'")
[[ "$leak" == "0" ]] && ok "plaintext LLM key absent from the column" || bad "plaintext present"
smtp_enc=$(sql "select password_enc from smtp_profiles where kind='system'")
case "$smtp_enc" in v1.*) ok "SMTP password sealed" ;; *) bad "SMTP password not sealed" ;; esac
comms_enc=$(sql "select coalesce(password_enc,'NULL') from smtp_profiles where kind='communications'")
[[ "$comms_enc" == "NULL" ]] && ok "copy-from-system stores no duplicate credential" || bad "duplicate credential stored"

step "secrets absent from container logs"
if "${COMPOSE[@]}" logs 2>&1 | grep -qE 'fake-runtime-key|fake-smtp-pw|a-long-enough-password'; then
  bad "a secret appears in the logs"
else
  ok "no secret in any container log"
fi

step "telemetry defaulted off"
tel=$(sql "select enabled from telemetry_state where id = true")
[[ "$tel" == "f" ]] && ok "telemetry is off (was omitted)" || bad "telemetry is $tel"

step "review exposes no secret"
api GET /api/setup/review >/dev/null
if body | grep -qE 'fake-runtime-key|fake-smtp-pw|a-long-enough-password|v1\.'; then
  bad "review response contains a secret or ciphertext"
else
  ok "review response is redacted"
fi

step "CONCURRENT completion against real PostgreSQL"
# pglite serialises, so this is the only place the latch meets genuine
# concurrency. Five simultaneous finishers; exactly one must win.
codes=$("${COMPOSE[@]}" exec -T web sh -c '
  for i in 1 2 3 4 5; do
    curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
      -H "Content-Type: application/json" -H "Cookie: josi_csrf=t" -H "x-josi-csrf: t" \
      -d "{}" http://127.0.0.1:8080/api/setup/complete &
  done
  wait' 2>/dev/null | sort | tr '\n' ' ')
wins=$(echo "$codes" | tr ' ' '\n' | grep -c '^200$')
[[ "$wins" == "1" ]] && ok "exactly one completion won (codes: $codes)" || bad "$wins winners (codes: $codes)"

admins=$(sql "select count(*) from users where role='super_admin'")
[[ "$admins" == "1" ]] && ok "still exactly one super admin" || bad "$admins super admins"

step "after completion the wizard is gone"
for p in /api/setup/state /api/setup/host-checks /api/setup/review; do
  code=$(api GET "$p")
  [[ "$code" == "404" ]] && ok "$p is 404" || bad "$p returned $code"
done
code=$(api POST /api/setup/complete '{}')
[[ "$code" == "404" ]] && ok "complete is 404" || bad "complete returned $code"
code=$(api GET /api/auth/csrf)
[[ "$code" == "200" ]] && ok "the application is now reachable" || bad "app returned $code"

step "completion survives a restart and does not reopen"
"${COMPOSE[@]}" restart web >/dev/null 2>&1
for _ in $(seq 1 40); do [[ "$(api GET /health)" == "200" ]] && break; sleep 2; done
code=$(api GET /api/setup/state)
[[ "$code" == "404" ]] && ok "wizard still gone after restart" || bad "wizard returned $code after restart"
admins=$(sql "select count(*) from users where role='super_admin'")
[[ "$admins" == "1" ]] && ok "still one super admin after restart" || bad "$admins super admins"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
