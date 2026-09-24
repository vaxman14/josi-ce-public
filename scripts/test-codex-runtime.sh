#!/usr/bin/env bash
# LB2 runtime verification: the ChatGPT subscription path, inside the real
# container stack.
#
# WHAT THIS PROVES WITHOUT ANY CREDENTIAL, and it is the part that kept
# breaking:
#
#   * the pinned Codex CLI is actually in the image and runs there;
#   * CODEX_HOME points at a NAMED VOLUME rather than the container filesystem;
#   * that volume survives the container being replaced, which is what an
#     update does. A device login that a `docker compose pull && up -d` throws
#     away is a device login the operator repeats on every update, and the
#     container is read-only, so anything written outside the volume is either
#     refused or lost;
#   * `codex login status` reports signed-out honestly on a fresh volume,
#     rather than erroring in a way the wizard would show as a broken install.
#
# WHAT IT CANNOT PROVE HERE, and says so instead of implying otherwise: that a
# real ChatGPT account can complete the device flow. That needs a person with a
# browser and a subscription, and it is reported SKIPPED with that dependency
# named. SKIPPED is not PASS.
#
#   PROJECT=josi-ce-codex bash scripts/test-codex-runtime.sh
set -uo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-josi-ce-codex-runtime}"
COMPOSE=(docker compose -p "$PROJECT")
export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-8481}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-8444}"
export JOSI_DOMAIN=""
export JOSI_APP_URL="http://localhost:${JOSI_HTTP_PORT}"
export JOSI_COOKIE_SECURE=false
export JOSI_TAG="${JOSI_TAG:-codex-runtime}"

pass=0; fail=0; skips=0
declare -a FAILURES=() SKIPS=()
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); FAILURES+=("$*"); }
skip() { printf '  SKIP  %s\n' "$*"; skips=$((skips+1)); SKIPS+=("$*"); }
step() { printf '\n== %s\n' "$*"; }

cleanup() {
  step "tearing down (only this project)"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1
}
trap cleanup EXIT

printf 'Josi CE — Codex subscription runtime verification\n  project:  %s\n  arch:     %s\n' \
  "$PROJECT" "$(uname -m)"

step "building and starting"
if ! "${COMPOSE[@]}" build web >/dev/null 2>&1; then
  bad "the image did not build"; exit 1
fi
ok "the image built"
if ! "${COMPOSE[@]}" up -d db migrate web >/dev/null 2>&1; then
  bad "the stack did not start"; exit 1
fi
ok "the stack started"

# The web container is where the wizard runs the CLI, so it is the only place
# worth asking. `exec` rather than `run`: a fresh `run` container would get its
# own view and prove nothing about the one actually serving.
in_web() { "${COMPOSE[@]}" exec -T web "$@" 2>&1; }

step "the CLI is present, pinned, and runnable in the image"
pin=$(grep -oE 'ARG JOSI_CODEX_VERSION=[0-9.]+' Dockerfile | cut -d= -f2)
[[ -n "$pin" ]] && ok "the Dockerfile pins a concrete version ($pin)" \
  || bad "the Dockerfile does not pin a Codex version"

version=$(in_web codex --version | tr -d '\r' | tail -1)
if [[ "$version" == *"$pin"* ]]; then
  ok "the running container reports that exact version ($version)"
else
  bad "the container reports '$version', which does not contain the pin '$pin'"
fi

step "CODEX_HOME is a durable volume, not the container filesystem"
home=$(in_web sh -c 'printf %s "$CODEX_HOME"' | tr -d '\r')
[[ "$home" == "/data/codex" ]] && ok "CODEX_HOME is $home" || bad "CODEX_HOME is '$home', expected /data/codex"

# The container is read_only. If CODEX_HOME were not a volume this write fails,
# which is the failure mode worth catching: a login that appears to work and is
# gone the moment the container stops.
marker="codex-volume-probe-$$-$(date +%s)"
if in_web sh -c "printf %s '$marker' > \"\$CODEX_HOME/.probe\"" >/dev/null; then
  ok "the CLI's home is writable from inside a read-only container"
else
  bad "the CLI's home is not writable — a device login would have nowhere to go"
fi

mounted=$("${COMPOSE[@]}" ps -q web | xargs -r docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/data/codex"}}{{.Type}} {{.Name}}{{end}}{{end}}' 2>/dev/null | tr -d '\r')
case "$mounted" in
  volume*) ok "/data/codex is a named volume ($mounted)" ;;
  "")      bad "/data/codex is not mounted at all" ;;
  *)       bad "/data/codex is mounted as '$mounted', not a named volume" ;;
esac

step "the login survives the container being replaced (what an update does)"
old_id=$("${COMPOSE[@]}" ps -q web | tr -d '\r')
if ! "${COMPOSE[@]}" up -d --force-recreate web >/dev/null 2>&1; then
  bad "the container could not be recreated"
else
  new_id=$("${COMPOSE[@]}" ps -q web | tr -d '\r')
  if [[ -n "$old_id" && -n "$new_id" && "$old_id" != "$new_id" ]]; then
    ok "the container really was replaced (${old_id:0:12} -> ${new_id:0:12})"
  else
    bad "the container was not replaced, so this proves nothing"
  fi
  # Health first: reading the marker out of a container that never started
  # would be a false negative about the volume.
  for _ in $(seq 1 60); do
    [[ "$(in_web sh -c 'echo up' | tr -d '\r')" == "up" ]] && break
    sleep 2
  done
  read_back=$(in_web sh -c 'cat "$CODEX_HOME/.probe" 2>/dev/null' | tr -d '\r')
  if [[ "$read_back" == "$marker" ]]; then
    ok "the replacement container reads back exactly what the old one wrote"
  else
    bad "the marker did not survive: read '$read_back', expected '$marker'"
  fi
fi
in_web sh -c 'rm -f "$CODEX_HOME/.probe"' >/dev/null

step "signed-out is reported honestly rather than as a broken install"
# `codex login status` exits non-zero when signed out. The provider treats that
# as "not logged in"; the failure worth catching is the CLI being absent or
# unrunnable, which looks the same to a caller that only checks the exit code.
status_out=$(in_web codex login status | tr -d '\r')
status_code=$?
if grep -qi "not logged in\|not authenticated\|no credentials\|logged out" <<< "$status_out"; then
  ok "a fresh volume reports signed out in words ($(head -c 60 <<< "$status_out"))"
elif [[ $status_code -eq 0 ]]; then
  skip "this volume is already signed in, so the signed-out wording was not exercised"
else
  bad "signed-out status was not recognisable: $(head -c 120 <<< "$status_out")"
fi

step "completing a real device login"
skip "a real ChatGPT sign-in — needs a person with a browser and a ChatGPT subscription to approve the device code; the flow itself is covered by packages/llm/test/codexLogin.test.ts against a byte-for-byte capture of the pinned CLI's output"

printf '\n%s\n' "----------------------------------------------------------------"
printf '%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skips"
if [[ $fail -gt 0 ]]; then
  printf '\nfailures:\n'; printf '  - %s\n' "${FAILURES[@]}"
fi
if [[ $skips -gt 0 ]]; then
  printf '\nnot proven by this run:\n'; printf '  - %s\n' "${SKIPS[@]}"
fi
[[ $fail -eq 0 ]]
