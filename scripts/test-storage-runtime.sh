#!/usr/bin/env bash
# Phase 9 runtime verification: documents and storage, against the real
# container stack and real PostgreSQL.
#
# What this exists to catch is what the unit suite structurally cannot. Phase 6
# proved the point: a jsonb double-encoding bug was invisible under pglite and
# permanent under postgres.js. Phase 9 adds two more classes of that —
# `to_tsvector` generated columns and `websearch_to_tsquery`, neither of which
# pglite and postgres.js are guaranteed to agree about — plus a real filesystem
# with real symlinks inside a container that has a read-only root.
#
# NOTHING LEAVES THE HOST. No provider, no scanner, no model.
#
#   JOSI_HTTP_PORT=8402 JOSI_HTTPS_PORT=8565 PROJECT=josi-ce-phase9 \
#     bash scripts/test-storage-runtime.sh

set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-phase9}"
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
  rm -f "/tmp/${PROJECT}-roots.yml" 2>/dev/null || true
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

# Production mounts NO shared folder by default — that is M45's deny-by-default
# at the mount layer, and the packaging test asserts it. So the test supplies its
# own mount rather than the product shipping one.
cat > /tmp/${PROJECT}-roots.yml <<'OVERRIDE'
services:
  web:
    volumes:
      - josi_test_roots:/data/roots
  worker:
    volumes:
      - josi_test_roots:/data/roots
volumes:
  josi_test_roots:
OVERRIDE
# Passing -f stops compose auto-loading docker-compose.yml, so name both.
COMPOSE+=(-f docker-compose.yml -f /tmp/${PROJECT}-roots.yml)

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
if "${COMPOSE[@]}" up -d --build >/tmp/p9-up.log 2>&1; then
  ok "compose up"
else
  echo "  FATAL  compose up failed — nothing below would mean anything"
  tail -30 /tmp/p9-up.log
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
# A real folder tree inside the app container, with real symlinks.
#
# The app runs with a read-only root filesystem (Phase 2), so the tree is built
# under a writable mount. `/data` is Josi's own volume, which is exactly where
# a bind-mounted shared folder would live in a real installation.
step "building a real folder tree with real symlinks"
"${COMPOSE[@]}" exec -T -u root web sh -c '
  set -e
  rm -rf /data/roots/docs /data/roots/docs-private /data/versions/outside
  mkdir -p /data/roots/docs/layoffs-legal-review
  mkdir -p /data/roots/docs-private
  mkdir -p /data/versions/outside
  echo "SALARY-DATA-DO-NOT-INDEX" > /data/versions/outside/salaries.csv
  echo "SIBLING-PREFIX-SECRET" > /data/roots/docs-private/notes.txt
  ln -sfn /data/versions/outside /data/roots/docs/escape
  ln -sfn /etc /data/roots/docs/etc-link
  chown -R 10001:10001 /data/roots /data/versions 2>/dev/null || true
' >/dev/null 2>&1 && ok "tree built" || bad "could not build the folder tree"

"${COMPOSE[@]}" exec -T web sh -c 'test -L /data/roots/docs/escape' >/dev/null 2>&1 \
  && ok "the escaping symlink really exists" || bad "symlink missing — the test would prove nothing"

step "registering the root the way an operator would"
ROOT_ID=$(sql "insert into storage_roots (container_path, label, purpose, writable)
               values ('/data/roots/docs', 'Documents', 'shared reference material', true)
               returning id")
[[ -n "$ROOT_ID" ]] && ok "root registered" || bad "could not register the root"

# The sibling directory is NOT registered. It exists only so containment can be
# tested against the prefix case.
n=$(sql "select count(*) from storage_roots")
[[ "$n" == "1" ]] && ok "exactly one root is registered" || bad "expected one root, found $n"

# ---------------------------------------------------------------------------
step "alice cannot map anything until an administrator allows it — M47"
SESSION="$ALICE_SESSION"
code=$(api POST /api/storage/mappings \
  "{\"provider\":\"local\",\"rootId\":\"$ROOT_ID\",\"relativePath\":\"layoffs-legal-review\"}")
[[ "$code" == "403" ]] && ok "refused ($code)" || bad "returned $code: $(body)"
n=$(sql "select count(*) from folder_mappings")
[[ "$n" == "0" ]] && ok "nothing was created" || bad "$n mappings exist"

step "the administrator enables mapping and indexing for her"
SESSION="$ADMIN_SESSION"
ALICE_ID=$(sql "select id from users where username = 'alice'")
BOB_ID=$(sql "select id from users where username = 'bob'")
code=$(api PUT "/api/storage/admin/capabilities/$ALICE_ID" \
  '{"mayMapLocal":true,"mayMapCloud":false,"mayIndex":true}')
[[ "$code" == "200" ]] && ok "capability granted ($code)" || bad "returned $code: $(body)"

step "and still cannot map a folder on her behalf — M47"
code=$(api POST /api/storage/mappings \
  "{\"provider\":\"local\",\"rootId\":\"$ROOT_ID\",\"relativePath\":\"layoffs-legal-review\",\"ownerUserId\":\"$ALICE_ID\",\"owner_user_id\":\"$ALICE_ID\"}")
n=$(sql "select count(*) from folder_mappings where owner_user_id = '$ALICE_ID'")
[[ "$n" == "0" ]] && ok "no mapping was created as alice" || bad "the admin created $n mappings as alice"
sql "delete from folder_mappings" >/dev/null

# ---------------------------------------------------------------------------
step "containment against a real filesystem — M45"
SESSION="$ALICE_SESSION"
map_attempt() { api POST /api/storage/mappings \
  "{\"provider\":\"local\",\"rootId\":\"$ROOT_ID\",\"relativePath\":\"$1\"}"; }

for bad_path in '../docs-private' '../../versions/outside' 'layoffs-legal-review/../../docs-private' '/etc'; do
  code=$(map_attempt "$bad_path")
  # A JSON body, not Express's HTML "Bad Request" page. An earlier run passed
  # this check while the request was being rejected by the body parser, which
  # proved nothing about containment.
  if [[ "$code" == "400" ]] && body | grep -q '"error"'; then
    ok "traversal refused by the application: $bad_path ($code)"
  else
    bad "$bad_path returned $code: $(body | head -3)"
  fi
done

# The two that a string-only implementation gets wrong.
code=$(map_attempt 'escape')
[[ "$code" == "400" ]] && ok "symlink out of the root refused ($code)" || bad "escape returned $code: $(body)"
code=$(map_attempt 'etc-link')
[[ "$code" == "400" ]] && ok "symlink to /etc refused ($code)" || bad "etc-link returned $code"

n=$(sql "select count(*) from folder_mappings")
[[ "$n" == "0" ]] && ok "nothing escaped into a mapping" || bad "$n mappings were created"

step "a legitimate folder maps"
code=$(map_attempt 'layoffs-legal-review')
[[ "$code" == "201" ]] && ok "mapped ($code)" || bad "returned $code: $(body)"
MAPPING=$(body | sed -n 's/.*"mapping":{"id":"\([0-9a-f-]*\)".*/\1/p')
[[ -n "$MAPPING" ]] && ok "got a mapping id" || bad "no mapping id in $(body)"

step "and starts read-only, unindexed, non-recursive — M47"
row=$(sql "select may_create||','||may_edit||','||may_move||','||may_delete||','||indexing_enabled||','||recursive
           from folder_mappings where id = '$MAPPING'")
# `boolean || text` renders as false/true, not the f/t psql shows for a bare
# boolean column. The first version of this compared against f,f,f,f,f,f and
# failed on a mapping that was in fact correct.
[[ "$row" == "false,false,false,false,false,false" ]] \
  && ok "every permission starts off ($row)" || bad "started as '$row'"

step "the consent sentence says what recursive really means — M50"
code=$(api POST /api/storage/consent-preview \
  "{\"rootId\":\"$ROOT_ID\",\"relativePath\":\"layoffs-legal-review\",\"recursive\":true,\"indexing\":true}")
if body | grep -q 'any subfolder added to it in future'; then
  ok "states that future subfolders are covered"
else bad "consent text does not mention future subfolders: $(body)"; fi
if body | grep -q 'language model'; then
  ok "and that indexing sends text to the model"
else bad "consent text does not mention the model"; fi

# ---------------------------------------------------------------------------
# Real PostgreSQL: generated tsvector columns and websearch_to_tsquery.
step "indexing, and search against real PostgreSQL full-text search"
code=$(api PUT "/api/storage/mappings/$MAPPING/indexing" '{"enabled":true}')
[[ "$code" == "200" ]] && ok "indexing enabled ($code)" || bad "returned $code: $(body)"

SECRET='northernregionrestructuring'
DOC=$(sql "insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
           values ('$MAPPING', '$ALICE_ID', 'plan.pdf', 'plan.pdf', 'indexed') returning id")
sql "insert into document_text (document_id, owner_user_id, content, char_count)
     values ('$DOC', '$ALICE_ID', 'The $SECRET plan is confidential.', 40)" >/dev/null
sql "insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
     values ('$DOC', '$ALICE_ID', 0, 'page', '4', 'The $SECRET plan is confidential.')" >/dev/null

# The generated column has to have been populated by PostgreSQL itself.
n=$(sql "select count(*) from document_segments where search_vector is not null")
[[ "$n" == "1" ]] && ok "PostgreSQL generated the search vector" || bad "search_vector is null"

code=$(api GET "/api/storage/search?q=$SECRET")
[[ "$code" == "200" ]] && ok "search answered ($code)" || bad "search returned $code"
if body | grep -q 'page 4'; then ok "with a precise citation — M67"; else bad "no locator: $(body)"; fi

step "search takes what a person actually types"
for q in 'q3%20(draft)' '%22northern%20region%22' 'a%7Cb' '%3A*' 'revenue%20%26%20%21'; do
  code=$(api GET "/api/storage/search?q=$q")
  [[ "$code" == "200" ]] && ok "no error for: $q" || bad "$q returned $code: $(body)"
done

step "search never crosses owners — M68"
SESSION="$BOB_SESSION"
code=$(api GET "/api/storage/search?q=$SECRET")
[[ "$code" == "200" ]] && ok "bob's search answers" || bad "returned $code"
if has "$SECRET"; then bad "bob can see alice's document"; else ok "and finds nothing of hers"; fi

code=$(api GET "/api/storage/search?q=$SECRET&ownerUserId=$ALICE_ID")
if has "$SECRET"; then bad "a query parameter widened the scope"; else ok "a query parameter cannot widen it"; fi

SESSION="$ADMIN_SESSION"
api GET "/api/storage/search?q=$SECRET" >/dev/null
if has "$SECRET"; then bad "the administrator can search her documents"; else ok "the administrator finds nothing"; fi

# ---------------------------------------------------------------------------
step "a mapping is private — M68"
for who in BOB ADMIN; do
  eval "SESSION=\$${who}_SESSION"
  code=$(api GET "/api/storage/mappings/$MAPPING")
  [[ "$code" == "404" ]] && ok "$who gets 404" || bad "$who got $code"
  code=$(api DELETE "/api/storage/mappings/$MAPPING")
  [[ "$code" == "404" ]] && ok "$who cannot unmap it" || bad "$who DELETE got $code"
done
n=$(sql "select count(*) from folder_mappings where id = '$MAPPING'")
[[ "$n" == "1" ]] && ok "the mapping survived" || bad "it was deleted"

step "the administrator's views carry no path or filename — M72"
SESSION="$ADMIN_SESSION"
for path in /api/storage/admin/capabilities /api/storage/admin/health /api/storage/admin/queue /api/storage/admin/sync-health; do
  code=$(api GET "$path")
  [[ "$code" == "200" ]] && ok "$path served" || bad "$path returned $code"
  if has 'layoffs-legal-review' || has 'plan.pdf'; then
    bad "$path leaked a name"
  else ok "  and named nothing"; fi
done

n=$(sql "select count(*) from events where kind like 'storage.%' and payload::text like '%layoffs%'")
[[ "$n" == "0" ]] && ok "no folder name in the audit log" || bad "$n audit entries name the folder"

# ---------------------------------------------------------------------------
step "revoking indexing purges immediately — M54"
SESSION="$ALICE_SESSION"
code=$(api PUT "/api/storage/mappings/$MAPPING/indexing" '{"enabled":false}')
[[ "$code" == "200" ]] && ok "indexing revoked ($code)" || bad "returned $code"
for t in documents document_text document_segments; do
  n=$(sql "select count(*) from $t where ${t}_scope is null" 2>/dev/null || echo skip)
done
n=$(sql "select count(*) from documents where mapping_id = '$MAPPING'")
[[ "$n" == "0" ]] && ok "documents purged" || bad "$n documents remain"
n=$(sql "select count(*) from document_text where document_id = '$DOC'")
[[ "$n" == "0" ]] && ok "extracted text purged" || bad "text remains"
n=$(sql "select count(*) from document_segments where document_id = '$DOC'")
[[ "$n" == "0" ]] && ok "segments purged" || bad "segments remain"

code=$(api GET "/api/storage/search?q=$SECRET")
if has "$SECRET"; then bad "search still returns the purged document"; else ok "and search returns nothing"; fi

# ---------------------------------------------------------------------------
step "semantic search is refused in Local-only — M51"
sql "update storage_policy set semantic_enabled = true" >/dev/null
sql "update security_policy set local_only = true" >/dev/null
code=$(api POST /api/storage/semantic/consent '{"provider":"openai"}')
[[ "$code" == "403" ]] && ok "consent refused ($code)" || bad "returned $code: $(body)"
if body | grep -qi 'local-only'; then ok "and says why"; else bad "no reason given"; fi
n=$(sql "select count(*) from semantic_consents")
[[ "$n" == "0" ]] && ok "nothing was recorded" || bad "$n consents recorded"
sql "update security_policy set local_only = false" >/dev/null

step "and is opt-in when Local-only is off"
code=$(api POST /api/storage/semantic/consent '{"provider":"openai"}')
[[ "$code" == "200" ]] && ok "consent accepted ($code)" || bad "returned $code"
code=$(api DELETE /api/storage/semantic/consent)
[[ "$code" == "200" ]] && ok "and can be withdrawn" || bad "returned $code"

# ---------------------------------------------------------------------------
step "the global pause stops new work and keeps search — M75"
DOC2=$(sql "insert into documents (mapping_id, owner_user_id, relative_path, filename, state)
            values ('$MAPPING', '$ALICE_ID', 'b.pdf', 'b.pdf', 'indexed') returning id")
sql "insert into document_segments (document_id, owner_user_id, ordinal, locator_kind, locator, content)
     values ('$DOC2', '$ALICE_ID', 0, 'page', '1', 'pausecheck marker text')" >/dev/null

SESSION="$ADMIN_SESSION"
code=$(api PUT /api/storage/admin/pause '{"paused":true}')
[[ "$code" == "200" ]] && ok "paused ($code)" || bad "returned $code"
if body | grep -q 'Nothing has been deleted'; then ok "and says nothing was deleted"; else bad "no such statement"; fi

SESSION="$ALICE_SESSION"
api GET "/api/storage/search?q=pausecheck" >/dev/null
if has 'pausecheck'; then ok "search still answers while paused"; else bad "search stopped working: $(body)"; fi

step "Sync now cannot bypass the pause — M77"
code=$(api POST "/api/storage/mappings/$MAPPING/sync" '{}')
[[ "$code" == "429" ]] && ok "refused ($code)" || bad "returned $code: $(body)"
if body | grep -q 'paused for the whole installation'; then ok "and says which reason"; else bad "wrong reason"; fi

SESSION="$ADMIN_SESSION"
api PUT /api/storage/admin/pause '{"paused":false}' >/dev/null

step "Sync now is rate-limited — M77"
SESSION="$ALICE_SESSION"
code=$(api POST "/api/storage/mappings/$MAPPING/sync" '{}')
[[ "$code" == "200" ]] && ok "first sync accepted" || bad "returned $code: $(body)"
code=$(api POST "/api/storage/mappings/$MAPPING/sync" '{}')
[[ "$code" == "429" ]] && ok "second refused ($code)" || bad "returned $code"

# ---------------------------------------------------------------------------
step "sharing, and that it cannot be passed on — M69"
SESSION="$ALICE_SESSION"
code=$(api POST "/api/storage/mappings/$MAPPING/share" "{\"userId\":\"$BOB_ID\"}")
[[ "$code" == "200" ]] && ok "shared with bob ($code)" || bad "returned $code: $(body)"

SESSION="$BOB_SESSION"
code=$(api GET "/api/storage/mappings/$MAPPING")
[[ "$code" == "200" ]] && ok "bob can read it" || bad "returned $code"
code=$(api POST "/api/storage/mappings/$MAPPING/share" '{"workspace":true}')
[[ "$code" == "404" ]] && ok "but cannot share it onward" || bad "returned $code"
code=$(api DELETE "/api/storage/mappings/$MAPPING")
[[ "$code" == "404" ]] && ok "and cannot unmap it" || bad "returned $code"

step "the administrator can forbid workspace-wide sharing — M69"
SESSION="$ADMIN_SESSION"
api PUT /api/storage/admin/policy '{"workspaceSharingEnabled":false}' >/dev/null
SESSION="$ALICE_SESSION"
code=$(api POST "/api/storage/mappings/$MAPPING/share" '{"workspace":true}')
[[ "$code" == "403" ]] && ok "broadcast refused ($code)" || bad "returned $code"
code=$(api POST "/api/storage/mappings/$MAPPING/share" "{\"userId\":\"$BOB_ID\"}")
[[ "$code" == "200" ]] && ok "person-to-person still allowed" || bad "returned $code"

# ---------------------------------------------------------------------------
step "history disclosure says copies are not encrypted — M62"
SESSION="$ADMIN_SESSION"
code=$(api PUT /api/storage/admin/policy '{"historyMode":"two","historyKind":"recovery_copy"}')
[[ "$code" == "200" ]] && ok "policy set ($code)" || bad "returned $code"
if body | grep -q 'NOT encrypted by Josi'; then ok "and says so plainly"; else bad "no encryption statement: $(body)"; fi

step "a recovery copy cannot be stored outside Josi's own volume — M60"
n=$(sql "select count(*) from documents where id = '$DOC2'")
[[ "$n" == "1" ]] && ok "a document exists to attach a version to" \
  || bad "no document to test with (DOC2='$DOC2')"

out=$(sqlerr "insert into document_versions (document_id, owner_user_id, ordinal, content_hash, kind, stored_path)
              values ('$DOC2', '$ALICE_ID', 1, 'h', 'recovery_copy', '/data/roots/docs/leak.bin')")
if echo "$out" | grep -qi 'version_stored_inside_josi'; then
  ok "the database refuses it, by name"
else bad "a recovery copy was accepted into a mapped folder: '$(echo "$out" | head -2)'"; fi

step "audit retention deletes only past the window — M73"
sqlerr "insert into events (actor, kind, payload, created_at)
        values ('system','runtime.old','{}'::jsonb, now() - interval '400 days'),
               ('system','runtime.new','{}'::jsonb, now())" >/tmp/ev.log 2>&1
n=$(sql "select count(*) from events where kind like 'runtime.%'")
# A delete that matches nothing raises nothing, so both assertions below would
# pass for the wrong reason if the rows were missing. Establish they exist.
[[ "$n" == "2" ]] && ok "two audit entries exist to test with" \
  || bad "expected 2 audit rows, found '$n': $(head -3 /tmp/ev.log)"

out=$(sqlerr "delete from events where kind = 'runtime.new'")
if echo "$out" | grep -qi 'append-only'; then
  ok "a recent entry cannot be deleted"
else bad "a recent audit entry was deletable: '$(echo "$out" | head -2)'"; fi

out=$(sqlerr "delete from events where kind = 'runtime.old'")
if echo "$out" | grep -qi 'append-only'; then
  bad "retention could not remove an aged entry: '$(echo "$out" | head -2)'"
else ok "an aged entry can be removed"; fi

step "unmapping purges everything derived — M54"
SESSION="$ALICE_SESSION"
code=$(api DELETE "/api/storage/mappings/$MAPPING")
[[ "$code" == "200" ]] && ok "unmapped ($code)" || bad "returned $code: $(body)"
for t in documents document_text document_segments document_versions; do
  n=$(sql "select count(*) from $t")
  [[ "$n" == "0" ]] && ok "$t is empty" || bad "$t still has $n rows"
done

step "no document content reached any container log"
if "${COMPOSE[@]}" logs 2>&1 | grep -qE "$SECRET|SALARY-DATA|SIBLING-PREFIX"; then
  bad "document content appears in a container log"
else
  ok "no document content in any container log"
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
