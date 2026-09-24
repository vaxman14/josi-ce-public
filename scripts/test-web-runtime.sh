#!/usr/bin/env bash
# Phase 6 runtime verification: the web app, in a real browser, against the real
# container stack.
#
# Stands the stack up, drives the setup wizard through the API, creates a member,
# then hands the running installation to scripts/e2e-web.mjs — which taps the
# Talk composer in WebKit with touch emulation, measures every page at 320, 375,
# 390 and 430, and asserts that nothing is fetched from a third party.
#
#   JOSI_HTTP_PORT=8396 JOSI_HTTPS_PORT=8559 PROJECT=josi-ce-phase6 \
#     bash scripts/test-web-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase6}"
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
if "${COMPOSE[@]}" up -d --build >/tmp/p6-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p6-up.log
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
step "the app is served from the API's own origin"
code=$(api GET /login)
[[ "$code" == "200" ]] && ok "/login serves the app ($code)" || bad "/login returned $code"
if body | grep -q '<div id="root">'; then ok "it is the SPA shell"; else bad "not the shell"; fi
if body | grep -qE 'https?://'; then bad "the shell references an external origin"; else ok "the shell references no external origin"; fi

step "a client route falls through to the shell, an API route does not"
[[ "$(api GET /app/tasks)" == "200" ]] && ok "/app/tasks serves the shell" || bad "client route not served"
code=$(api GET /api/nope)
[[ "$code" == "404" ]] && ok "an unknown API route still answers JSON 404" || bad "returned $code"
if body | grep -q '<div id="root">'; then bad "the API 404 returned HTML"; else ok "the API 404 is not HTML"; fi

step "security headers are on every response"
hdrs=$("${COMPOSE[@]}" exec -T web curl -sS -D - -o /dev/null "http://127.0.0.1:8080/login" 2>/dev/null | tr -d '\r')
for h in "content-security-policy" "x-content-type-options" "referrer-policy" "x-frame-options"; do
  echo "$hdrs" | grep -qi "^$h" && ok "$h present" || bad "$h missing"
done
echo "$hdrs" | grep -qi "default-src 'self'" && ok "CSP default-src is 'self'" || bad "CSP not restrictive"
if echo "$hdrs" | grep -qi "content-security-policy.*\*"; then bad "CSP contains a wildcard"; else ok "CSP has no wildcard"; fi

step "the brand assets are served and are the approved identity"
for asset in josi-mark.png josi-wordmark.png; do
  code=$("${COMPOSE[@]}" exec -T web curl -sS -o /tmp/a.png -w '%{http_code}' "http://127.0.0.1:8080/brand/$asset" 2>/dev/null)
  [[ "$code" == "200" ]] && ok "$asset is served" || bad "$asset returned $code"
done

# The WORDMARK is the master and is never regenerated, so its hash is pinned.
word_sha=$("${COMPOSE[@]}" exec -T web sh -c "sha256sum /app/web/brand/josi-wordmark.png 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r')
[[ "$word_sha" == "d5b822231e69bce51f9a662a158aa23d07e26650224124b28684b8b3fcb86803" ]] \
  && ok "the wordmark is byte-identical to the approved master" \
  || bad "wordmark hash is $word_sha"

# The MARK is cut from the wordmark by scripts/build-brand.sh rather than being
# a second master, so its hash is pinned to what that script produces. The
# retired identity's artwork was a different file entirely; this is the check
# that fails if it ever comes back.
mark_sha=$("${COMPOSE[@]}" exec -T web sh -c "sha256sum /app/web/brand/josi-mark.png 2>/dev/null | cut -d' ' -f1" 2>/dev/null | tr -d '\r')
[[ "$mark_sha" == "0c4591ea252f6f3e57a3dc488ce79cc7fbed76ab04ea261f7bd4f1ad0a089517" ]] \
  && ok "the J mark matches what build-brand.sh derives from the wordmark" \
  || bad "mark hash is $mark_sha"

# ---------------------------------------------------------------------------
step "running the browser suite (WebKit, touch emulation)"
# The browser runs in Microsoft's own Playwright image, on this project's
# network, rather than on the host.
#
# WebKit needs a dozen system libraries (libicu, libwoff1, libvpx, libavif…)
# and the first attempt failed on a host that did not have them. Installing
# them would mean apt-get on somebody's Docker host to run a test — a change
# outside the isolated project this script promises to be. The official image
# has them, is pinned to the same 1.49.1 as the devDependency, and reaches the
# app over the container network as `web:8080`.
#
# The repo is mounted so the suite runs the source in this checkout; the image
# supplies the browsers at /ms-playwright.
PW_IMAGE="mcr.microsoft.com/playwright:v1.49.1-noble"
npm ci --no-audit --no-fund >/tmp/npm-ci.log 2>&1 \
  && ok "workspace installed" || bad "npm ci failed: $(tail -3 /tmp/npm-ci.log)"

if docker run --rm \
     --network "$NET" \
     -v "$(pwd)":/work -w /work \
     -e E2E_BASE="http://web:8080" \
     -e E2E_ADMIN=owner -e E2E_ADMIN_PW="$ADMIN_PW" \
     -e E2E_MEMBER=alice -e E2E_MEMBER_PW="$ALICE_PW" \
     "$PW_IMAGE" node scripts/e2e-web.mjs; then
  ok "browser suite passed"
else
  bad "browser suite failed (output above)"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
