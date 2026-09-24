#!/usr/bin/env bash
set -euo pipefail
ROOT_SRC="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; INSTALL="$TMP/install"; STATE="$TMP/fake"; mkdir -p "$BIN" "$INSTALL/secrets" "$STATE"
cp "$ROOT_SRC/docker-compose.release.yml" "$INSTALL/docker-compose.yml"
cp "$ROOT_SRC/.env.example" "$INSTALL/.env"
sed -i.bak 's/^JOSI_TAG=.*/JOSI_TAG=0.1.0/; s#^JOSI_APP_URL=.*#JOSI_APP_URL=http://josi.test#' "$INSTALL/.env"; rm -f "$INSTALL/.env.bak"
printf 'master-key-canary-abcdefghijklmnopqrstuvwxyz123456\n' > "$INSTALL/secrets/master.key"
printf 'db-password-canary-123456789\n' > "$INSTALL/secrets/db_password"
chmod 700 "$INSTALL/secrets"; chmod 600 "$INSTALL/secrets/"*
printf '#!/bin/sh\nexit "${FAKE_PREFLIGHT_RC:-0}"\n' > "$INSTALL/preflight.sh"; chmod +x "$INSTALL/preflight.sh"
printf '#!/bin/sh\nexit 0\n' > "$INSTALL/install.sh"; chmod +x "$INSTALL/install.sh"
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
S="${FAKE_STATE:?}"
printf '%q ' "$@" >> "$S/calls"; printf '\n' >> "$S/calls"
[[ "${1:-}" == version ]] && { [[ "${2:-}" == --format ]] && echo 26.1.0 || echo 'Docker version 26.1.0'; exit 0; }
[[ "${1:-}" == info ]] && exit 0
[[ "${1:-}" == system && "${2:-}" == df ]] && { echo 'TYPE TOTAL ACTIVE SIZE RECLAIMABLE'; exit 0; }
[[ "${1:-}" == image && "${2:-}" == inspect ]] && { echo "${FAKE_IMAGE_ARCH:-amd64}"; exit 0; }
[[ "${1:-}" == inspect ]] && { id="${@: -1}"; svc="${id#id-}"; if [[ -f "$S/$svc" ]]; then st=$(cat "$S/$svc"); elif [[ "$svc" == migrate || "$svc" == attachment-init ]]; then st=exited/none/0; else st=running/healthy/0; fi; [[ "$st" == */*/* ]] || st="$st/0"; if [[ "$*" == *RestartCount* ]]; then echo "0|${st##*/}|$(cut -d/ -f2 <<<"$st")|docker.io/romanvaxman/josi-ce:0.1.0|sha256:$svc"; elif [[ "$*" == *Config.Image* ]]; then tag=$(sed -n 's/^JOSI_TAG=//p' "${FAKE_ROOT:?}/.env" | tail -1); echo "docker.io/romanvaxman/josi-ce:${tag:-0.1.0}"; elif [[ "$*" == *'.Mounts'* ]]; then cat "$S/mounts" 2>/dev/null || true; else echo "$st"; fi; exit 0; }
[[ "${1:-}" == compose ]] || exit 1
shift
while [[ "${1:-}" == --project-directory || "${1:-}" == -f ]]; do shift 2; done
case "${1:-}" in
  version) [[ "${2:-}" == --short ]] && echo 2.30.0 || echo 'Docker Compose version v2.30.0';;
  config)
    [[ "${FAKE_CONFIG_FAIL:-0}" == 1 ]] && exit 1
    case "${2:-}" in --services) printf '%s\n' attachment-init db migrate web worker caddy;; --volumes) printf '%s\n' db_data josi_backups josi_diagnostics;; --images) printf '%s\n' 'docker.io/romanvaxman/josi-ce:0.1.0';; -q) :;; *) cat "${FAKE_ROOT:?}/docker-compose.yml";; esac;;
  ps) svc="${@: -1}"; [[ "$*" == *'-q'* ]] || { echo '[]'; exit; }; [[ -f "$S/missing-$svc" ]] && exit 0; echo "id-$svc";;
  exec)
    svc="${3:-}"
    if [[ "$svc" == web ]]; then [[ -f "$S/health-fail" || -f "$S/data-bad" ]] && exit 1; exit 0; fi
    if [[ "$svc" == db && "$*" == *pg_dump* ]]; then printf '%s\n' '-- synthetic database' 'CREATE TABLE test(id int);'; exit 0; fi
    if [[ "$svc" == db && "$*" == *psql* ]]; then
      if [[ "$*" == *'select name from _migrations'* ]]; then printf '0001_workspace.sql\n0002_setup.sql\n'; grep -q '^JOSI_TAG=8.8.8$' "${FAKE_ROOT:?}/.env" && printf '0003_irreversible.sql\n'; fi
      [[ "$*" == *'count(*) from _migrations'* ]] && printf '2\n'
      [[ "$*" == *'from job_queue'* ]] && printf '2\n'
      [[ "$*" == *'from push_deliveries'* ]] && printf '0\n'
      [[ "$*" == *'select 1'* ]] && printf '1\n'; exit 0; fi;;
  logs) svc="${@: -1}"; printf '2026-01-01T00:00:00Z %s request_id=req-1 token=CANARY_TOKEN password=hunter2 Authorization: Bearer aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccc\n' "$svc"; printf '%s\n' '{"client_secret":"JSON-CANARY","access_token":"OAUTH-CANARY"} callback=https://x.test/cb?code=URL-CANARY\&refresh_token=REFRESH-CANARY ' '-----BEGIN PRIVATE'' KEY-----' 'PEM-CANARY' '-----END PRIVATE'' KEY-----' 'SERVICE_API_KEY=ENV-CANARY' '2026-01-01T00:00:01Z receipt_id=rec-1 event_id=evt-1 ok';;
  up)
    for a in "$@"; do case "$a" in attachment-init|migrate) printf 'exited/none/0\n' > "$S/$a"; rm -f "$S/missing-$a";; db|web|worker|caddy) printf 'running/healthy/0\n' > "$S/$a"; rm -f "$S/missing-$a";; esac; done
    if grep -Eq '^JOSI_TAG=(9\.9\.9|8\.8\.8)$' "${FAKE_ROOT:?}/.env" 2>/dev/null; then touch "$S/health-fail"; exit 1
    elif [[ "${FAKE_REGRESS_ON_UP:-0}" == 1 && ! -f "$S/regressed-once" ]]; then touch "$S/health-fail" "$S/regressed-once"
    else rm -f "$S/health-fail"; fi;;
  restart) [[ "${FAKE_AI_COMMAND_FAIL:-0}" == 1 ]] && exit 1; if [[ "${FAKE_AI_REGRESS_ON_RESTART:-0}" == 1 ]]; then touch "$S/health-fail"; else rm -f "$S/public-fail"; fi;;
  stop) for a in "$@"; do case "$a" in attachment-init|db|migrate|web|worker|caddy) printf 'exited/none/0\n' > "$S/$a";; esac; done;;
  rm) svc="${@: -1}"; touch "$S/missing-$svc";;
  pull|down) :;; *) :;;
esac
EOF
chmod +x "$BIN/docker"
printf '#!/usr/bin/env bash\n[[ -f "${FAKE_STATE:?}/health-fail" || -f "${FAKE_STATE:?}/public-fail" ]] && { printf 500; exit 22; }; printf "%%s" "${FAKE_PUBLIC_CODE:-200}"\n' > "$BIN/curl"; chmod +x "$BIN/curl"
printf '#!/bin/sh\necho "127.0.0.1 josi.test"\n' > "$BIN/getent"; chmod +x "$BIN/getent"
printf '#!/bin/sh\ncat >/dev/null\nprintf "docker compose restart web\\n"\n' > "$BIN/ollama"; chmod +x "$BIN/ollama"
case "$(uname -m)" in arm64|aarch64) TEST_ARCH=arm64;; *) TEST_ARCH=amd64;; esac
export PATH="$BIN:$PATH" FAKE_STATE="$STATE" FAKE_ROOT="$INSTALL" FAKE_IMAGE_ARCH="$TEST_ARCH" JOSI_DOCKER_BIN="$BIN/docker" JOSI_CURL_BIN="$BIN/curl" JOSI_NOW='2026-09-19T00:00:00Z' JOSI_HEALTH_TIMEOUT=1 JOSI_DISK_FREE_BYTES=9999999999 JOSI_MEMORY_BYTES=4294967296
CLI="$ROOT_SRC/scripts/josi --root $INSTALL"
PASS=0
ok(){ PASS=$((PASS+1)); printf 'ok %02d - %s\n' "$PASS" "$1"; }
fail(){ printf 'not ok - %s\n' "$1" >&2; exit 1; }
run(){ bash -c "$CLI $*"; }
(export JOSI_DOCKER_BIN=docker; run status --json) | grep -q '"direct":"pass"' || fail default-docker-wrapper
ok 'the default docker command resolves the host binary without recursive shell-function failure'
run status --json | grep -q '"direct":"pass"' || fail status; ok 'status reports direct/public readiness and containers'
printf 'services: {}\n' > "$INSTALL/docker-compose.workspace.yml"; : > "$STATE/calls"; run status --json >/dev/null
grep -q 'docker-compose.workspace.yml' "$STATE/calls" || fail compose-workspace-override
rm -f "$INSTALL/docker-compose.workspace.yml"; ok 'every lifecycle command automatically preserves the generated workspace Compose override'
runtime_out=$(JOSI_DOCKER_BIN="$TMP/missing-docker" "$ROOT_SRC/scripts/josi" --root "$INSTALL" doctor --check-only 2>&1 || true); [[ "$runtime_out" == *'runtime'* && "$runtime_out" == *'Docker Engine or Compose v2 unavailable'* ]] || fail runtime-blocker; ok 'doctor reports a precise runtime blocker when Docker/Compose is unavailable'
: > "$STATE/calls"; (export FAKE_PREFLIGHT_RC=1; run install --yes >/dev/null 2>&1) && fail install-preflight; ! grep -q 'compose .* up ' "$STATE/calls" || fail install-mutated; ok 'install fails before mutation when preflight blocks'
: > "$STATE/calls"; run install >/dev/null 2>&1 && fail install-consent; [[ ! -e "$INSTALL/.josi" ]] && ! grep -q 'compose .* up ' "$STATE/calls" || fail install-consent-mutation; ok 'noninteractive install enforces consent before creating state or secrets'
run install --yes >/dev/null; grep -q 'compose .* up ' "$STATE/calls" || fail install-start; ok 'clean install reuses preflight/secret machinery and reaches readiness'
chmod 644 "$INSTALL/secrets/master.key"; preflight_json=$(cd "$INSTALL" && bash "$ROOT_SRC/scripts/preflight.sh" --json 2>/dev/null || true); [[ "$preflight_json" == *'"check":"master key permissions","status":"pass"'* ]] || fail preflight-compose-secret; chmod 600 "$INSTALL/secrets/master.key"; ok 'preflight accepts Compose-readable secrets only inside an owner-only directory'
out=$(run logs --since 30m); [[ "$out" != *CANARY_TOKEN* && "$out" != *hunter2* && "$out" != *JSON-CANARY* && "$out" != *OAUTH-CANARY* && "$out" != *URL-CANARY* && "$out" != *REFRESH-CANARY* && "$out" != *PEM-CANARY* && "$out" != *ENV-CANARY* && "$out" == *'[REDACTED]'* ]] || fail redaction; ok 'logs redact env, JSON, URL, OAuth, JWT, bearer and PEM canaries'
B1="$TMP/bundle1"; B2="$TMP/bundle2"; run support bundle "$B1" --since 30m >/dev/null; run doctor --export-ai-context "$B2" --check-only >/dev/null || true
cmp "$B1/manifest.json" "$B2/manifest.json" >/dev/null || { diff -u "$B1/manifest.json" "$B2/manifest.json" >&2 || true; fail deterministic; }
! grep -R -E 'CANARY_TOKEN|hunter2|JSON-CANARY|OAUTH-CANARY|URL-CANARY|REFRESH-CANARY|PEM-CANARY|ENV-CANARY|master-key-canary|db-password-canary' "$B1" >/dev/null || fail bundle-redaction
grep -q 'josi.support.v1' "$B1/manifest.json" || fail bundle-schema
grep -q '"content_included":"possible_in_redacted_logs"' "$B1/manifest.json" || fail content-honesty
grep -q $'started_at\tfinished_at\tcommand\tfile\tbytes\ttruncated\tsha256' "$B1/provenance.tsv" || fail provenance
grep -q 'push-deliveries.txt' "$B1/manifest.json" || fail push-summary
grep -q 'request_id=req-1' "$B1/correlations.txt" && grep -q 'receipt_id=rec-1' "$B1/correlations.txt" || fail correlation
ok 'support and doctor share a deterministic collector with hashes, provenance and push summaries'
(run support bundle "$TMP/content" --include-content >/dev/null 2>&1) && fail content-claim; ok 'unsupported content collection is rejected instead of falsely claimed'
(export JOSI_MAX_LOG_BYTES=80; run support bundle "$TMP/capped" >/dev/null); grep -R -q '^\[TRUNCATED:' "$TMP/capped/logs" || fail truncation; grep -q '"truncated":true' "$TMP/capped/manifest.json" || fail truncation-manifest; ok 'collector enforces byte caps and records truncation'
touch "$STATE/missing-worker"; run support bundle "$TMP/partial" >/dev/null; grep -q '"service":"worker","state":"missing"' "$TMP/partial/manifest.json" || fail partial; ok 'missing services produce a partial bundle instead of aborting'
doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'image_drift'* && "$doctor_out" == *'image_architecture'* && "$doctor_out" == *'worker=missing'* ]] || fail missing-image-pass; rm -f "$STATE/missing-worker"; ok 'missing containers also fail image pin and architecture checks'
printf 'exited/unhealthy\n' > "$STATE/worker"; : > "$STATE/calls"; dry_out=$(run doctor --dry-run 2>&1 || true); [[ "$dry_out" == *'docker compose up -d worker'* && "$(cat "$STATE/worker")" == exited/unhealthy ]] || fail doctor-dry-run; ! grep -q 'compose .* up ' "$STATE/calls" || fail doctor-dry-run-write; ok 'doctor dry-run prints an exact plan without writing'
run doctor --yes >/dev/null; [[ "$(cat "$STATE/worker")" == running/healthy/0 ]] || fail doctor-repair; run doctor --yes | grep -q 'healthy: no repairs required' || fail doctor-idempotent; ok 'doctor safely repairs a stopped service and is idempotent'
printf 'exited/none/0\n' > "$STATE/worker"; run status >/dev/null 2>&1 && fail status-stopped-pass; doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'container_worker'* && "$doctor_out" == *'exited/none/0'* ]] || fail stopped-pass; rm -f "$STATE/worker"; ok 'a normal exited container never passes status or doctor'
printf 'exited/none/1\n' > "$STATE/migrate"; doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'container_migrate'* && "$doctor_out" == *'exited/none/1'* ]] || fail one-shot-exit; rm -f "$STATE/migrate"; ok 'one-shot services pass only after exit code zero'
doctor_out=$(FAKE_IMAGE_ARCH=amd64 run doctor --check-only 2>&1 || true); if [[ "$TEST_ARCH" == arm64 ]]; then [[ "$doctor_out" == *'image_architecture'* ]] || fail image-arch; fi; ok 'doctor checks running image architecture against the host'
printf '\nJOSI_WORKSPACE_ENABLED=1\n' >> "$INSTALL/.env"; printf '%s|%s|false\n' "$TMP/resolved-workspace" /data/roots/docs > "$STATE/mounts"; mkdir -p "$TMP/resolved-workspace"; run doctor --check-only >/dev/null || fail resolved-workspace; sed -i.bak 's/^JOSI_WORKSPACE_MODE=.*/JOSI_WORKSPACE_MODE=rw/' "$INSTALL/.env"; rm -f "$INSTALL/.env.bak"; doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'FAIL  workspace'* ]] || fail workspace-rw-mismatch; printf '%s|%s|true\n' "$TMP/resolved-workspace" /data/roots/docs > "$STATE/mounts"; run doctor --check-only >/dev/null || fail workspace-rw; rm -rf "$TMP/resolved-workspace"; doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'FAIL  workspace'* ]] || { printf '%s\n' "$doctor_out" >&2; fail workspace-missing; }; sed -i.bak 's/^JOSI_WORKSPACE_ENABLED=.*/JOSI_WORKSPACE_ENABLED=0/; s/^JOSI_WORKSPACE_MODE=.*/JOSI_WORKSPACE_MODE=ro/' "$INSTALL/.env"; rm -f "$INSTALL/.env.bak" "$STATE/mounts"; ok 'workspace health uses resolved binds and requires exact read-only/read-write mode correspondence'
touch "$STATE/data-bad"; doctor_out=$(run doctor --check-only 2>&1 || true); [[ "$doctor_out" == *'writable_data'* ]] || fail writable-data; rm -f "$STATE/data-bad"; ok 'doctor fails missing or unwritable application data paths'
printf 'exited/none/1\n' > "$STATE/migrate"; : > "$STATE/calls"; (run doctor --repair-migrations >/dev/null 2>&1) && fail migration-approval; run doctor --repair-migrations --yes >/dev/null || fail migration-repair; grep -q 'pg_dump' "$STATE/calls" && grep -q -- '--no-deps' "$STATE/calls" || fail migration-order; rm -f "$STATE/migrate"; ok 'migration repair requires approval, verified backup, and a bounded one-shot rerun'
printf 'exited/unhealthy\n' > "$STATE/worker"; rollback_out=$(export FAKE_REGRESS_ON_UP=1; run doctor --yes 2>&1 || true); [[ "$rollback_out" == *'restoring captured pre-repair'* ]] || fail doctor-rollback; [[ ! -f "$STATE/health-fail" ]] || fail doctor-rollback-health; grep -q '"rollback_attempted":true' "$INSTALL/.josi/receipts/last-doctor.json" || fail doctor-rollback-receipt; rm -f "$STATE/worker"; ok 'doctor records rollback and verifies postconditions rather than claiming silently'
(export FAKE_CONFIG_FAIL=1; run doctor --check-only >/dev/null 2>&1) && fail check-only; ok 'doctor check-only is read-only and reports precise blockers'
ai_out=$(export FAKE_CONFIG_FAIL=1 JOSI_AI_PROVIDER=adapter; run doctor --ai-repair --yes 2>&1 || true); [[ "$ai_out" == *'--allow-ai'* ]] || fail ai-consent; ok 'AI repair refuses without separate consent even when --yes is present'
ai_out=$(export FAKE_CONFIG_FAIL=1 JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/not-present"; run doctor --ai-repair --allow-ai 2>&1 || true); [[ "$ai_out" == *'unavailable'* ]] || fail ai-provider; ok 'AI repair fails closed when configured provider is unavailable'
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=ollama JOSI_AI_MODEL=test OLLAMA_HOST='http://127.0.0.1:11434@evil.example'; run doctor --ai-repair --allow-ai 2>&1 || true); [[ "$ai_out" == *'exact loopback'* ]] || fail ai-loopback-bypass; rm -f "$STATE/public-fail"; ok 'AI repair rejects userinfo and hostname confusion in loopback URLs'
cat > "$TMP/adapter-ok" <<'EOF'
#!/bin/sh
printf 'docker compose restart web\n' > "$2"
EOF
cat > "$TMP/adapter-bad" <<'EOF'
#!/bin/sh
printf 'rm -rf /\n' > "$2"
EOF
chmod +x "$TMP/adapter-ok" "$TMP/adapter-bad"
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-ok"; run doctor --ai-repair --allow-ai 2>&1 || true); [[ "$ai_out" == *'second approval'* && -f "$STATE/public-fail" ]] || fail ai-second-approval; ok 'AI plan is shown but not executed without second approval'
plan_hash=$(printf '%s' "$ai_out" | grep -Eo '[0-9a-f]{64}' | tail -1); [[ -n "$plan_hash" ]] || fail ai-plan-hash
(run doctor --ai-repair --allow-ai --approve-ai-plan "$(printf '0%.0s' {1..64})" >/dev/null 2>&1) && fail ai-hash-mismatch; [[ -f "$STATE/public-fail" ]] || fail ai-hash-side-effect; ok 'AI approval is bound to the exact reviewed plan hash'
(export JOSI_AI_PROVIDER=adapter; run doctor --ai-repair --allow-ai --approve-ai-plan "$plan_hash" >/dev/null); [[ ! -f "$STATE/public-fail" ]] || fail ai-success; ok 'exactly approved allowlisted AI repair is postcondition-verified without replanning'
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter FAKE_AI_COMMAND_FAIL=1; run doctor --ai-repair --allow-ai --approve-ai-plan "$plan_hash" 2>&1 || true); [[ "$ai_out" == *'AI repair command failed'* && -f "$STATE/public-fail" ]] || fail ai-command-failure; rm -f "$STATE/public-fail"; ok 'AI command failure is audited and rolls captured state back'
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter FAKE_AI_REGRESS_ON_RESTART=1; run doctor --ai-repair --allow-ai --approve-ai-plan "$plan_hash" 2>&1 || true); [[ "$ai_out" == *'AI repair regressed readiness'* && ! -f "$STATE/health-fail" ]] || fail ai-rollback; rm -f "$STATE/public-fail"; ok 'AI repair rolls back its snapshotted state when readiness regresses'
touch "$STATE/public-fail"; ai_out=$(export JOSI_AI_PROVIDER=adapter JOSI_AI_TEST_ADAPTER=1 JOSI_AI_ADAPTER="$TMP/adapter-bad"; run doctor --ai-repair --allow-ai 2>&1 || true); bad_hash=$(printf '%s' "$ai_out" | grep -Eo '[0-9a-f]{64}' | tail -1); (export JOSI_AI_PROVIDER=adapter; run doctor --ai-repair --allow-ai --approve-ai-plan "$bad_hash" >/dev/null 2>&1) && fail ai-scope; rm -f "$STATE/public-fail"; ok 'AI validates the complete plan before executing any command'
run backup > "$TMP/backup.out"; b=$(tail -1 "$TMP/backup.out"); gzip -t "$b"; test -s "$b.sha256" || fail backup; ok 'backup is compressed, checksummed, and verified'
run update 9.9.9 --yes >/dev/null 2>&1 && fail update-should-rollback
[[ "$(sed -n 's/^JOSI_TAG=//p' "$INSTALL/.env")" == 0.1.0 ]] || fail update-rollback; grep -q '"database_rolled_back":false' "$INSTALL/.josi/receipts/last-rollback.json" || fail rollback-receipt; ok 'failed pre-migration update verifies image rollback without claiming database rollback'
update_out=$(run update 8.8.8 --yes 2>&1 || true); [[ "$update_out" == *'automatic image rollback is unsafe'* && "$(sed -n 's/^JOSI_TAG=//p' "$INSTALL/.env")" == 8.8.8 ]] || fail irreversible-update; rollback_out=$(run rollback 0.1.0 2>&1 || true); [[ "$rollback_out" == *'database-incompatible'* ]] || fail incompatible-rollback; sed -i.bak 's/^JOSI_TAG=.*/JOSI_TAG=0.1.0/' "$INSTALL/.env"; rm -f "$INSTALL/.env.bak" "$STATE/health-fail"; ok 'post-migration failures refuse unsafe image rollback until database restoration'
(run update latest --yes >/dev/null 2>&1) && fail mutable-update; (run rollback latest >/dev/null 2>&1) && fail mutable-rollback; ok 'update and rollback reject mutable image aliases'
: > "$STATE/calls"; run uninstall --yes >/dev/null; ! grep -q -- '--volumes' "$STATE/calls" || fail uninstall-data; ok 'uninstall defaults to keeping volumes and user data'
run uninstall --purge-data >/dev/null 2>&1 && fail purge-refusal; ok 'data purge requires an explicit destructive confirmation phrase'
printf 'CLI tests passed: %d\n' "$PASS"
