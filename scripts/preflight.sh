#!/usr/bin/env bash
# Josi CE installation preflight.
#
# Checks the things that make an installation fail *after* you have already
# pulled several hundred megabytes and started editing configuration, and says
# exactly how to repair each one. It changes nothing on the host: no package is
# installed, no file outside the current directory is read for its contents, no
# container is created, no image is pulled.
#
#   bash preflight.sh              check, print a report, exit non-zero on a blocker
#   bash preflight.sh --quiet      only print problems
#   bash preflight.sh --json       machine-readable results on stdout
#
# This file is deliberately self-contained. It is published as a single
# downloadable artifact so an operator can read the whole thing before running
# it, which is the reason Josi does not ask anyone to pipe a URL into a shell.
#
# Exit codes:
#   0  no blockers (warnings may still have been printed)
#   1  at least one blocker — installing now will fail
#   2  the script could not run at all (unsupported shell, bad arguments)

set -uo pipefail

VERSION="0.1.0"

# What the installation actually needs. Every threshold here is a number an
# operator can argue with, which is why each one is named rather than inlined.
MIN_DISK_MB=5120        # 5 GiB: images (~400 MB), database, backups, room to update
MIN_MEM_MB=1800         # ~2 GB: the default stack without OCR or ClamAV
REC_MEM_MB=3800         # ~4 GB: comfortable, and what the optional services need
HTTP_PORT="${JOSI_HTTP_PORT:-80}"
HTTPS_PORT="${JOSI_HTTPS_PORT:-443}"

QUIET=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --json)  JSON=1; QUIET=1 ;;
    --help|-h)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) printf 'preflight: unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

BLOCKERS=0
WARNINGS=0
JSON_ROWS=()

# ---------------------------------------------------------------- reporting

c_reset=''; c_red=''; c_yellow=''; c_green=''; c_dim=''
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  c_reset=$'\033[0m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'
  c_green=$'\033[32m'; c_dim=$'\033[2m'
fi

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | tr '\n' ' '
}

record() {
  # record <status> <check> <detail> [remedy]
  local status="$1" check="$2" detail="$3" remedy="${4:-}"
  JSON_ROWS+=("{\"check\":\"$(json_escape "$check")\",\"status\":\"$status\",\"detail\":\"$(json_escape "$detail")\",\"remedy\":\"$(json_escape "$remedy")\"}")
  case "$status" in
    pass) [ $QUIET -eq 1 ] || printf '  %sPASS%s  %s %s%s%s\n' "$c_green" "$c_reset" "$check" "$c_dim" "$detail" "$c_reset" ;;
    warn)
      WARNINGS=$((WARNINGS + 1))
      [ $JSON -eq 1 ] || printf '  %sWARN%s  %s — %s\n' "$c_yellow" "$c_reset" "$check" "$detail"
      [ -n "$remedy" ] && [ $JSON -eq 0 ] && printf '        %s\n' "$remedy"
      ;;
    fail)
      BLOCKERS=$((BLOCKERS + 1))
      [ $JSON -eq 1 ] || printf '  %sFAIL%s  %s — %s\n' "$c_red" "$c_reset" "$check" "$detail"
      [ -n "$remedy" ] && [ $JSON -eq 0 ] && printf '%s\n' "$remedy" | sed 's/^/        /'
      ;;
    skip) [ $QUIET -eq 1 ] || printf '  %sSKIP%s  %s %s%s%s\n' "$c_dim" "$c_reset" "$check" "$c_dim" "$detail" "$c_reset" ;;
  esac
}

section() { [ $QUIET -eq 1 ] || printf '\n%s\n' "$1"; }

# ------------------------------------------------------------- portable bits

# A file's permission mode as plain octal digits, or empty if it cannot be read
# portably.
#
# GNU coreutils is tried FIRST and the order is load-bearing. On GNU, `stat -f`
# means "display file system status" and SUCCEEDS, so a BSD-first chain never
# reaches its fallback and returns filesystem diagnostics — `?p` for an
# unsupported format string — which then gets printed to an operator as though
# it were a permission mode. That is the exact defect this function exists to
# prevent, so the result is also validated to be octal before it is returned.
file_mode() {
  local f="$1" m=''
  m=$(stat -c '%a' "$f" 2>/dev/null) || m=''
  if [ -z "$m" ]; then
    m=$(stat -f '%Lp' "$f" 2>/dev/null) || m=''
  fi
  case "$m" in
    '' | *[!0-7]*) return 1 ;;
  esac
  printf '%s' "$m"
}

# Free space in whole MiB on the filesystem holding <path>.
#
# `df -Pk` and not `df -h`. Human-readable output is a formatted string: a
# healthy 1.8 TB disk prints "1.8T", and comparing that against a threshold
# numerically reads it as 1.8 and warns that a nearly-empty multi-terabyte
# volume is almost full. -P also guarantees the entry is on one line, which long
# device names otherwise wrap.
disk_free_mb() {
  local path="${1:-.}" avail=''
  avail=$(df -Pk "$path" 2>/dev/null | awk 'NR==2 {print $4}') || avail=''
  case "$avail" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' $((avail / 1024))
}

total_mem_mb() {
  local kb=''
  if [ -r /proc/meminfo ]; then
    kb=$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo)
  elif command -v sysctl >/dev/null 2>&1; then
    local bytes
    bytes=$(sysctl -n hw.memsize 2>/dev/null) || bytes=''
    case "$bytes" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s' $((bytes / 1024 / 1024))
    return 0
  fi
  case "$kb" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' $((kb / 1024))
}

port_in_use() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$p" -sTCP:LISTEN -n -P >/dev/null 2>&1 && return 0
  else
    return 2   # cannot tell
  fi
  return 1
}

# ------------------------------------------------------------------- header

if [ $JSON -eq 0 ] && [ $QUIET -eq 0 ]; then
  printf 'Josi CE installation preflight %s\n' "$VERSION"
  printf 'Nothing on this host is changed by this script.\n'
fi

# ------------------------------------------------------ architecture and OS

section 'Host'

ARCH="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH" in
  x86_64 | amd64)
    record pass 'architecture' "$ARCH (amd64)"
    ;;
  aarch64 | arm64)
    record pass 'architecture' "$ARCH (arm64)"
    ;;
  armv7l | armv6l | i386 | i686)
    record fail 'architecture' "$ARCH is 32-bit" \
      "Josi CE publishes linux/amd64 and linux/arm64 images only.
On a Raspberry Pi, install a 64-bit operating system — Raspberry Pi OS (64-bit)
or Ubuntu Server arm64 — and run this again. A 32-bit userland cannot run these
images even on 64-bit hardware."
    ;;
  *)
    record warn 'architecture' "$ARCH is not a published platform" \
      "Josi CE publishes linux/amd64 and linux/arm64. Continuing is untested."
    ;;
esac

KERNEL="$(uname -s 2>/dev/null || echo unknown)"
case "$KERNEL" in
  Linux)
    OS_NAME=''; OS_VER=''
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      OS_NAME=$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")
      OS_VER=$(. /etc/os-release 2>/dev/null && printf '%s' "${VERSION_ID:-}")
    fi
    case "$OS_NAME" in
      ubuntu | debian | fedora | rhel | centos | rocky | almalinux | raspbian)
        record pass 'operating system' "${OS_NAME} ${OS_VER}"
        ;;
      '')
        record warn 'operating system' 'Linux, distribution not identified' \
          'Docker Engine supports a specific set of distributions. Confirm yours is one of them.'
        ;;
      *)
        record warn 'operating system' "${OS_NAME} ${OS_VER} is not a tested distribution" \
          'Josi CE is tested on Debian and Ubuntu. Other Docker-supported distributions are expected to work but are unverified.'
        ;;
    esac
    ;;
  Darwin)
    record warn 'operating system' 'macOS is a development platform, not a supported server' \
      'Docker Desktop will run the stack for evaluation. Do not run a production installation here.'
    ;;
  *)
    record warn 'operating system' "$KERNEL is untested" \
      'Josi CE is a Linux server product.'
    ;;
esac

# --------------------------------------------------------------- Docker

section 'Docker'

DOCKER_OK=0
if ! command -v docker >/dev/null 2>&1; then
  record fail 'Docker Engine' 'the `docker` command was not found' \
    "Install Docker Engine using your distribution's documented repository:
  https://docs.docker.com/engine/install/

Do NOT install the Ubuntu Snap package (\`snap install docker\`). It is a
different build with its own socket ownership and no \`docker\` group, and it is
the cause of the permission failure this script checks for below."
else
  DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || DOCKER_VER=''
  if [ -z "$DOCKER_VER" ]; then
    DOCKER_VER=$(docker --version 2>/dev/null | sed -n 's/.*version \([0-9.]*\).*/\1/p') || DOCKER_VER=''
  fi
  record pass 'Docker Engine' "${DOCKER_VER:-present}"
  DOCKER_OK=1
fi

# ---- the Snap failure, named specifically.
#
# On Ubuntu, `snap install docker` produces a daemon whose socket is root:root
# and an installation with no `docker` group at all. The universally-recommended
# repair — `sudo usermod -aG docker $USER` — then fails or silently adds the user
# to a group that governs nothing, and every later command still says "permission
# denied while trying to connect to the Docker daemon socket". Diagnosing that
# after a failed pull is much worse than being told here.
SOCK=/var/run/docker.sock
SNAP_DOCKER=0
if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
  SNAP_DOCKER=1
fi
[ -e /snap/bin/docker ] && SNAP_DOCKER=1
if [ "$DOCKER_OK" = 1 ]; then
  case "$(command -v docker)" in /snap/*) SNAP_DOCKER=1 ;; esac
fi

HAS_DOCKER_GROUP=0
if command -v getent >/dev/null 2>&1; then
  getent group docker >/dev/null 2>&1 && HAS_DOCKER_GROUP=1
elif [ -r /etc/group ]; then
  grep -q '^docker:' /etc/group && HAS_DOCKER_GROUP=1
fi

SOCK_OWNER=''
if [ -S "$SOCK" ]; then
  SOCK_OWNER=$(stat -c '%U:%G' "$SOCK" 2>/dev/null) || SOCK_OWNER=$(stat -f '%Su:%Sg' "$SOCK" 2>/dev/null) || SOCK_OWNER=''
fi

if [ "$SNAP_DOCKER" = 1 ]; then
  record fail 'Docker packaging' 'Docker is installed from the Ubuntu Snap package' \
    "The Snap build is not supported by Josi CE. Its socket is owned root:root, it
creates no \`docker\` group, and it confines the daemon so bind mounts outside
\$HOME do not work — which breaks shared folders and backup volumes.

The supported repair, in this order:

  sudo snap stop docker
  sudo snap remove docker
  # then install Docker Engine from Docker's own apt repository:
  #   https://docs.docker.com/engine/install/ubuntu/
  sudo groupadd -f docker
  sudo usermod -aG docker \$USER
  newgrp docker            # or log out and back in

Verify with \`docker run --rm hello-world\` before installing Josi."
elif [ -S "$SOCK" ] && [ "$SOCK_OWNER" = "root:root" ] && [ "$HAS_DOCKER_GROUP" = 0 ]; then
  # The same end state, reached some other way. The advice differs slightly
  # because there is no snap to remove.
  record fail 'Docker socket ownership' "$SOCK is root:root and this host has no \`docker\` group" \
    "Adding yourself to the \`docker\` group cannot work, because the group does not
exist and the socket is not owned by it. Either create the group and let the
daemon adopt it:

  sudo groupadd -f docker
  sudo chown root:docker $SOCK
  sudo usermod -aG docker \$USER
  newgrp docker

or run the installation with \`sudo docker ...\` and accept that every Josi
command needs it. Do not \`chmod 666\` the socket: that grants every local
account root-equivalent control of the host."
elif [ "$DOCKER_OK" = 1 ]; then
  record pass 'Docker packaging' 'not the Snap build'
fi

# ---- daemon reachability, which is the check the two above exist to explain.
if [ "$DOCKER_OK" = 1 ]; then
  if docker info >/dev/null 2>&1; then
    record pass 'Docker daemon' 'reachable by this user'
  else
    DERR=$(docker info 2>&1 | head -3)
    if printf '%s' "$DERR" | grep -qi 'permission denied'; then
      record fail 'Docker daemon' 'running, but this user may not talk to it' \
        "You are not in the group that owns $SOCK.

  sudo groupadd -f docker
  sudo usermod -aG docker \$USER
  newgrp docker            # or log out and back in

If you have already done this and it still fails, your shell has not picked up
the new group — \`id -nG\` will not list \`docker\` until you start a new login
session."
    elif printf '%s' "$DERR" | grep -qiE 'cannot connect|is the docker daemon running'; then
      record fail 'Docker daemon' 'not running' \
        "  sudo systemctl enable --now docker
  systemctl status docker"
    else
      record fail 'Docker daemon' "not usable: $(printf '%s' "$DERR" | head -1)" \
        'Resolve the error above before installing.'
    fi
  fi
fi

# ---- Compose v2, invoked as `docker compose`.
if [ "$DOCKER_OK" = 1 ]; then
  CVER=$(docker compose version --short 2>/dev/null) || CVER=''
  if [ -n "$CVER" ]; then
    CMAJ=${CVER%%.*}
    CMAJ=${CMAJ#v}
    case "$CMAJ" in
      '' | *[!0-9]*) record warn 'Docker Compose' "version $CVER could not be parsed" 'Confirm `docker compose version` reports v2 or newer.' ;;
      *) if [ "$CMAJ" -ge 2 ]; then
           record pass 'Docker Compose' "v$CVER"
         else
           record fail 'Docker Compose' "v$CVER is too old" 'Josi CE requires Compose v2. Upgrade the docker-compose-plugin package.'
         fi
         ;;
    esac
  elif command -v docker-compose >/dev/null 2>&1; then
    record fail 'Docker Compose' 'only the legacy `docker-compose` v1 script is present' \
      "Josi CE requires Compose v2, invoked as \`docker compose\` (a space, not a hyphen).
Install the plugin:  sudo apt-get install docker-compose-plugin"
  else
    record fail 'Docker Compose' 'not installed' \
      'Install the Compose v2 plugin:  sudo apt-get install docker-compose-plugin'
  fi
fi

# --------------------------------------------------------------- resources

section 'Resources'

if FREE_MB=$(disk_free_mb .); then
  if [ "$FREE_MB" -lt "$MIN_DISK_MB" ]; then
    record fail 'disk space' "$((FREE_MB / 1024)) GiB free here; $((MIN_DISK_MB / 1024)) GiB needed" \
      "Free space on this filesystem, or install into a different one.
Docker's images and volumes usually live under /var/lib/docker — check that
filesystem too:  df -Pk /var/lib/docker"
  else
    record pass 'disk space' "$((FREE_MB / 1024)) GiB free"
  fi
else
  record warn 'disk space' 'could not be determined' 'Confirm manually with `df -Pk .`'
fi

if MEM_MB=$(total_mem_mb); then
  if [ "$MEM_MB" -lt "$MIN_MEM_MB" ]; then
    record fail 'memory' "${MEM_MB} MB total; ${MIN_MEM_MB} MB is the minimum" \
      'The default stack (database, API, worker, proxy) does not fit. Add memory or swap, and do not enable the OCR or ClamAV profiles.'
  elif [ "$MEM_MB" -lt "$REC_MEM_MB" ]; then
    record warn 'memory' "${MEM_MB} MB total" \
      'Enough for the default stack. The optional OCR and ClamAV profiles need more; leave them disabled.'
  else
    record pass 'memory' "${MEM_MB} MB total"
  fi
else
  record warn 'memory' 'could not be determined' 'Confirm manually.'
fi

# ------------------------------------------------------------------- ports

section 'Ports'

for spec in "$HTTP_PORT:HTTP" "$HTTPS_PORT:HTTPS"; do
  p=${spec%%:*}; label=${spec##*:}
  port_in_use "$p"; rc=$?
  case $rc in
    0) record fail "port $p ($label)" 'already in use' \
         "Something is already listening on $p. Identify it:
  sudo ss -ltnp | grep ':$p'

Then either stop it, or run Josi behind it — set JOSI_HTTP_PORT and
JOSI_HTTPS_PORT to free ports and put your existing proxy in front. If your
existing proxy already terminates HTTPS, use the bring-your-own-proxy mode
instead of the bundled Caddy." ;;
    1) record pass "port $p ($label)" 'free' ;;
    *) record warn "port $p ($label)" 'could not be checked' 'Install `ss`, `netstat` or `lsof`, or confirm manually.' ;;
  esac
done

# ------------------------------------------------------------- filesystem

section 'Filesystem'

if [ -w . ]; then
  record pass 'install directory' "$(pwd) is writable"
else
  record fail 'install directory' "$(pwd) is not writable by this user" \
    'Install into a directory you own. Josi generates its secrets here.'
fi

# If secrets already exist, their mode is a real security property and the
# reason `file_mode` refuses to guess.
if [ -f secrets/master.key ]; then
  if MODE=$(file_mode secrets/master.key); then
    DIR_MODE=$(file_mode secrets 2>/dev/null || true)
    if [ "$MODE" = "600" ] || [ "$MODE" = "400" ]; then
      record pass 'master key permissions' "mode $MODE"
    elif [ "$MODE" = "644" ] && [ "$DIR_MODE" = "700" ]; then
      # Compose bind-mounts this file for a non-root container user. The file
      # must be readable there, while the owner-only parent prevents every
      # other host account from traversing to it.
      record pass 'master key permissions' 'mode 644 inside owner-only mode 700 secrets directory'
    else
      record fail 'master key permissions' "file mode $MODE, directory mode ${DIR_MODE:-unknown}" \
        'Protect source installs with mode 600, or Compose file secrets with:
  chmod 700 secrets
  chmod 644 secrets/master.key secrets/db_password'
    fi
  else
    record warn 'master key permissions' 'this filesystem does not report POSIX permissions' \
      'Confirm the file is not readable by other accounts.'
  fi
else
  record skip 'master key permissions' '(not generated yet)'
fi

# A filesystem that carries no permissions at all cannot protect the key. This
# is the usual result of installing onto exFAT, NTFS or a network share.
FSTYPE=$(df -PT . 2>/dev/null | awk 'NR==2 {print $2}') || FSTYPE=''
case "$FSTYPE" in
  vfat | exfat | ntfs | fuseblk | msdos)
    record fail 'filesystem type' "$FSTYPE cannot store POSIX permissions" \
      'Install onto ext4, xfs or btrfs. The master key and the database cannot be protected on this filesystem, and PostgreSQL will not run on it.'
    ;;
  '') record skip 'filesystem type' '(not reported)' ;;
  *)  record pass 'filesystem type' "$FSTYPE" ;;
esac

# --------------------------------------------------------------- conflicts

section 'Conflicts'

CONFLICT=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  EXISTING=$(docker ps -a --filter 'label=com.docker.compose.project=josi-ce' --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ')
  if [ "${EXISTING:-0}" -gt 0 ]; then
    CONFLICT=1
    record warn 'existing installation' "$EXISTING container(s) already belong to the josi-ce project" \
      "This is an upgrade or a repeat install, not a clean one. To start clean and
DESTROY the existing database:
  docker compose down -v
Read the backup section of INSTALLATION.md first — \`-v\` deletes the volumes."
  else
    record pass 'existing installation' 'no josi-ce containers on this host'
  fi
fi
[ "$CONFLICT" = 0 ] || true

# Package-manager Docker alongside Docker's own repository build is a common
# half-broken state on Ubuntu.
if command -v dpkg >/dev/null 2>&1; then
  if dpkg -l docker.io 2>/dev/null | grep -q '^ii' && dpkg -l docker-ce 2>/dev/null | grep -q '^ii'; then
    record warn 'Docker packages' 'both docker.io and docker-ce are installed' \
      "Two Docker packages on one host fight over the socket and the service unit.
Remove the distribution package and keep Docker's own:
  sudo apt-get remove docker.io"
  fi
fi

# ------------------------------------------------------------------ summary

if [ $JSON -eq 1 ]; then
  printf '{"version":"%s","blockers":%d,"warnings":%d,"checks":[' "$VERSION" "$BLOCKERS" "$WARNINGS"
  first=1
  for row in "${JSON_ROWS[@]}"; do
    [ $first -eq 1 ] || printf ','
    printf '%s' "$row"
    first=0
  done
  printf ']}\n'
elif [ $BLOCKERS -gt 0 ]; then
  printf '\n%s%d blocker(s)%s and %d warning(s).\n' "$c_red" "$BLOCKERS" "$c_reset" "$WARNINGS"
  printf 'Installing now will fail. Fix the FAIL lines above and run this again.\n'
else
  printf '\n%sReady to install.%s %d warning(s).\n' "$c_green" "$c_reset" "$WARNINGS"
  printf 'Next:  docker compose up -d\n'
fi

[ $BLOCKERS -gt 0 ] && exit 1
exit 0
