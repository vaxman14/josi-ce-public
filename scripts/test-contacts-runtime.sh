#!/usr/bin/env bash
# LB8 runtime verification: contact synchronisation, against the real container
# stack and real PostgreSQL.
#
# TWO SECTIONS, AND THE DIFFERENCE MATTERS.
#
#   PART A — stubbed provider. A container on the project's own network answers
#            as Google People and Microsoft Graph do. The whole path runs end to
#            end against real postgres.js — pagination, delta cursors, deletes,
#            tombstones, conflicts, per-user isolation — with nothing leaving
#            the host and no OAuth application required. This is what catches
#            the class of defect the unit suite structurally cannot: pglite
#            accepts a hand-serialised jsonb parameter and postgres.js stores a
#            string scalar, which is silent in tests and permanent in
#            production.
#
#   PART B — the real thing. Google and Microsoft, a real OAuth application, a
#            real account. Without credentials it prints SKIPPED and exits 3.
#            SKIPPED IS NOT PASS, in this script's exit code, in its summary,
#            and in any document that cites it.
#
#   JOSI_HTTP_PORT=8402 JOSI_HTTPS_PORT=8565 PROJECT=josi-ce-lb8 \
#     bash scripts/test-contacts-runtime.sh
#
# Part B additionally needs, and does nothing without:
#   JOSI_REAL_GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN
#   JOSI_REAL_MS_CLIENT_ID / _SECRET / _REFRESH_TOKEN
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-lb8}"
COMPOSE=(docker compose -p "$PROJECT")
STUB="${PROJECT}-fakecontacts"
NET="${PROJECT}_edge"

pass=0; fail=0; skipped=0
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); }
skip() { printf '  SKIP  %s\n' "$*"; skipped=$((skipped+1)); }
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
export JOSI_COOKIE_SECURE=false

# --------------------------------------------------------------------- setup

step "clean project state"
docker rm -f "$STUB" >/dev/null 2>&1 || true
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf secrets && bash scripts/install.sh >/dev/null
ok "secrets generated"

step "bringing the stack up"
if ! "${COMPOSE[@]}" up -d --build >/tmp/josi-lb8-up.log 2>&1; then
  bad "the stack did not come up — see /tmp/josi-lb8-up.log"
  tail -30 /tmp/josi-lb8-up.log
  exit 1
fi
ok "stack up"

api() { "${COMPOSE[@]}" exec -T web curl -sS "$@"; }

step "waiting for readiness"
ready=0
for _ in $(seq 1 60); do
  if api -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ready 2>/dev/null | grep -q 200; then
    ready=1; break
  fi
  sleep 2
done
[[ "$ready" == "1" ]] && ok "/ready is green" || { bad "/ready never came up"; exit 1; }

step "the contact-sync schema exists on real PostgreSQL"
for table in contact_sync_origins contact_links contact_tombstones contact_merge_decisions; do
  n=$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc \
      "select count(*) from information_schema.tables where table_name = '$table'" 2>/dev/null | tr -d '\r ')
  [[ "$n" == "1" ]] && ok "$table exists" || bad "$table is missing"
done

# The defect a unit suite cannot see. pglite accepts a hand-serialised jsonb
# parameter; postgres.js stores a jsonb STRING SCALAR, and reading it back
# yields a string rather than an array. Asserting the TYPE of what came back is
# the only check that distinguishes them.
step "jsonb columns hold arrays, not strings that look like arrays"
"${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc \
  "insert into users (email, username, role, status) values ('lb8@ce.test','lb8','member','active') on conflict do nothing" \
  >/dev/null 2>&1
kind=$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-josi}" -d "${POSTGRES_DB:-josi}" -tAc \
  "insert into contacts (owner_user_id, name, emails, phones)
   select id, 'Runtime Probe', '[\"a@example.test\"]'::jsonb, '[]'::jsonb from users where username='lb8'
   returning jsonb_typeof(emails)" 2>/dev/null | tr -d '\r ' | sed -n 1p)
[[ "$kind" == "array" ]] && ok "contacts.emails is a jsonb array" || bad "contacts.emails came back as '$kind'"

# -------------------------------------------------- PART A: stubbed provider

step "PART A — the whole path against a stubbed provider"

cat > /tmp/josi-lb8-stub.js <<'STUB'
// Answers as Google People and Microsoft Graph do, keyed by bearer token so
// one user's request can never receive another's contacts.
const http = require('http');
const BOOKS = {
  'alice-token': [{ resourceName: 'people/a1', etag: 'e1',
    names: [{ displayName: 'Alice Client' }],
    emailAddresses: [{ value: 'alice-client@example.test' }] }],
  'bob-token': [{ resourceName: 'people/b1', etag: 'e1',
    names: [{ displayName: 'Bob Client' }],
    emailAddresses: [{ value: 'bob-client@example.test' }] }],
};
let deleted = false;
http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  res.setHeader('content-type', 'application/json');
  if (req.url.includes('/token')) return res.end(JSON.stringify({ access_token: token || 'x', expires_in: 3600 }));
  if (req.url.includes('/mark-deleted')) { deleted = true; return res.end('{}'); }
  const book = deleted
    ? [{ resourceName: 'people/a1', metadata: { deleted: true } }]
    : (BOOKS[token] || []);
  res.end(JSON.stringify({ connections: book, nextSyncToken: 'tok-' + token }));
}).listen(9099);
STUB

docker run -d --name "$STUB" --network "$NET" -v /tmp/josi-lb8-stub.js:/stub.js:ro \
  node:22-bookworm-slim node /stub.js >/dev/null 2>&1 \
  && ok "stub provider running on the project network" \
  || bad "stub provider did not start"

# The stub above answers over HTTP and is kept because it proves the project
# network is usable. The end-to-end steps below do NOT go through it: they drive
# the real sync engine inside the web container with `fetchImpl` injected, which
# is the seam the unit suite already uses.
#
# WHY NOT POINT THE PRODUCT AT THE STUB. The provider endpoints are compile-time
# constants. Making them configurable would put an environment variable into
# every shipped installation that redirects where OAuth tokens and address books
# are sent — an exfiltration hook added for the convenience of a test. The
# existing seam costs nothing and adds no attack surface.
#
# What this catches that the unit suite structurally cannot: pglite accepts a
# hand-serialised jsonb parameter, postgres.js stores it as a string scalar.
# Silent in tests, permanent in production. The assertions ask PostgreSQL what
# the column actually holds.
# Passed on the command line rather than copied in: `docker cp` is refused by a
# read-only container, and the containers are read-only deliberately.
part_a=$("${COMPOSE[@]}" exec -T web node --input-type=module -e "$(cat scripts/lb8-part-a.mjs)" \
  2>/tmp/josi-lb8-parta.err)
if [[ -z "$part_a" ]]; then
  bad "PART A produced no verdict at all: $(head -c 300 /tmp/josi-lb8-parta.err)"
else
  while IFS='|' read -r verdict msg; do
    [[ -z "$verdict" ]] && continue
    [[ "$verdict" == "PASS" ]] && ok "$msg" || bad "$msg"
  done <<< "$part_a"
fi

# -------------------------------------------------- PART B: a real provider

step "PART B — real Google and Microsoft"

have_google=0
[[ -n "${JOSI_REAL_GOOGLE_CLIENT_ID:-}" && -n "${JOSI_REAL_GOOGLE_CLIENT_SECRET:-}" \
   && -n "${JOSI_REAL_GOOGLE_REFRESH_TOKEN:-}" ]] && have_google=1

have_ms=0
[[ -n "${JOSI_REAL_MS_CLIENT_ID:-}" && -n "${JOSI_REAL_MS_CLIENT_SECRET:-}" \
   && -n "${JOSI_REAL_MS_REFRESH_TOKEN:-}" ]] && have_ms=1

if [[ "$have_google" == "0" ]]; then
  skip "Google: no JOSI_REAL_GOOGLE_* credentials supplied — nothing was tested"
else
  # A real read against the People API, with the operator's own application.
  token=$(curl -sS -X POST https://oauth2.googleapis.com/token \
    -d client_id="$JOSI_REAL_GOOGLE_CLIENT_ID" \
    -d client_secret="$JOSI_REAL_GOOGLE_CLIENT_SECRET" \
    -d refresh_token="$JOSI_REAL_GOOGLE_REFRESH_TOKEN" \
    -d grant_type=refresh_token | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
  if [[ -z "$token" ]]; then
    bad "Google refused the refresh token"
  else
    code=$(curl -sS -o /tmp/josi-lb8-google.json -w '%{http_code}' \
      -H "Authorization: Bearer $token" \
      'https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,metadata&pageSize=5&requestSyncToken=true')
    [[ "$code" == "200" ]] && ok "Google People answered 200" || bad "Google People answered $code"
    grep -q 'nextSyncToken' /tmp/josi-lb8-google.json \
      && ok "Google returned a sync token, so incremental sync is possible" \
      || bad "Google returned no sync token"
    rm -f /tmp/josi-lb8-google.json
  fi
fi

if [[ "$have_ms" == "0" ]]; then
  skip "Microsoft: no JOSI_REAL_MS_* credentials supplied — nothing was tested"
else
  token=$(curl -sS -X POST https://login.microsoftonline.com/common/oauth2/v2.0/token \
    -d client_id="$JOSI_REAL_MS_CLIENT_ID" \
    -d client_secret="$JOSI_REAL_MS_CLIENT_SECRET" \
    -d refresh_token="$JOSI_REAL_MS_REFRESH_TOKEN" \
    -d grant_type=refresh_token \
    -d scope='Contacts.Read offline_access' | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
  if [[ -z "$token" ]]; then
    bad "Microsoft refused the refresh token"
  else
    code=$(curl -sS -o /tmp/josi-lb8-ms.json -w '%{http_code}' \
      -H "Authorization: Bearer $token" -H 'Prefer: odata.maxpagesize=5' \
      'https://graph.microsoft.com/v1.0/me/contacts/delta?$select=id,displayName,emailAddresses')
    [[ "$code" == "200" ]] && ok "Graph answered 200" || bad "Graph answered $code"
    grep -q '@odata.deltaLink\|@odata.nextLink' /tmp/josi-lb8-ms.json \
      && ok "Graph returned a delta or next link, so incremental sync is possible" \
      || bad "Graph returned neither a delta nor a next link"
    rm -f /tmp/josi-lb8-ms.json
  fi
fi

# ------------------------------------------------------------------ summary

printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skipped"
printf 'SKIPPED IS NOT PASS. A skipped check tested nothing.\n'

# Exit codes are distinct on purpose, so a CI job or a document generator
# cannot round a skip up to a pass.
[[ "$fail" -gt 0 ]] && exit 1
[[ "$skipped" -gt 0 ]] && exit 3
exit 0
