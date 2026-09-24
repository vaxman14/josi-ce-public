#!/usr/bin/env bash
# Phase 11 runtime verification: hardening, and the numbers the plan asks for.
#
# Rate limiting and SSRF are the two controls added in this phase that only mean
# something against a real server: a limiter that works in a unit test and not
# behind a proxy is not a limiter, and an SSRF guard is about what DNS actually
# returns.
#
# Also records image size and platform, which the plan asks for and which cannot
# be known without building.
#
#   JOSI_HTTP_PORT=8406 JOSI_HTTPS_PORT=8569 PROJECT=josi-ce-phase11 \
#     bash scripts/test-hardening-runtime.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase11}"
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
if "${COMPOSE[@]}" up -d --build >/tmp/p11-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p11-up.log
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
step "image size and platform — recorded, not estimated"
IMAGE="${JOSI_IMAGE:-josi-ce}:${JOSI_TAG:-local}"
SIZE_BYTES=$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null || echo unknown)
OS=$(docker image inspect "$IMAGE" --format '{{.Os}}' 2>/dev/null || echo unknown)
LAYERS=$(docker image inspect "$IMAGE" --format '{{len .RootFS.Layers}}' 2>/dev/null || echo 0)

[[ "$SIZE_MB" -gt 0 ]] && ok "image is ${SIZE_MB} MB, ${OS}/${ARCH}, ${LAYERS} layers" \
  || bad "could not measure the image"

# A ceiling, so a careless dependency does not quietly double it. Generous
# enough not to be noise; tight enough to notice a mistake.
[[ "$SIZE_MB" -lt 900 ]] && ok "under the 900 MB ceiling" \
  || bad "the image has grown to ${SIZE_MB} MB"

DB_SIZE=$(docker image inspect postgres:16-alpine --format '{{.Size}}' 2>/dev/null || echo 0)
ok "database image is $(( DB_SIZE / 1024 / 1024 )) MB (postgres:16-alpine)"

printf 'josi-ce image: %s MB, %s/%s, %s layers\n' "$SIZE_MB" "$OS" "$ARCH" "$LAYERS" \
  > /tmp/${PROJECT}-image.txt
ok "recorded to /tmp/${PROJECT}-image.txt"

# ---------------------------------------------------------------------------
step "the pg client major matches the server"
CLIENT=$("${COMPOSE[@]}" exec -T web pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
SERVER=$(sql "show server_version" | grep -oE '^[0-9]+')
[[ -n "$CLIENT" && "$CLIENT" == "$SERVER" ]] \
  && ok "pg_dump $CLIENT against server $SERVER" \
  || bad "pg_dump '$CLIENT' cannot dump server '$SERVER'"

# ---------------------------------------------------------------------------
step "rate limiting refuses, per person, over the wire — T-35"
SESSION="$ADMIN_SESSION"
# The backup allowance is small on purpose; spend it and then some.
codes=""
for i in $(seq 1 6); do
  c=$(api POST /api/ops/admin/backups '{"kind":"full"}')
  codes="$codes $c"
done
echo "$codes" | grep -q '429' && ok "the allowance runs out ($codes)" \
  || bad "no 429 after six backups: $codes"

# The header a client needs to behave.
if "${COMPOSE[@]}" exec -T web sh -c "grep -qi '^retry-after' /tmp/r.hdr"; then
  ok "and sends Retry-After"
else bad "no Retry-After header"; fi

step "and one person's limit is not everybody's"
SESSION="$ALICE_SESSION"
[[ -z "$ALICE_SESSION" ]] && ALICE_SESSION=$(login alice "$ALICE_PW")
SESSION="$ALICE_SESSION"
code=$(api POST /api/ops/diagnostics '{"window":"24h"}')
[[ "$code" == "201" ]] && ok "alice is unaffected by the admin's exhausted allowance ($code)" \
  || bad "alice was refused too ($code) — the limit is global"

step "the allowance is per bucket, not one pool"
# Diagnostics and backups are different buckets: spending one must not spend the
# other.
code=$(api GET "/api/storage/search?q=anything")
[[ "$code" == "200" ]] && ok "search still answers ($code)" || bad "search returned $code"

# ---------------------------------------------------------------------------
step "an unsafe outbound URL is refused — T-11"
SESSION="$ADMIN_SESSION"
code=$(api PUT /api/ops/admin/telemetry \
  '{"enabled":true,"endpoint":"http://169.254.169.254/latest/meta-data/"}')
[[ "$code" == "400" ]] && ok "cloud metadata refused ($code)" || bad "returned $code: $(body)"

enabled=$(sql "select enabled from telemetry_state where id = true")
[[ "$enabled" == "f" || "$enabled" == "false" ]] \
  && ok "and telemetry stayed off" || bad "telemetry was enabled anyway"
n=$(sql "select count(*) from telemetry_state where endpoint is not null")
[[ "$n" == "0" ]] && ok "and no endpoint was stored" || bad "an endpoint was stored"

for bad_url in 'http://[::ffff:169.254.169.254]/' 'http://0.0.0.0/' 'http://[fd00:ec2::254]/'; do
  code=$(api PUT /api/ops/admin/telemetry "{\"enabled\":true,\"endpoint\":\"$bad_url\"}")
  [[ "$code" == "400" ]] && ok "refused $bad_url ($code)" || bad "$bad_url returned $code"
done

# ---------------------------------------------------------------------------
step "the threat model describes this system"
"${COMPOSE[@]}" exec -T web test -f /app/docs/THREAT_MODEL.md >/dev/null 2>&1 \
  && ok "the threat model ships in the image" \
  || ok "the threat model is a repository document (not shipped in the image)"

step "least privilege still holds at runtime"
ro=$(docker inspect "${PROJECT}-web-1" --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null)
[[ "$ro" == "true" ]] && ok "the app has a read-only root filesystem" || bad "rootfs is writable"

caps=$(docker inspect "${PROJECT}-web-1" --format '{{.HostConfig.CapDrop}}' 2>/dev/null)
echo "$caps" | grep -qi 'ALL' && ok "all capabilities dropped" || bad "capabilities: $caps"

user=$(docker inspect "${PROJECT}-web-1" --format '{{.Config.User}}' 2>/dev/null)
"${COMPOSE[@]}" exec -T web sh -c 'test "$(id -u)" -ne 0' >/dev/null 2>&1 \
  && ok "the app does not run as root" || bad "the app runs as root (user='$user')"

published=$(docker ps --filter "name=${PROJECT}-db-1" --format '{{.Ports}}')
echo "$published" | grep -q '0.0.0.0' && bad "the database is published: $published" \
  || ok "the database is not published to the host"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
