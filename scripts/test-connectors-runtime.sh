#!/usr/bin/env bash
# Phase 7 runtime verification: connected accounts, against the real container
# stack and real PostgreSQL.
#
# NO PROVIDER IS CONTACTED. A stub on the project's own network answers as
# Google would, so the whole handshake runs end to end — authorize, callback,
# token exchange, identity — without an OAuth application, a real account, or a
# single packet leaving the host.
#
#   JOSI_HTTP_PORT=8398 JOSI_HTTPS_PORT=8561 PROJECT=josi-ce-phase7 \
#     bash scripts/test-connectors-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase7}"
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
if "${COMPOSE[@]}" up -d --build >/tmp/p7-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p7-up.log
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
step "an admin registers the installation's own OAuth application"
CLIENT_SECRET='OPERATOR-SECRET-runtime-DO-NOT-USE'
SESSION="$ADMIN_SESSION"
code=$(api PUT /api/admin/connectors/clients/google \
  "{\"clientId\":\"operator-client-id\",\"clientSecret\":\"$CLIENT_SECRET\",\"redirectUri\":\"http://127.0.0.1:${JOSI_HTTP_PORT}/api/connections/google/callback\"}")
[[ "$code" == "200" ]] && ok "application registered ($code)" || bad "returned $code: $(body)"

enc=$(sql "select client_secret_enc from oauth_clients where provider='google'")
case "$enc" in v1.*) ok "the client secret is sealed ciphertext in PostgreSQL" ;; *) bad "not sealed: ${enc:0:16}" ;; esac
leak=$(sql "select count(*) from oauth_clients where client_secret_enc like '%OPERATOR-SECRET%'")
[[ "$leak" == "0" ]] && ok "the plaintext secret is absent from the column" || bad "plaintext present"

api GET /api/admin/connectors >/dev/null
if body | grep -qE "$CLIENT_SECRET|v1\."; then bad "the admin view returns the secret or its ciphertext"; else ok "the admin view returns neither secret nor ciphertext"; fi

step "a member cannot register one"
SESSION="$ALICE_SESSION"
code=$(api PUT /api/admin/connectors/clients/google '{"clientId":"x","clientSecret":"y","redirectUri":"https://z.test/cb"}')
[[ "$code" == "403" ]] && ok "a member is refused ($code)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "connecting asks for read scopes only — M32"
SESSION="$ALICE_SESSION"
code=$(api POST /api/connections/google/start '{}')
[[ "$code" == "200" ]] && ok "handshake started" || bad "returned $code: $(body)"
AUTH_URL=$(body | sed -n 's/.*"url":"\([^"]*\)".*/\1/p' | sed 's/\\u0026/\&/g')
if echo "$AUTH_URL" | grep -q "calendar.readonly"; then ok "asks for read scope"; else bad "no read scope in $AUTH_URL"; fi
if echo "$AUTH_URL" | grep -q "gmail.send"; then bad "asks for write scope up front"; else ok "asks for NO write scope"; fi
if echo "$AUTH_URL" | grep -q "$CLIENT_SECRET"; then bad "the client secret is in the authorize URL"; else ok "no secret in the authorize URL"; fi
if echo "$AUTH_URL" | grep -q "code_challenge_method=S256"; then ok "uses PKCE"; else bad "no PKCE"; fi

STATE=$(echo "$AUTH_URL" | sed -n 's/.*[?&]state=\([^&]*\).*/\1/p')
[[ -n "$STATE" ]] && ok "a state was minted" || bad "no state"

step "the handshake is stored, and its verifier is sealed"
v=$(sql "select verifier_enc from oauth_states limit 1")
case "$v" in v1.*) ok "the PKCE verifier is sealed at rest" ;; *) bad "verifier not sealed" ;; esac

# ---------------------------------------------------------------------------
# The stub provider. Answers the token and identity endpoints as Google would.
step "starting a stub provider on the project network"
# The app calls https://oauth2.googleapis.com — real scheme, real hostname, real
# TLS. A plain-HTTP stub is not reachable at all: the client connects to :443
# and finds nothing, which is what the previous run showed as `error=network`.
#
# So the stub serves HTTPS on 443 with a self-signed certificate naming both
# provider hostnames, and the web container is given that certificate as an
# extra CA. Certificate verification stays ON — disabling it would mean testing
# a security feature with its checks switched off.
rm -rf /tmp/josi-stub-tls && mkdir -p /tmp/josi-stub-tls
docker run --rm -v /tmp/josi-stub-tls:/out alpine/openssl:latest req -x509 -nodes -newkey rsa:2048 \
  -keyout /out/stub.key -out /out/stub.crt -days 2 -subj "/CN=oauth2.googleapis.com" \
  -addext "subjectAltName=DNS:oauth2.googleapis.com,DNS:openidconnect.googleapis.com" \
  >/tmp/p7-cert.log 2>&1 \
  && ok "stub certificate generated" || bad "openssl failed: $(tail -2 /tmp/p7-cert.log)"

docker rm -f "${PROJECT}-fakeoauth" >/dev/null 2>&1 || true
# The aliases are the DNS mechanism: Docker's embedded resolver answers a
# network alias for every container on the network, so the app reaches the stub
# while still asking for Google's real hostnames. No /etc/hosts edit — the web
# container has a read-only root filesystem, correctly.
docker run -d --rm --name "${PROJECT}-fakeoauth" --network "$NET" \
  --network-alias fakeoauth \
  --network-alias oauth2.googleapis.com \
  --network-alias openidconnect.googleapis.com \
  -v /tmp/josi-stub-tls:/tls:ro \
  python:3.12-alpine python3 -c '
import json, ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def _send(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        self._send({"access_token": "STUB-ACCESS-TOKEN", "refresh_token": "STUB-REFRESH-TOKEN",
                    "expires_in": 3600,
                    "scope": "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email"})
    def do_GET(self):
        self._send({"sub": "stub-account", "email": "alice.private@gmail.test"})
    def log_message(self, *a): pass
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("/tls/stub.crt", "/tls/stub.key")
srv = HTTPServer(("0.0.0.0", 443), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
' >/dev/null 2>&1 && ok "stub provider started on https/443" || bad "stub failed to start"
sleep 4

step "the provider hostnames resolve to the stub"
stub_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${PROJECT}-fakeoauth" 2>/dev/null)
resolved=$("${COMPOSE[@]}" exec -T web sh -c "getent hosts oauth2.googleapis.com | head -1" 2>/dev/null | tr -d '\r')
echo "$resolved" | grep -q "$stub_ip" \
  && ok "oauth2.googleapis.com resolves to the stub ($stub_ip)" \
  || bad "resolves to '$resolved', expected $stub_ip"

step "teaching the app to trust the stub certificate"
cat > /tmp/josi-e2e-oauth.yml <<YML
services:
  web:
    environment:
      NODE_EXTRA_CA_CERTS: /tls/stub.crt
    volumes:
      - /tmp/josi-stub-tls:/tls:ro
YML
docker compose -p "$PROJECT" -f docker-compose.yml -f /tmp/josi-e2e-oauth.yml up -d web \
  >/tmp/p7-hosts.log 2>&1 && ok "web recreated with the stub CA" || bad "recreate failed: $(tail -2 /tmp/p7-hosts.log)"
for _ in $(seq 1 40); do [[ "$(api GET /health)" == "200" ]] && break; sleep 2; done

# Verify the override actually took. The previous attempt reported success while
# changing nothing, which is how a broken prerequisite masquerades as a working
# one.
ca=$("${COMPOSE[@]}" exec -T web sh -c 'echo "$NODE_EXTRA_CA_CERTS"' 2>/dev/null | tr -d '\r')
[[ "$ca" == "/tls/stub.crt" ]] && ok "the CA env var is set in the container" || bad "NODE_EXTRA_CA_CERTS is '$ca'"
"${COMPOSE[@]}" exec -T web sh -c 'test -r /tls/stub.crt' 2>/dev/null \
  && ok "the certificate is readable in the container" || bad "certificate not mounted"

step "completing the handshake against the stub"
code=$(api GET "/api/connections/google/callback?state=${STATE}&code=stub-code")
loc=$("${COMPOSE[@]}" exec -T web sh -c "grep -i '^location:' /tmp/r.hdr" 2>/dev/null | tr -d '\r')
# A 302 alone proves nothing: the failure path also redirects, to ?error=… .
# Asserting only the status is how a test passes while the thing it tests is
# broken, which is what the first run of this script did.
if [[ "$code" == "302" ]] && ! echo "$loc" | grep -q "error="; then
  ok "callback completed the connection ($code)"
else
  bad "callback returned $code and redirected to: $loc"
fi

# Sessions live in PostgreSQL, so recreating `web` above did not sign anyone out.

owner=$(sql "select count(*) from connections where owner_user_id = (select id from users where username='alice')")
[[ "$owner" == "1" ]] && ok "the connection belongs to alice" || bad "$owner connections for alice"

# Everything below needs a connection to exist. Without this guard a single
# broken prerequisite produced thirteen failures on the first run, only one of
# which was real — a wall of noise that makes the actual cause harder to see,
# not easier.
if [[ "$owner" != "1" ]]; then
  echo
  echo "  FATAL  no connection was created, so nothing below would mean anything"
  printf '\n%d passed, %d failed\n' "$pass" "$fail"
  exit 1
fi

step "the tokens are sealed in real PostgreSQL"
enc=$(sql "select secrets_enc from connections limit 1")
case "$enc" in v1.*) ok "tokens sealed" ;; *) bad "tokens not sealed: ${enc:0:16}" ;; esac
leak=$(sql "select count(*) from connections where secrets_enc like '%STUB-ACCESS-TOKEN%'")
[[ "$leak" == "0" ]] && ok "no plaintext token in the column" || bad "plaintext token present"

step "the capability is available but OFF"
api GET /api/connections >/dev/null
if has '"state":"off"'; then ok "granted capability starts off"; else bad "not off: $(body)"; fi
enabled=$(sql "select count(*) from connection_capabilities where enabled = true")
[[ "$enabled" == "0" ]] && ok "nothing is enabled by connecting" || bad "$enabled enabled"

step "the handshake cannot be replayed"
code=$(api GET "/api/connections/google/callback?state=${STATE}&code=stub-code")
loc=$("${COMPOSE[@]}" exec -T web sh -c "grep -i '^location:' /tmp/r.hdr" 2>/dev/null | tr -d '\r')
echo "$loc" | grep -q "error=consumed" && ok "a replay is refused" || bad "replay gave: $loc"

# ---------------------------------------------------------------------------
step "enabling a write capability the provider did not grant is refused — M32"
CONN=$(sql "select id from connections limit 1")
code=$(api PUT "/api/connections/$CONN/capabilities/google.mail.send" '{"enabled":true}')
[[ "$code" == "409" ]] && ok "refused with 409" || bad "returned $code: $(body)"
if has 'needs_consent'; then ok "and says re-consent is needed"; else bad "no needs_consent: $(body)"; fi

step "the admin ceiling denies, and does not grant"
SESSION="$ADMIN_SESSION"
api PUT /api/admin/connectors/policy/google.calendar.read '{"allowed":true}' >/dev/null
SESSION="$ALICE_SESSION"
api GET /api/connections >/dev/null
if has '"key":"google.calendar.read","label":"Read your Google Calendar","kind":"read","state":"on"'; then
  bad "an admin allow switched it on"
else
  ok "an admin allow did NOT switch it on"
fi

api PUT "/api/connections/$CONN/capabilities/google.calendar.read" '{"enabled":true}' >/dev/null
if has '"state":"on"'; then ok "alice switched it on herself"; else bad "could not enable: $(body)"; fi

SESSION="$ADMIN_SESSION"
api PUT /api/admin/connectors/policy/google.calendar.read '{"allowed":false,"note":"not here"}' >/dev/null
SESSION="$ALICE_SESSION"
api GET /api/connections >/dev/null
if has 'blocked_by_admin'; then ok "an admin deny overrides her choice"; else bad "not blocked: $(body)"; fi

SESSION="$ADMIN_SESSION"
api PUT /api/admin/connectors/policy/google.calendar.read '{"allowed":true}' >/dev/null
SESSION="$ALICE_SESSION"
api GET /api/connections >/dev/null
if has '"state":"on"'; then ok "lifting the ceiling restores her own choice"; else bad "choice lost: $(body)"; fi

# ---------------------------------------------------------------------------
step "BOB cannot touch alice's connection"
SESSION="$BOB_SESSION"
for verb in GET DELETE; do
  code=$(api $verb "/api/connections/$CONN")
  [[ "$code" == "404" ]] && ok "$verb is 404 for a colleague" || bad "$verb returned $code"
done
code=$(api PUT "/api/connections/$CONN/capabilities/google.calendar.read" '{"enabled":false}')
[[ "$code" == "404" ]] && ok "cannot change her capabilities" || bad "returned $code"
still=$(sql "select enabled from connection_capabilities where capability='google.calendar.read'")
[[ "$still" == "t" ]] && ok "her setting is untouched" || bad "her setting is now '$still'"

step "the SUPER ADMIN sees health, never content"
SESSION="$ADMIN_SESSION"
code=$(api GET /api/admin/connectors/connections)
[[ "$code" == "200" ]] && ok "health view served" || bad "returned $code"
for secret in 'alice.private@gmail.test' 'STUB-ACCESS-TOKEN' 'STUB-REFRESH-TOKEN' 'calendar.readonly'; do
  if has "$secret"; then bad "health view leaks $secret"; else ok "health view does not contain $secret"; fi
done
if has '"username":"alice"'; then ok "it does say whose connection it is"; else bad "no owner shown"; fi

code=$(api GET "/api/connections/$CONN")
[[ "$code" == "404" ]] && ok "the admin cannot read her own connection view (404)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "no secret reaches the audit log or any container log"
for secret in "$CLIENT_SECRET" 'STUB-ACCESS-TOKEN' 'STUB-REFRESH-TOKEN' 'alice.private@gmail.test'; do
  n=$(sql "select count(*) from events where payload::text like '%${secret}%'")
  [[ "$n" == "0" ]] && ok "no '$secret' in events" || bad "'$secret' found in $n events"
done
if "${COMPOSE[@]}" logs 2>&1 | grep -qE "$CLIENT_SECRET|STUB-ACCESS-TOKEN|STUB-REFRESH-TOKEN"; then
  bad "a secret appears in the container logs"
else
  ok "no secret in any container log"
fi

docker rm -f "${PROJECT}-fakeoauth" >/dev/null 2>&1 || true

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
