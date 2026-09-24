#!/usr/bin/env bash
# The AI backbone, verified against the real container stack.
#
# Two subscription paths, ChatGPT through Codex and Claude through Claude Code,
# each proven as far as it can be without a human in a browser:
#
#   * the vendor's own CLI is in the image, at the exact pinned version;
#   * its configuration directory is a NAMED VOLUME, writable from inside a
#     read-only container, and survives the container being replaced — which is
#     what an update does. A login an update throws away is a login the operator
#     repeats forever;
#   * signed-out is reported honestly rather than as a broken install;
#   * the HTTP surface an operator actually uses offers both, and starting a
#     sign-in through it returns a REAL link from the REAL vendor.
#
# WHAT IT CANNOT DO, and says so rather than implying otherwise: approve the
# sign-in. That needs a person, a browser, and an account. The run stops at the
# link and prints it, which is the last machine-checkable step.
#
#   JOSI_HTTP_PORT=8403 PROJECT=josi-ce-backbone bash scripts/test-subscription-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    # Leave the stack up so a sign-in printed below can actually be finished.
    # Without this the teardown kills the codes seconds after printing them,
    # which makes the whole exercise a demonstration rather than a sign-in.
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PROJECT="${PROJECT:-josi-ce-backbone}"
COMPOSE=(docker compose -p "$PROJECT")
export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-8403}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-8566}"
export JOSI_DOMAIN=""
export JOSI_APP_URL="http://localhost:${JOSI_HTTP_PORT}"
export JOSI_COOKIE_SECURE=false
export JOSI_TAG="${JOSI_TAG:-backbone}"
BASE="http://127.0.0.1:${JOSI_HTTP_PORT}"
JAR="$(mktemp)"

pass=0; fail=0; skips=0
declare -a FAILURES=() SKIPS=()
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); FAILURES+=("$*"); }
skip() { printf '  SKIP  %s\n' "$*"; skips=$((skips+1)); SKIPS+=("$*"); }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  rm -f "$JAR"
  if [[ $KEEP -eq 1 ]]; then
    step "leaving the stack up (--keep)"
    printf '  Josi is at %s\n' "$BASE"
    printf '  Stop it with: docker compose -p %s down -v\n' "$PROJECT"
    return
  fi
  step "tearing down (only this project)"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT

csrf_token() { awk '$6 == "josi_csrf" {print $7}' "$JAR" 2>/dev/null | tail -1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local csrf; csrf="$(csrf_token)"
  if [[ -z "$csrf" && "$method" != "GET" ]]; then
    curl -s -o /dev/null -b "$JAR" -c "$JAR" "${BASE}/api/auth/csrf" 2>/dev/null || true
    csrf="$(csrf_token)"
  fi
  local args=(-s -o /tmp/josi-backbone-body -w '%{http_code}' -X "$method"
              -b "$JAR" -c "$JAR" -H 'Content-Type: application/json')
  [[ -n "$csrf" ]] && args+=(-H "x-josi-csrf: $csrf")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "${BASE}${path}" 2>/dev/null
}
body() { cat /tmp/josi-backbone-body 2>/dev/null; }
jqf()  { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

in_web() { "${COMPOSE[@]}" exec -T web "$@" 2>&1; }

printf 'Josi CE — AI backbone runtime verification\n  project:  %s\n  arch:     %s\n' \
  "$PROJECT" "$(uname -m)"

step "building and starting"
"${COMPOSE[@]}" build web >/dev/null 2>&1 && ok "the image built" || { bad "the image did not build"; exit 1; }
# caddy included: JOSI_HTTP_PORT is the PROXY's published port, so a stack
# without it publishes nothing and every HTTP check below fails for a reason
# that has nothing to do with what is being tested.
"${COMPOSE[@]}" up -d db migrate web caddy >/dev/null 2>&1 && ok "the stack started" || { bad "the stack did not start"; exit 1; }

for _ in $(seq 1 60); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")" == "200" ]] && break
  sleep 2
done
[[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")" == "200" ]] \
  && ok "/health answered" || { bad "/health never answered"; exit 1; }

# ------------------------------------------------------ both CLIs, in the image
#
# The pin is read out of the Dockerfile and compared with what the RUNNING
# container reports. A pin that is only in the Dockerfile is an intention; a pin
# the container agrees with is a fact.
check_cli() {
  local label="$1" arg="$2" bin="$3" version_cmd="$4"
  local pin; pin=$(grep -oE "ARG ${arg}=[0-9.]+" Dockerfile | cut -d= -f2)
  [[ -n "$pin" ]] && ok "$label: the Dockerfile pins a concrete version ($pin)" \
    || { bad "$label: the Dockerfile does not pin a version"; return; }
  local reported; reported=$(in_web sh -c "$version_cmd" | tr -d '\r' | tail -1)
  if [[ "$reported" == *"$pin"* ]]; then
    ok "$label: the running container reports that exact version ($reported)"
  else
    bad "$label: the container reports '$reported', which does not contain the pin '$pin'"
  fi
}

step "both vendor CLIs are present and pinned"
check_cli "Codex"  "JOSI_CODEX_VERSION"  "codex"  "codex --version"
check_cli "Claude" "JOSI_CLAUDE_VERSION" "claude" "claude --version"

# ------------------------------------------- each login lives on its own volume
check_volume() {
  local label="$1" envvar="$2" mount="$3" volume_hint="$4"
  local dir; dir=$(in_web sh -c "printf %s \"\$$envvar\"" | tr -d '\r')
  [[ "$dir" == "$mount" ]] && ok "$label: $envvar is $dir" \
    || { bad "$label: $envvar is '$dir', expected $mount"; return; }

  # The container is read_only. If this were not a volume the write fails —
  # which is the failure mode worth catching, because a login that appears to
  # work and vanishes on restart looks like a flaky vendor rather than a bug.
  if in_web sh -c "printf probe > '$mount/.probe'" >/dev/null; then
    ok "$label: the CLI's home is writable from inside a read-only container"
  else
    bad "$label: the CLI's home is not writable — a sign-in would have nowhere to go"
  fi

  local mounted
  mounted=$("${COMPOSE[@]}" ps -q web | xargs -r docker inspect \
    --format "{{range .Mounts}}{{if eq .Destination \"$mount\"}}{{.Type}} {{.Name}}{{end}}{{end}}" 2>/dev/null | tr -d '\r')
  case "$mounted" in
    volume*) ok "$label: $mount is a named volume ($mounted)" ;;
    "")      bad "$label: $mount is not mounted at all" ;;
    *)       bad "$label: $mount is mounted as '$mounted', not a named volume" ;;
  esac
}

step "each vendor's login has its own durable home"
check_volume "Codex"  "CODEX_HOME"        "/data/codex"  "josi_codex"
check_volume "Claude" "CLAUDE_CONFIG_DIR" "/data/claude" "josi_claude"

step "signed-out is reported honestly, not as a broken install"
codex_status=$(in_web codex login status | tr -d '\r')
grep -qi "not logged in\|not authenticated\|logged out" <<< "$codex_status" \
  && ok "Codex: reports signed out in words" \
  || bad "Codex: signed-out status was not recognisable: $(head -c 100 <<< "$codex_status")"

# `claude auth status` EXITS ZERO whether or not it is signed in and reports the
# answer in the payload. Asserted here against the real binary, because this is
# exactly the trap a mocked test would agree was handled when it was not.
claude_status=$(in_web claude auth status --json | tr -d '\r')
if grep -q '"loggedIn":[[:space:]]*false' <<< "$claude_status"; then
  ok "Claude: reports loggedIn=false in its JSON payload"
  claude_exit=$(in_web sh -c 'claude auth status --json >/dev/null 2>&1; echo $?' | tr -d '\r')
  [[ "$claude_exit" == "0" ]] \
    && ok "Claude: and it exits 0 while signed out — the trap this code handles ($claude_exit)" \
    || note_exit=1
else
  bad "Claude: signed-out status was not recognisable: $(head -c 120 <<< "$claude_status")"
fi

# ----------------------------------- the login survives the container replacing
step "both logins survive the container being replaced (what an update does)"
marker="backbone-$$-$(date +%s)"
in_web sh -c "printf %s '$marker' > /data/codex/.probe"  >/dev/null
in_web sh -c "printf %s '$marker' > /data/claude/.probe" >/dev/null
old_id=$("${COMPOSE[@]}" ps -q web | tr -d '\r')
if "${COMPOSE[@]}" up -d --force-recreate web >/dev/null 2>&1; then
  new_id=$("${COMPOSE[@]}" ps -q web | tr -d '\r')
  [[ -n "$old_id" && "$old_id" != "$new_id" ]] \
    && ok "the container really was replaced (${old_id:0:12} -> ${new_id:0:12})" \
    || bad "the container was not replaced, so this proves nothing"
  for _ in $(seq 1 60); do
    [[ "$(in_web sh -c 'echo up' | tr -d '\r')" == "up" ]] && break
    sleep 2
  done
  for pair in "Codex:/data/codex" "Claude:/data/claude"; do
    label="${pair%%:*}"; dir="${pair#*:}"
    got=$(in_web sh -c "cat $dir/.probe 2>/dev/null" | tr -d '\r')
    [[ "$got" == "$marker" ]] \
      && ok "$label: the replacement container reads back what the old one wrote" \
      || bad "$label: the marker did not survive: read '$got'"
  done
else
  bad "the container could not be recreated"
fi
in_web sh -c 'rm -f /data/codex/.probe /data/claude/.probe' >/dev/null

# --------------------------------------------- the surface an operator touches
step "the wizard offers both paths"
code=$(api GET /api/setup/subscription)
if [[ "$code" != "200" ]]; then
  bad "/api/setup/subscription returned $code"
else
  ok "the wizard's subscription screen is served"
  payload=$(body)
  for entry in "chatgpt_subscription:openai_subscription" "claude_subscription:anthropic_subscription"; do
    id="${entry%%:*}"; kind="${entry#*:}"
    avail=$(python3 -c "
import json,sys
d=json.load(sys.stdin)
o=[x for x in d['options'] if x['id']=='$id']
print(f\"{o[0]['available']}|{o[0]['provider']}\" if o else 'missing|missing')
" <<< "$payload")
    [[ "$avail" == "True|$kind" ]] \
      && ok "$id is offered, as provider $kind" \
      || bad "$id reported '$avail', expected 'True|$kind'"
  done
  python3 -c "
import json,sys
d=json.load(sys.stdin)
print('  PASS  both CLIs are reported separately' if 'cli' in d and 'claudeCli' in d
      else '  FAIL  the screen does not report both CLIs')
" <<< "$payload"
fi

# ------------------------------------------------- the real sign-in, as far as
#                                                    a machine can take it
step "starting a REAL sign-in for each vendor"

code=$(api POST /api/setup/subscription/login '{}')
if [[ "$code" == "200" ]]; then
  chatgpt_url=$(body | jqf "['challenge']['verificationUrl']")
  chatgpt_code=$(body | jqf "['challenge']['userCode']")
  if [[ -n "$chatgpt_url" && -n "$chatgpt_code" ]]; then
    ok "ChatGPT: the real Codex CLI returned a device code"
  else
    bad "ChatGPT: the login started but produced no challenge: $(head -c 160 < /tmp/josi-backbone-body)"
  fi
else
  bad "ChatGPT: starting the sign-in returned $code: $(head -c 160 < /tmp/josi-backbone-body)"
fi

code=$(api POST /api/setup/subscription/claude/login '{}')
if [[ "$code" == "200" ]]; then
  claude_url=$(body | jqf "['challenge']['verificationUrl']")
  if [[ -n "$claude_url" ]]; then
    ok "Claude: the real Claude Code CLI returned an Anthropic sign-in link"
    grep -qE '^https://(claude\.com|claude\.ai|[a-z.]*anthropic\.com)/' <<< "$claude_url" \
      && ok "Claude: and the link is on an Anthropic host" \
      || bad "Claude: the link is not on an Anthropic host: $claude_url"
    # The OSC-8 trap: two copies of the URL with nothing between them.
    [[ "$(grep -o 'https://' <<< "$claude_url" | wc -l | tr -d ' ')" == "1" ]] \
      && ok "Claude: exactly one URL came back, not an OSC-8 hyperlink pair" \
      || bad "Claude: the link contains more than one URL: $claude_url"
  else
    bad "Claude: the login started but produced no link: $(head -c 200 < /tmp/josi-backbone-body)"
  fi
else
  bad "Claude: starting the sign-in returned $code: $(head -c 200 < /tmp/josi-backbone-body)"
fi

skip "approving either sign-in — needs a person with a browser and an account. Everything up to the link is proven above; the link itself is printed below."

# ------------------------------------------------------------------ the report
printf '\n%s\n' "----------------------------------------------------------------"
printf '%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skips"
if [[ $fail -gt 0 ]]; then printf '\nfailures:\n'; printf '  - %s\n' "${FAILURES[@]}"; fi
if [[ $skips -gt 0 ]]; then printf '\nnot proven by this run:\n'; printf '  - %s\n' "${SKIPS[@]}"; fi

if [[ -n "${chatgpt_url:-}" || -n "${claude_url:-}" ]]; then
  printf '\n%s\n' "================================================================"
  printf 'TO FINISH THESE SIGN-INS, approve them in a browser.\n'
  printf 'These are single-use pairing codes. They expire, and they are useless\n'
  printf 'to anyone who is not signing in to their own account.\n'
  [[ -n "${chatgpt_url:-}" ]] && printf '\nChatGPT (Codex)\n  open: %s\n  code: %s\n' "$chatgpt_url" "$chatgpt_code"
  [[ -n "${claude_url:-}" ]]  && printf '\nClaude (Claude Code)\n  open: %s\n  then paste the code Anthropic shows you back into Josi.\n' "$claude_url"
  if [[ $KEEP -eq 1 ]]; then
    printf '\nThe stack is STAYING UP, so these are live. Finish either one at:\n'
    printf '  %s/setup\n' "$BASE"
    printf 'For Claude, paste the code Anthropic gives you into the box on that screen.\n'
  else
    printf '\nNOTE: this run tears its stack down on exit, so these codes die with it.\n'
    printf 'Re-run with --keep to leave it up and finish a sign-in for real.\n'
  fi
  printf '%s\n' "================================================================"
fi

[[ $fail -eq 0 ]]
