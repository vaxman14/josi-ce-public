#!/usr/bin/env bash
# Josi CE first-run installer.
#
# Generates the two secrets an installation needs and nothing else. It does not
# start anything, so an operator can read what it produced before running
# `docker compose up`.
#
#   scripts/install.sh              generate secrets if absent
#   scripts/install.sh --check      verify without writing
#
# The master key is the one thing here that cannot be regenerated. Everything
# encrypted in the database is sealed with it, so losing it means losing every
# stored credential — the provider keys, the OAuth secrets, the SMTP passwords.
# A database backup on its own will not bring them back, and that is deliberate:
# it is what makes a stolen dump useless.
set -euo pipefail

# Where the installation lives.
#
# Two shapes are supported and they must not be confused, because guessing wrong
# writes an installation's secrets into the wrong directory.
#
#   Repository checkout — this script is `scripts/install.sh` and the
#   installation is the repository root one level up.
#
#   Downloaded on its own — the supported way to install without cloning
#   anything. The script sits beside the compose file in the directory the
#   operator created for Josi, and THAT directory is the installation. A blind
#   `cd ..` here would put the secrets in its parent.
#
# The repository case is detected by both of its properties, not one: the script
# is in a directory called `scripts`, and a compose file is its sibling's child.
script_dir="$(cd "$(dirname "$0")" && pwd)"
if [[ "$(basename "$script_dir")" == "scripts" && -f "${script_dir}/../docker-compose.yml" ]]; then
  cd "${script_dir}/.."
else
  cd "$script_dir"
fi

SECRETS_DIR="secrets"
MASTER_KEY="${SECRETS_DIR}/master.key"
DB_PASSWORD="${SECRETS_DIR}/db_password"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

say()  { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Anything this script creates is owner-only from the moment it exists. Setting
# the umask up front means the file is never briefly world-readable between
# creation and chmod.
umask 077

have_random() {
  command -v openssl >/dev/null 2>&1 && return 0
  [[ -r /dev/urandom ]] && return 0
  return 1
}

# 32 bytes from a CSPRNG. openssl if present, /dev/urandom otherwise — never
# $RANDOM, date, or a shell PID, all of which are guessable.
generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

generate_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '/+=' | head -c 32
  else
    head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 32
  fi
}

# A file's permission mode as plain octal digits, or a non-zero return if this
# filesystem or this `stat` cannot report one portably.
#
# GNU coreutils is tried FIRST and the order is load-bearing. On GNU, `stat -f`
# means "display file system status" and SUCCEEDS, so a BSD-first chain never
# reaches its GNU fallback: it returns filesystem diagnostics — `?p`, because
# `%Lp` is not a filesystem format — and the caller then prints that to an
# operator as though it were a permission mode. This function previously did
# exactly that, which is why the result is now also validated to be octal
# before it is returned. Junk is reported as "unknown", never as a mode.
file_mode() {
  local f="$1" m=''
  m=$(stat -c '%a' "$f" 2>/dev/null) || m=''
  if [[ -z "$m" ]]; then
    m=$(stat -f '%Lp' "$f" 2>/dev/null) || m=''
  fi
  case "$m" in
    '' | *[!0-7]*) return 1 ;;
  esac
  printf '%s' "$m"
}

verify_key_file() {
  local file="$1" label="$2" min_bytes="$3"
  [[ -f "$file" ]] || { say "  missing: $file"; return 1; }
  local bytes
  bytes=$(wc -c < "$file" | tr -d ' ')
  [[ "$bytes" -ge "$min_bytes" ]] || { say "  too short: $file ($bytes bytes)"; return 1; }
  # Mode check is advisory on filesystems that do not carry POSIX permissions.
  local mode
  if mode=$(file_mode "$file"); then
    if [[ "$mode" != "600" && "$mode" != "400" ]]; then
      say "  warning: $label is mode $mode; expected 600"
    fi
  else
    say "  note: this filesystem does not report POSIX permissions for $label"
  fi
  say "  ok: $label"
  return 0
}

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "checking Josi CE secrets"
  rc=0
  verify_key_file "$MASTER_KEY" "master key" 40 || rc=1
  verify_key_file "$DB_PASSWORD" "database password" 16 || rc=1
  [[ $rc -eq 0 ]] && say "secrets present" || say "run scripts/install.sh to generate the missing ones"
  exit $rc
fi

have_random || fail "no source of secure randomness found (needs openssl or /dev/urandom)"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Compose file-backed secrets are bind-mounted into containers that run as a
# non-root user. The files may be world-readable because their parent directory
# remains owner-only (0700), so other host users still cannot traverse it.
SECRET_MODE=600
[[ "${JOSI_COMPOSE_SECRETS:-0}" == "1" ]] && SECRET_MODE=644

say "Josi CE — generating installation secrets"
say ""

# ------------------------------------------------------------------ master key
if [[ -f "$MASTER_KEY" ]]; then
  # Never silently replace it. A new key does not re-encrypt anything; it makes
  # every stored credential permanently unreadable.
  say "master key already exists at ${MASTER_KEY} — leaving it alone"
  say "  (regenerating it would orphan every credential already encrypted)"
else
  generate_key > "$MASTER_KEY"
  chmod "$SECRET_MODE" "$MASTER_KEY"
  say "master key written to ${MASTER_KEY} (mode ${SECRET_MODE})"
fi

# ----------------------------------------------------------- database password
if [[ -f "$DB_PASSWORD" ]]; then
  say "database password already exists at ${DB_PASSWORD} — leaving it alone"
else
  generate_password > "$DB_PASSWORD"
  chmod "$SECRET_MODE" "$DB_PASSWORD"
  say "database password written to ${DB_PASSWORD} (mode ${SECRET_MODE})"
fi

if [[ "$SECRET_MODE" == "644" ]]; then
  chmod 644 "$MASTER_KEY" "$DB_PASSWORD"
fi

# The values are never printed. An operator who needs the master key for a
# backup copies the file; echoing it here would put it in their shell history
# and in any terminal recording.
say ""
say "Neither secret was printed. Read the files directly if you need them."
say ""
say "BACK UP ${MASTER_KEY} SOMEWHERE ELSE, NOW."
say "  A database backup alone cannot restore your encrypted credentials."
say "  Without this file they are gone permanently."
say ""
say "Next:"
say "  1. Set JOSI_DOMAIN in .env (or export it) for automatic HTTPS."
say "  2. docker compose up -d"
say "  3. Open the setup wizard and create the super admin."
