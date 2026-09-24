#!/usr/bin/env bash
# Josi CE browser-first AIO installer controller.
#
# The current directory MUST be bind-mounted at the same absolute path inside
# this container. Compose sends absolute bind paths to the host daemon; using a
# different container-only path would make ./secrets invisible to that daemon.
#
# Example (from an empty directory):
#   # Linux
#   docker run --rm \
#     -p 8080:8080 \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$PWD:$PWD" -w "$PWD" \
#     romanvaxman/josi-ce-installer:latest
#
# Docker Desktop for Mac exposes its socket at ~/.docker/run/docker.sock. Mount
# that source to the same /var/run/docker.sock destination shown above.
set -euo pipefail

readonly ASSETS=/opt/josi-ce-release
readonly VERSION="${JOSI_VERSION:-0.1.0}"
readonly INSTALL_UID="$(stat -c '%u' "$PWD")"
readonly INSTALL_GID="$(stat -c '%g' "$PWD")"
readonly APP_GID=1000
readonly DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
readonly INSTALLER_IMAGE="${JOSI_INSTALLER_IMAGE:-docker.io/romanvaxman/josi-ce-installer:${VERSION}}"
readonly INSTALLER_PORT="${JOSI_INSTALLER_PORT:-8080}"

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail 'the installer must run as its image default user'
[[ "$PWD" == /* && "$PWD" != / ]] || fail 'run from an absolute, dedicated installation directory'
[[ -S /var/run/docker.sock ]] || fail 'mount the Docker socket at /var/run/docker.sock'
docker info >/dev/null 2>&1 || fail 'the Docker engine is not reachable through the mounted socket'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required'

# Refuse a subtly broken mount. The same absolute path must exist on the host,
# which the documented -v "$PWD:$PWD" invocation guarantees. A disposable
# probe asks the host daemon to bind that path and proves it can see this exact
# directory before any installation data is written.
probe=".josi-aio-path-probe-$$"
printf 'josi-aio-path-ok\n' > "$probe"
if ! docker run --rm -v "$PWD:/josi-install:ro" alpine:3.22 \
  test -f "/josi-install/$probe" >/dev/null 2>&1; then
  rm -f "$probe"
  fail 'the working directory is not mounted at the same absolute host path; use -v "$PWD:$PWD" -w "$PWD"'
fi
rm -f "$probe"

say "Josi CE ${VERSION} — browser installer"
say "Docker authority remains isolated inside this installer controller."

EXISTING_INSTALL=0
[[ -f .env || -d secrets ]] && EXISTING_INSTALL=1

install_asset() {
  local source="$1" target="$2" mode="$3" policy="${4:-replace}"
  if [[ -e "$target" && "$policy" == preserve ]]; then
    say "leaving operator-managed $target unchanged"
    return 0
  fi
  if [[ -e "$target" ]] && ! cmp -s "$source" "$target"; then
    cp -p "$target" "${target}.pre-${VERSION}"
    chown "$INSTALL_UID:$INSTALL_GID" "${target}.pre-${VERSION}"
    say "backed up previous $target to ${target}.pre-${VERSION}"
  fi
  cp "$source" "$target"
  chmod "$mode" "$target"
  chown "$INSTALL_UID:$INSTALL_GID" "$target"
  say "installed $target"
}

install_asset "$ASSETS/docker-compose.yml" docker-compose.yml 0644
install_asset "$ASSETS/docker-compose.noproxy.yml" docker-compose.noproxy.yml 0644
install_asset "$ASSETS/Caddyfile" Caddyfile 0644 preserve
install_asset "$ASSETS/.env.example" .env.example 0644
install_asset "$ASSETS/install.sh" install.sh 0755
install_asset "$ASSETS/preflight.sh" preflight.sh 0755
install_asset "$ASSETS/josi" josi 0755
install_asset "$ASSETS/reset-password.sh" reset-password.sh 0755

if [[ ! -e .env ]]; then
  cp .env.example .env
  # The source checkout defaults to `local`; a published installation must be
  # pinned to the release that shipped this installer.
  sed -i.bak "s/^JOSI_TAG=.*/JOSI_TAG=${VERSION}/" .env
  rm -f .env.bak
  chmod 0600 .env
  chown "$INSTALL_UID:$INSTALL_GID" .env
  say "created .env pinned to JOSI_TAG=${VERSION}"
else
  cp -p .env ".env.pre-${VERSION}"
  if grep -q '^JOSI_TAG=' .env; then
    sed -i.bak "s/^JOSI_TAG=.*/JOSI_TAG=${VERSION}/" .env
  else
    printf '\nJOSI_TAG=%s\n' "$VERSION" >> .env
  fi
  rm -f .env.bak
  chmod 0600 .env
  chown "$INSTALL_UID:$INSTALL_GID" .env ".env.pre-${VERSION}"
  say "updated existing .env to JOSI_TAG=${VERSION} (backup: .env.pre-${VERSION})"
fi

JOSI_COMPOSE_SECRETS=1 bash ./install.sh
chown -R "$INSTALL_UID:$INSTALL_GID" secrets

if [[ "${JOSI_PREPARE_ONLY:-0}" == "1" ]]; then
  say ''
  say 'Josi CE release files and secrets are ready.'
  say 'JOSI_PREPARE_ONLY=1 was set, so no services were started.'
  say 'Import docker-compose.yml into your platform UI, using this directory as the stack path.'
  exit 0
fi

install -d -m 0700 -o "$INSTALL_UID" -g "$INSTALL_GID" installer-state
if [[ ! -f installer-state/bootstrap-token ]]; then
  umask 077
  openssl rand -hex 16 > installer-state/bootstrap-token
  chown "$INSTALL_UID:$INSTALL_GID" installer-state/bootstrap-token
fi
if [[ ! -f installer-state/tls.key || ! -f installer-state/tls.crt ]] \
   || ! openssl x509 -checkend 86400 -noout -in installer-state/tls.crt >/dev/null 2>&1; then
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -subj '/CN=Josi Local Installer' \
    -keyout installer-state/tls.key -out installer-state/tls.crt >/dev/null 2>&1
  chown "$INSTALL_UID:$INSTALL_GID" installer-state/tls.key installer-state/tls.crt
fi

host_ip="${JOSI_HOST_IP:-$({ docker run --rm --network host alpine:3.22 sh -c 'ip -4 route get 1.1.1.1 2>/dev/null' || true; } | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')}"
[[ -n "$host_ip" ]] || host_ip='<server-lan-ip>'
say ''
say "Open Josi Setup: https://${host_ip}:${INSTALLER_PORT}"
say "Setup code: $(tr -d '\r\n' < installer-state/bootstrap-token)"
say 'All remaining installation questions are answered in the browser.'
say 'Your browser will warn about the temporary self-signed local certificate.'

export JOSI_INSTALL_ROOT="$PWD" JOSI_INSTALL_UID="$INSTALL_UID" JOSI_INSTALL_GID="$INSTALL_GID"
export JOSI_APP_GID="$APP_GID" JOSI_DOCKER_GID="$DOCKER_GID" JOSI_INSTALLER_IMAGE="$INSTALLER_IMAGE"
export JOSI_EXISTING_INSTALL="$EXISTING_INSTALL"
exec python3 /opt/josi-installer/controller.py
