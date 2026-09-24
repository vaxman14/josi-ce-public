#!/usr/bin/env bash
# Clean-install acceptance for Josi CE.
#
# WHAT THIS IS FOR
#
# Every other script in this repository tests a subsystem. This one tests the
# thing a person actually does: take a machine with nothing on it, follow the
# installation manual, and end up with a working Josi. It is the script that
# would have caught Phase 9's "npm ci fails on a clean host because the lockfile
# never learned about the new workspace" and Phase 10's "the backup volume is
# root-owned while the app runs as node" — two defects that every unit test in
# the repository passed straight through.
#
# It also produces a FAILURE BUNDLE. When a step fails on somebody else's
# hardware, the useful thing is not the exit code, it is everything that was
# true at that moment: container states, the last of each log, resource
# figures, the readiness payload, versions. That is collected into one
# redacted, secret-scanned tarball that can be sent back without reading it
# first.
#
#   bash scripts/acceptance/clean-install.sh                  # default profile
#   bash scripts/acceptance/clean-install.sh --profile n150   # low-resource
#   bash scripts/acceptance/clean-install.sh --keep           # leave it running
#
# PROFILES
#
#   default   whatever the host has
#   n150      Intel N150 / 16 GB — a fanless mini-PC. Constrains the stack to
#             what that box can give and records timings, because "it installs"
#             and "it installs in under ten minutes on the hardware CE targets"
#             are different claims.
#   pi4       Raspberry Pi 4 / 8 GB — arm64, slow storage. NOT YET RUN.
#
# It touches nothing outside its own Compose project.
set -uo pipefail
cd "$(dirname "$0")/../.."

PROJECT="${PROJECT:-josi-ce-acceptance}"
PROFILE="default"
KEEP=0
BUNDLE_DIR="${BUNDLE_DIR:-diagnostics}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-default}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    --project) PROJECT="${2}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose -p "$PROJECT")

pass=0; fail=0; skips=0
declare -a FAILURES=()
declare -a SKIPS=()
ok()   { printf '  PASS  %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; fail=$((fail+1)); FAILURES+=("$*"); }
# Not proven, and saying so. A SKIP is never a PASS: it names the exact external
# dependency that was missing, and it is listed separately in the summary so a
# run that proved less cannot read as a run that proved everything.
skip() { printf '  SKIP  %s\n' "$*"; skips=$((skips+1)); SKIPS+=("$*"); }
step() { printf '\n== %s\n' "$*"; }
note() { printf '        %s\n' "$*"; }

# Measurements, printed at the end and included in the bundle. A capacity claim
# without a number behind it is exactly what M97 forbids.
declare -a MEASUREMENTS=()
measure() { MEASUREMENTS+=("$1=$2"); printf '  TIME  %-28s %s\n' "$1" "$2"; }

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# ---------------------------------------------------------------- the profile

case "$PROFILE" in
  default)
    HOST_LABEL="host defaults"
    MIN_RAM_MB=0
    ;;
  n150)
    # Intel N150: 4 E-cores, no hyperthreading, 16 GB in the usual build. The
    # ceilings below are not a simulation of that box — they are the limits CE
    # should live inside on it, so a run on bigger hardware still catches a
    # component that has quietly grown.
    HOST_LABEL="Intel N150 class / 16 GB"
    MIN_RAM_MB=15000
    export JOSI_OCR_CPUS=0.5
    export JOSI_OCR_MEMORY=384m
    export JOSI_CLAMAV_MEMORY=1200m
    ;;
  pi4)
    HOST_LABEL="Raspberry Pi 4 / 8 GB (arm64)"
    MIN_RAM_MB=7000
    export JOSI_OCR_CPUS=0.5
    export JOSI_OCR_MEMORY=256m
    export JOSI_CLAMAV_MEMORY=900m
    ;;
  *)
    echo "unknown profile: $PROFILE (default|n150|pi4)" >&2; exit 2 ;;
esac

export JOSI_HTTP_PORT="${JOSI_HTTP_PORT:-8480}"
export JOSI_HTTPS_PORT="${JOSI_HTTPS_PORT:-8443}"
# EMPTY, deliberately. A bare hostname here turns Caddy's automatic HTTPS on
# and every plain-HTTP request becomes a 308 to a port that was never mapped.
# That is the defect this run exists to catch, so the run must not configure
# itself around it: empty is what a default installation has.
export JOSI_DOMAIN="${JOSI_DOMAIN:-}"
export JOSI_APP_URL="${JOSI_APP_URL:-http://localhost:${JOSI_HTTP_PORT}}"
# Plain HTTP on a test port, so a `secure` cookie would be dropped by the
# browser and every sign-in would fail for a reason unrelated to the install.
# HTTPS itself is covered by the Phase 2 proxy tests.
export JOSI_COOKIE_SECURE=false
export JOSI_IMAGE="${JOSI_IMAGE:-josi-ce}"
export JOSI_TAG="${JOSI_TAG:-acceptance}"
export POSTGRES_DB="${POSTGRES_DB:-josi}"
export POSTGRES_USER="${POSTGRES_USER:-josi}"

BASE="http://127.0.0.1:${JOSI_HTTP_PORT}"
JAR="$(mktemp)"

# The double-submit CSRF token, as curl stores it: Netscape jar, name in $6.
csrf_token() { awk '$6 == "josi_csrf" {print $7}' "$JAR" 2>/dev/null | tail -1; }

api() {
  local method="$1" path="$2" body="${3:-}"
  local csrf
  csrf="$(csrf_token)"

  # A browser fetches GET /api/auth/csrf before its first state-changing
  # request; so must this. That route is the single always-available auth path
  # (see apps/api/src/http/setupGate.ts), because an installation that has not
  # been set up still has to be able to run the wizard.
  #
  # Without this the script sent no token, every POST was refused 403, and the
  # wizard section reported ten failures that said nothing about the product.
  if [[ -z "$csrf" && "$method" != "GET" && "$method" != "HEAD" ]]; then
    curl -s -o /dev/null -b "$JAR" -c "$JAR" "${BASE}/api/auth/csrf" 2>/dev/null || true
    csrf="$(csrf_token)"
  fi

  local args=(-s -o /tmp/josi-acc-body -w '%{http_code}' -X "$method"
              -b "$JAR" -c "$JAR" -H 'Content-Type: application/json')
  [[ -n "$csrf" ]] && args+=(-H "x-josi-csrf: $csrf")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" "${BASE}${path}" 2>/dev/null
}
body() { cat /tmp/josi-acc-body 2>/dev/null; }

sql() {
  "${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1" 2>/dev/null | tr -d '\r'
}

# ------------------------------------------------------------ failure bundle

# Collected on ANY failure, and on request.
#
# Everything in it is metadata: container states, resource figures, versions,
# the readiness payload, and the tail of each service log. Nothing reads a
# table, and the whole bundle is redacted and then run through the repository's
# own secret scanner before it is handed over — the same discipline Phase 10
# applied to a diagnostics ZIP, for the same reason.
collect_failure_bundle() {
  local reason="$1"
  local stamp bundle work
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d)"
  mkdir -p "$BUNDLE_DIR"
  bundle="${BUNDLE_DIR}/josi-acceptance-${PROFILE}-${stamp}.tar.gz"

  {
    echo "josi-ce clean-install acceptance — FAILURE BUNDLE"
    echo "reason:      $reason"
    echo "profile:     $PROFILE  ($HOST_LABEL)"
    echo "project:     $PROJECT"
    echo "generated:   $stamp"
    echo "passed:      $pass"
    echo "failed:      $fail"
    echo
    echo "failures:"
    printf '  - %s\n' "${FAILURES[@]:-none}"
    echo
    echo "measurements:"
    printf '  %s\n' "${MEASUREMENTS[@]:-none}"
  } > "$work/summary.txt"

  {
    echo "uname:        $(uname -a 2>&1)"
    echo "arch:         $(uname -m 2>&1)"
    echo "docker:       $(docker version --format '{{.Server.Version}}' 2>&1)"
    echo "compose:      $(docker compose version --short 2>&1)"
    echo "cpus:         $(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)"
    if [[ -r /proc/meminfo ]]; then
      echo "memtotal_kb:  $(awk '/MemTotal/ {print $2}' /proc/meminfo)"
    else
      echo "memtotal_kb:  $( (sysctl -n hw.memsize 2>/dev/null || echo 0) | awk '{print int($1/1024)}')"
    fi
    echo "disk:"
    df -h . 2>&1 | sed 's/^/  /'
  } > "$work/host.txt"

  "${COMPOSE[@]}" ps --all > "$work/compose-ps.txt" 2>&1
  "${COMPOSE[@]}" config > "$work/compose-config.txt" 2>&1
  docker stats --no-stream > "$work/docker-stats.txt" 2>&1
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' > "$work/images.txt" 2>&1

  # The tail of each service log. Bounded, because a crash loop produces
  # megabytes and the useful part is always the end.
  mkdir -p "$work/logs"
  for service in $("${COMPOSE[@]}" config --services 2>/dev/null); do
    "${COMPOSE[@]}" logs --no-color --tail 400 "$service" > "$work/logs/${service}.log" 2>&1
  done

  curl -s "${BASE}/ready"  > "$work/ready.json"  2>&1
  curl -s "${BASE}/health" > "$work/health.json" 2>&1
  cp /tmp/josi-acc-body "$work/last-response.txt" 2>/dev/null || true

  # Counts only. A bundle that could carry a row is a bundle nobody can send.
  {
    echo "users=$(sql 'select count(*) from users')"
    echo "threads=$(sql 'select count(*) from threads')"
    echo "messages=$(sql 'select count(*) from messages')"
    echo "migrations=$(sql 'select count(*) from schema_migrations' 2>/dev/null)"
    echo "edition_stamp=$("${COMPOSE[@]}" exec -T web node -e \
      "import('/app/packages/core/dist/edition.js').then(m=>console.log(JSON.stringify(m.describeEdition())))" 2>&1)"
  } > "$work/database-counts.txt" 2>&1

  # REDACTION. Belt: anything that looks like a credential is replaced before
  # the archive is built. Braces: the scanner below runs on the result.
  find "$work" -type f -print0 | while IFS= read -r -d '' file; do
    python3 - "$file" <<'PY'
import re, sys
path = sys.argv[1]
try:
    text = open(path, encoding='utf-8', errors='replace').read()
except OSError:
    sys.exit(0)
patterns = [
    (r'v1\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}', '[sealed value redacted]'),
    (r'\b\d{6,16}:[A-Za-z0-9_-]{30,}\b', '[bot token redacted]'),
    (r'\bsk-[A-Za-z0-9_-]{16,}', '[api key redacted]'),
    (r'(?i)(password|passwd|secret|token|api[_-]?key)(["\s:=]+)([^\s",}]{6,})', r'\1\2[redacted]'),
    (r'postgres(ql)?://[^\s"\']+', 'postgres://[redacted]'),
    (r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}', '[jwt redacted]'),
]
for pattern, replacement in patterns:
    text = re.sub(pattern, replacement, text)
open(path, 'w', encoding='utf-8').write(text)
PY
  done

  tar -czf "$bundle" -C "$work" . 2>/dev/null
  rm -rf "$work"

  printf '\n  BUNDLE  %s (%s)\n' "$bundle" "$(du -h "$bundle" 2>/dev/null | cut -f1)"

  # The last gate. If the repository's own scanner finds something in the
  # bundle, say so loudly rather than handing it over.
  local scratch
  scratch="$(mktemp -d)"
  tar -xzf "$bundle" -C "$scratch" 2>/dev/null
  if bash scripts/scan-secrets.sh "$scratch" >/dev/null 2>&1; then
    printf '  BUNDLE  secret scan clean\n'
  else
    printf '  BUNDLE  !! SECRET SCAN FLAGGED THIS BUNDLE — read it before sending\n'
  fi
  rm -rf "$scratch"
}

cleanup() {
  local status=$?
  if [[ $fail -gt 0 || $status -ne 0 ]]; then
    collect_failure_bundle "$([[ $fail -gt 0 ]] && echo "$fail check(s) failed" || echo "script exited $status")"
  fi
  if [[ $KEEP -eq 1 ]]; then
    printf '\nleaving the stack up (--keep): %s\n' "$BASE"
  else
    step "tearing down (only this project)"
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$JAR" /tmp/josi-acc-body
}
trap cleanup EXIT

# ------------------------------------------------------------------ the run

printf 'Josi CE clean-install acceptance\n'
printf '  profile:  %s (%s)\n' "$PROFILE" "$HOST_LABEL"
printf '  arch:     %s\n' "$(uname -m)"
printf '  project:  %s\n' "$PROJECT"

step "prerequisites"
command -v docker >/dev/null 2>&1 && ok "docker is installed" || { bad "docker is not installed"; exit 1; }
docker info >/dev/null 2>&1 && ok "the docker daemon is reachable" || { bad "the docker daemon is not reachable"; exit 1; }
docker compose version >/dev/null 2>&1 && ok "compose v2 is available" || bad "compose v2 is not available"
command -v python3 >/dev/null 2>&1 && ok "python3 is available (used by this script only)" \
  || bad "python3 is not available"

if [[ "$MIN_RAM_MB" -gt 0 ]]; then
  if [[ -r /proc/meminfo ]]; then
    ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
  else
    ram_mb=$(( $( (sysctl -n hw.memsize 2>/dev/null || echo 0) ) / 1024 / 1024 ))
  fi
  measure "host_ram_mb" "$ram_mb"
  # A note, not a failure. Running the profile on a bigger box is a legitimate
  # smoke test; claiming the profile was VERIFIED on it is not, and the
  # measurement above is what stops that.
  [[ "$ram_mb" -ge "$MIN_RAM_MB" ]] \
    && ok "host memory is in the range this profile describes (${ram_mb} MB)" \
    || note "host has ${ram_mb} MB; the ${PROFILE} profile describes ~${MIN_RAM_MB} MB. Timings below are NOT a ${PROFILE} measurement."
fi

step "starting from nothing"
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
docker image rm -f "${JOSI_IMAGE}:${JOSI_TAG}" >/dev/null 2>&1 || true
containers=$("${COMPOSE[@]}" ps -aq | wc -l | tr -d ' ')
[[ "$containers" == "0" ]] && ok "this project has no containers" || bad "$containers containers remain"
volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')
[[ "$volumes" == "0" ]] && ok "this project has no volumes" || bad "$volumes volumes remain"

step "generating installation secrets"
if [[ -f secrets/master.key && -f secrets/db_password ]]; then
  ok "secrets already exist (left alone — install.sh refuses to overwrite a key)"
else
  JOSI_COMPOSE_SECRETS=1 bash scripts/install.sh >/dev/null 2>&1 \
    && ok "install.sh generated the secrets" \
    || bad "install.sh could not generate the secrets"
fi
[[ -f secrets/master.key ]] && ok "master.key exists" || bad "master.key missing"
# GNU first: on GNU coreutils `stat -f` is "file system status" and SUCCEEDS, so
# a BSD-first chain returns filesystem diagnostics instead of a mode and this
# check compared `?p` against "600" on every Linux host it has ever run on.
perms=$(stat -c '%a' secrets/master.key 2>/dev/null || stat -f '%Lp' secrets/master.key 2>/dev/null)
case "$perms" in '' | *[!0-7]*) perms="unknown" ;; esac
directory_perms=$(stat -c '%a' secrets 2>/dev/null || stat -f '%Lp' secrets 2>/dev/null)
[[ "$directory_perms" == "700" && ( "$perms" == "600" || "$perms" == "400" || "$perms" == "644" ) ]] && ok "master.key is protected by the owner-only secrets directory ($perms)" \
  || bad "master.key permissions are $perms"

step "building the image"
t0=$(now_ms)
if "${COMPOSE[@]}" build web >/tmp/josi-acc-build.log 2>&1; then
  ok "the image built"
else
  bad "the image did not build — see /tmp/josi-acc-build.log"
  tail -20 /tmp/josi-acc-build.log
fi
measure "build_seconds" "$(( ($(now_ms) - t0) / 1000 ))"

size=$(docker image inspect "${JOSI_IMAGE}:${JOSI_TAG}" --format '{{.Size}}' 2>/dev/null || echo 0)
measure "image_bytes" "$size"
measure "image_mb" "$(( size / 1024 / 1024 ))"

step "the edition stamped into the image"
stamped=$("${COMPOSE[@]}" run --rm --no-deps -T web node -e \
  "import('/app/packages/core/dist/edition.js').then(m=>console.log(m.describeEdition().edition))" 2>/dev/null | tr -d '\r')
[[ "$stamped" == "ce" ]] && ok "the image reports edition=ce" || bad "the image reports edition=$stamped"
# The property the whole boundary rests on: the environment cannot widen it.
hosted=$("${COMPOSE[@]}" run --rm --no-deps -T -e JOSI_EDITION=hosted -e JOSI_CAPABILITIES=subscription_auth web node -e \
  "import('/app/packages/core/dist/edition.js').then(m=>console.log(m.describeEdition().edition))" 2>/dev/null | tr -d '\r')
[[ "$hosted" == "ce" ]] && ok "JOSI_EDITION in the environment does not change the artefact" \
  || bad "the environment changed the edition to $hosted"

step "bringing the stack up"
t0=$(now_ms)
"${COMPOSE[@]}" up -d >/tmp/josi-acc-up.log 2>&1 \
  && ok "compose up returned" || bad "compose up failed"

ready=0
for _ in $(seq 1 120); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health" 2>/dev/null)" == "200" ]] && { ready=1; break; }
  sleep 2
done
[[ $ready -eq 1 ]] && ok "/health answered" || bad "/health never answered"
measure "boot_to_health_seconds" "$(( ($(now_ms) - t0) / 1000 ))"

t0=$(now_ms)
green=0
for _ in $(seq 1 120); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/ready" 2>/dev/null)" == "200" ]] && { green=1; break; }
  sleep 2
done
[[ $green -eq 1 ]] && ok "/ready went green" || bad "/ready never went green: $(curl -s "${BASE}/ready")"
measure "health_to_ready_seconds" "$(( ($(now_ms) - t0) / 1000 ))"

step "optional services stayed absent"
for absent in ocr clamav; do
  running=$("${COMPOSE[@]}" ps --services --status running 2>/dev/null | grep -cx "$absent" || true)
  [[ "$running" == "0" ]] && ok "$absent is not running" || bad "$absent is running without its profile"
done
# And the image was never pulled, which is the difference between "off" and
# "downloaded 400 MB and then switched off".
pulled=$(docker images --format '{{.Repository}}' | grep -c clamav || true)
[[ "$pulled" == "0" ]] && ok "the ClamAV image was never pulled" || note "a ClamAV image exists on this host (may predate this run)"

step "the setup wizard is the only thing reachable"
[[ "$(api GET /api/setup/state)" == "200" ]] && ok "the wizard is served" || bad "the wizard is not served"
for path in /api/auth/me /api/admin/users /api/telegram; do
  code=$(api GET "$path")
  [[ "$code" == "503" ]] && ok "refused $path before setup ($code)" || bad "$path returned $code, expected 503"
done

step "completing the wizard"
OWNER_PW="acceptance-password-$RANDOM$RANDOM"
# The one input this run cannot synthesise. Setup will not FINISH with a model
# it has never successfully called (LB4.4), so without a real credential the
# run can prove everything up to that gate and nothing past it.
#
#   JOSI_ACCEPTANCE_LLM_KEY=sk-... bash scripts/acceptance/clean-install.sh
#
# The fixture below is still submitted when none is supplied: it exercises
# sealing, storage and the round trip, and it makes the gate itself testable.
LLM_KEY="${JOSI_ACCEPTANCE_LLM_KEY:-}"
LLM_REAL=1
if [[ -z "$LLM_KEY" ]]; then
  LLM_REAL=0
  LLM_KEY="acceptance-fixture-key-DO-NOT-USE-$RANDOM"
fi
SETUP_DONE=0

# Guards a check that cannot run until setup has finished. Reports the exact
# missing dependency rather than a failure, because "not proven" and "broken"
# are different findings and only one of them is about the product.
needs_setup() {
  [[ $SETUP_DONE -eq 1 ]] && return 0
  skip "$1 — needs a real model credential (set JOSI_ACCEPTANCE_LLM_KEY); setup will not finish with an untested model"
  return 1
}
t0=$(now_ms)
declare -a STEPS=(
  'host_checks|{}'
  "owner|{\"email\":\"owner@acceptance.test\",\"username\":\"owner\",\"password\":\"$OWNER_PW\"}"
  "domain|{\"domain\":\"localhost\",\"tlsMode\":\"bundled_caddy\"}"
  "llm|{\"provider\":\"openai\",\"model\":\"gpt-4o-mini\",\"apiKey\":\"$LLM_KEY\",\"externalAcknowledged\":true}"
  # SKIPPED, and that is the honest answer rather than a convenient one.
  #
  # Configuring mail means PROVING mail can be sent: the step demands an
  # address and actually sends to it (LB4.2), and refuses to record mail as
  # working otherwise. This host has no relay, so a configured step would
  # either fail or — far worse — pass against a fixture and report a mail
  # system that does not exist. `skip` is recorded in the verification table
  # as a decision, which is exactly what it is here.
  #
  # THIS RUN THEREFORE PROVES NOTHING ABOUT SMTP. Sending is covered by the
  # runtime harness in scripts/test-mail-runtime.sh, against a real relay.
  'smtp|{"skip":true}'
  'connectors|{"skip":true}'
  'security|{"folderMappingEnabled":true}'
  'telemetry|{}'
  'review|{}'
)
for entry in "${STEPS[@]}"; do
  name="${entry%%|*}"; payload="${entry#*|}"
  code=$(api POST "/api/setup/steps/$name" "$payload")
  [[ "$code" == "200" ]] && ok "wizard step $name" || bad "wizard step $name returned $code: $(body)"
  # An untested fixture key deliberately leaves the wizard parked on the LLM
  # step. Do not cascade that expected gate into bogus failures for every
  # later step; those steps are covered only when a real acceptance key is
  # supplied.
  if [[ $LLM_REAL -eq 0 && "$name" == "llm" ]]; then
    break
  fi
done
code=$(api POST /api/setup/complete '{}')
if [[ $LLM_REAL -eq 1 ]]; then
  if [[ "$code" == "200" ]]; then SETUP_DONE=1; ok "setup completed"
  else bad "setup completion returned $code: $(body)"; fi
else
  # LB4.4, asserted rather than worked around. An installation that would let
  # itself be declared finished with a model nobody ever called successfully is
  # the exact failure the blocker describes, so the refusal is a PASS here.
  if [[ "$code" == "409" ]] && grep -Eq '"(key|expected)":"llm"' /tmp/josi-acc-body 2>/dev/null; then
    ok "setup refuses to finish with an untested model, and names it ($code)"
  else
    bad "setup completion returned $code with an untested model, expected a 409 naming llm: $(body)"
  fi
fi
measure "wizard_seconds" "$(( ($(now_ms) - t0) / 1000 ))"

step "the wizard closed behind itself"
if needs_setup "the wizard closes behind itself"; then
  code=$(api GET /api/setup/state)
  [[ "$code" == "404" ]] && ok "the wizard is gone ($code)" || bad "the wizard still answers $code"
fi

step "credentials survived the round trip"
# THE PHASE 13 REGRESSION. `seal()` used to store the literal string
# "[secret redacted]" for anything wrapped in `asSecret`, and every existing
# test passed because they all sealed plain strings. On a real installation the
# symptom was a 401 from the provider months later. This opens the stored value
# with the real master key inside the real container and compares it.
enc=$(sql "select api_key_enc from llm_providers where role='primary'")
case "$enc" in
  v1.*) ok "the LLM key is sealed ciphertext" ;;
  *)    bad "the LLM key is not sealed: ${enc:0:24}" ;;
esac
# `-e ENC=` belongs to `compose exec`. It used to sit after the here-string at
# the end of the command, where the shell treated it as an ARGUMENT to node
# rather than an assignment — so process.env.ENC was undefined, openSealed got
# undefined, and the check reported "Cannot read properties of undefined" as if
# the stored credential were wrong.
opened=$("${COMPOSE[@]}" exec -T web node --input-type=module -e "
  import {readFileSync} from 'node:fs';
  import {connectFromEnv,loadMasterKey,openCredentialPayload} from '@josi-ce/core';
  const {db,close}=await connectFromEnv();
  try {
    const [row]=await db.query('select api_key_enc from llm_providers where role=\'primary\'');
    const [owner]=await db.query(\"select id from users where role='super_admin' order by created_at limit 1\");
    const opened=await openCredentialPayload(db,loadMasterKey(),{ownerUserId:owner.id,service:'llm',slot:'primary',stored:row.api_key_enc});
    process.stdout.write(opened.apiKey===readFileSync(0,'utf8').trim()?'match':'mismatch');
  } finally {await close();}
" 2>/dev/null <<< "$LLM_KEY" | tr -d '\r')
if [[ "$opened" == "match" ]]; then
  ok "the stored key opens to exactly what was submitted"
else
  bad "the stored key did not match the submitted credential (values withheld)"
fi

step "signing in"
if needs_setup "the owner can sign in"; then
  code=$(api POST /api/auth/login "{\"identifier\":\"owner\",\"password\":\"$OWNER_PW\"}")
  [[ "$code" == "200" ]] && ok "the owner can sign in" || bad "sign-in returned $code: $(body)"
  code=$(api GET /api/auth/me)
  [[ "$code" == "200" ]] && ok "the session works" || bad "/api/auth/me returned $code"
fi

step "the PWA is installable (Phase 13.2)"
code=$(curl -s -o /tmp/josi-acc-manifest -w '%{http_code}' "${BASE}/manifest.webmanifest")
[[ "$code" == "200" ]] && ok "the manifest is served" || bad "the manifest returned $code"
grep -q '"display": *"standalone"' /tmp/josi-acc-manifest 2>/dev/null \
  && ok "it declares standalone display" || bad "the manifest is not standalone"
sw_headers=$(curl -s -D - -o /dev/null "${BASE}/sw.js")
grep -qi 'cache-control: *no-store' <<< "$sw_headers" \
  && ok "the service worker is served no-store" || bad "sw.js is cacheable — its rules could be pinned"
grep -qi 'service-worker-allowed: */' <<< "$sw_headers" \
  && ok "the worker may take the root scope" || bad "Service-Worker-Allowed is missing"
for icon in icon-192 icon-512 icon-maskable-512; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/icons/${icon}.png")
  [[ "$code" == "200" ]] && ok "icon $icon is served" || bad "icon $icon returned $code"
done
code=$(curl -s -o /tmp/josi-acc-offline -w '%{http_code}' "${BASE}/offline.html")
[[ "$code" == "200" ]] && ok "the offline shell is served" || bad "offline.html returned $code"
grep -qi '<script' /tmp/josi-acc-offline \
  && bad "the offline shell contains a script" || ok "the offline shell runs nothing"
csp=$(curl -s -D - -o /dev/null "${BASE}/app" | grep -i 'content-security-policy')
grep -q "worker-src 'self'" <<< "$csp" && ok "the CSP permits a worker" || bad "worker-src is missing from the CSP"
grep -q "manifest-src 'self'" <<< "$csp" && ok "the CSP permits the manifest" || bad "manifest-src is missing"
grep -qi 'http://\|https://' <<< "$csp" && bad "the CSP names an external origin" \
  || ok "the CSP still names no external origin"

step "Telegram is present, off, and invisible (Phase 13.1)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/telegram/webhook" \
  -H 'Content-Type: application/json' -d '{}')
[[ "$code" == "404" ]] && ok "the webhook is invisible while the channel is off ($code)" \
  || bad "the webhook returned $code with no secret and the channel off"
# Two questions, and one request could not answer both. An unauthenticated POST
# to any /api path is refused by the CSRF middleware BEFORE routing, so this
# expected a 404 it could never see — every /api path answers 403 there.
#
# So ask separately. Without a token: 403, proving the path carries no CSRF
# exemption. With one: 404, proving no webhook route exists inside /api at all.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/telegram/webhook")
[[ "$code" == "403" ]] && ok "an /api webhook path has no CSRF exemption ($code)" \
  || bad "/api/telegram/webhook without a token returned $code, expected 403"
# Both of these are behind the setup gate, which answers 503 for every /api
# path until the installation is finished — so neither can be read before then.
if needs_setup "no webhook route exists inside /api"; then
  code=$(api POST /api/telegram/webhook '{}')
  [[ "$code" == "404" ]] && ok "there is no webhook inside /api at all ($code)" \
    || bad "/api/telegram/webhook with a valid token returned $code, expected 404"
fi
if needs_setup "the Telegram admin surface"; then
  code=$(api GET /api/admin/telegram)
  [[ "$code" == "200" ]] && ok "the admin surface is reachable by the owner" || bad "admin telegram returned $code"
  grep -q '"tokenSet":false' /tmp/josi-acc-body && ok "no bot token is configured, as shipped" \
    || note "a bot token is already configured on this installation"
fi

step "subscription authentication is offered honestly (Phase 13.3)"
if needs_setup "the subscription-auth options"; then
  code=$(api GET /api/admin/llm)
  if [[ "$code" != "200" ]]; then
    bad "admin llm returned $code"
  else
    ok "the model screen loads"

    # TWO defects lived here, and between them this section never checked
    # anything at all.
    #
    # `python3 - <<'PY' < /tmp/josi-acc-body` gives python TWO stdin
    # redirections, and the later one wins — so the JSON body was read as the
    # PROGRAM and the heredoc was never seen. Every run of this block died with
    # `NameError: name 'null' is not defined`. The file is opened by name now.
    #
    # And the verdicts were printed straight to stdout, where the summary could
    # not see them: they were never added to the pass or fail counts, so the
    # traceback above sat in a run that reported "0 failed". They come back as
    # `PASS|message` now and bash counts every one.
    verdicts=$(python3 <<'PY'
import json
out = []
def check(cond, msg): out.append(("PASS" if cond else "FAIL") + "|" + msg)
try:
    with open("/tmp/josi-acc-body") as fh:
        data = json.load(fh)
except Exception as exc:
    print("FAIL|could not read the model payload: %s" % exc)
else:
    options = {o["id"]: o for o in data.get("subscriptionOptions", [])}
    chatgpt = options.get("chatgpt_subscription", {})
    claude = options.get("claude_subscription", {})
    check(data.get("edition", {}).get("edition") == "ce", "the running app reports edition=ce")
    check(chatgpt.get("available") is True, "the ChatGPT/Codex path is offered on a CE build")
    check(claude.get("available") is False, "the Claude path is not offered")
    check("4 April 2026" in (claude.get("reason") or ""),
          "and it cites the policy rather than promising a date")
    check(all("coming soon" not in (o.get("reason") or "").lower() for o in options.values()),
          "no option says 'coming soon'")
    print("\n".join(out))
PY
)
    if [[ -z "$verdicts" ]]; then
      bad "the subscription-auth checks produced no verdict at all"
    else
      while IFS='|' read -r verdict msg; do
        [[ -z "$verdict" ]] && continue
        [[ "$verdict" == "PASS" ]] && ok "$msg" || bad "$msg"
      done <<< "$verdicts"
    fi
  fi
fi

step "resource use with the stack idle"
sleep 5
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' \
  $("${COMPOSE[@]}" ps -q) 2>/dev/null | sed 's/^/  USE   /'
total_mem=$(docker stats --no-stream --format '{{.MemUsage}}' $("${COMPOSE[@]}" ps -q) 2>/dev/null \
  | awk '{print $1}' | sed 's/MiB//;s/GiB/*1024/' | paste -sd+ - | bc 2>/dev/null || echo 0)
measure "idle_memory_mib_total" "${total_mem:-unknown}"

step "the audit trail recorded the install, and no content"
events=$(sql "select count(*) from events")
[[ "${events:-0}" -gt 0 ]] && ok "$events audit events were written" || bad "no audit events"
leak=$(sql "select count(*) from events where payload::text like '%$LLM_KEY%' or payload::text like '%$OWNER_PW%'")
[[ "$leak" == "0" ]] && ok "no credential reached an audit payload" || bad "$leak audit rows contain a credential"

# ------------------------------------------------------------------ the report

printf '\n%s\n' "----------------------------------------------------------------"
printf 'profile:      %s (%s)\n' "$PROFILE" "$HOST_LABEL"
printf 'arch:         %s\n' "$(uname -m)"
printf 'measurements:\n'
printf '  %s\n' "${MEASUREMENTS[@]}"
printf '\n%d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skips"

if [[ $fail -gt 0 ]]; then
  printf '\nfailures:\n'
  printf '  - %s\n' "${FAILURES[@]}"
fi

# Listed even on a clean run, and never folded into the pass count: a run that
# proved less has to say so out loud, next to the number that looks like proof.
if [[ $skips -gt 0 ]]; then
  printf '\nnot proven by this run:\n'
  printf '  - %s\n' "${SKIPS[@]}"
fi

exit $(( fail == 0 ? 0 : 1 ))
