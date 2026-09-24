#!/bin/sh
# Install a pinned Josi CLI release after verifying its Sigstore identity and
# SHA-256 digest. The installer deliberately has no "latest" mode.
set -eu

VERSION=
INSTALL_DIR=
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: install.sh --version VERSION [options]

Required:
  --version VERSION       Exact Josi CLI release, for example 0.1.65

Options:
  --install-dir DIR       Destination (default: /usr/local/bin as root,
                          otherwise $HOME/.local/bin)
  --yes                   Do not prompt for confirmation
  --non-interactive       Alias for --yes; fail rather than prompt
  --help                  Show this help

The installer supports Linux amd64 and arm64. It downloads a versioned archive,
a checksum manifest, and that manifest's detached Sigstore signature and
certificate. It installs nothing unless every verification succeeds.
EOF
}

fail() {
  printf 'josi installer: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail '--version needs a value'
      VERSION=$2
      shift 2
      ;;
    --install-dir)
      [ "$#" -ge 2 ] || fail '--install-dir needs a value'
      INSTALL_DIR=$2
      shift 2
      ;;
    --yes|--non-interactive)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ -n "$VERSION" ] || fail '--version is required; this installer never follows latest'
VERSION=${VERSION#v}
case "$VERSION" in
  ''|*[!0-9A-Za-z.-]*) fail 'invalid version' ;;
esac
printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z][0-9A-Za-z.-]*)?$' \
  || fail 'version must be an explicit release version such as 0.1.65'

[ "$(uname -s)" = Linux ] || fail 'only Linux is supported'
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    INSTALL_DIR=/usr/local/bin
  else
    INSTALL_DIR=${HOME:?HOME is required}/.local/bin
  fi
fi
case "$INSTALL_DIR" in
  /*) ;;
  *) fail '--install-dir must be an absolute path' ;;
esac

for command_name in curl tar grep awk wc mktemp install mv tr env; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  SHA256_TOOL=shasum
else
  fail 'sha256sum or shasum is required'
fi

sha256_file() {
  if [ "$SHA256_TOOL" = sha256sum ]; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [ "$ASSUME_YES" -ne 1 ]; then
  [ -r /dev/tty ] || fail 'no terminal is available; pass --yes for noninteractive installation'
  printf 'Install Josi CLI %s to %s/josi? [y/N] ' "$VERSION" "$INSTALL_DIR" >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  case "$answer" in y|Y|yes|YES) ;; *) fail 'cancelled' ;; esac
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/josi-install.XXXXXX")
target_tmp=
cleanup() {
  rm -rf "$work"
  [ -z "$target_tmp" ] || rm -f "$target_tmp"
}
trap cleanup EXIT HUP INT TERM

archive="josi-cli-${VERSION}-linux-${ARCH}.tar.gz"
checksums="josi-cli-${VERSION}-checksums.txt"
# Versioned payloads are published by the clean, public source repository.
base_url="https://github.com/vaxman14/josi-ce-public/releases/download/v${VERSION}"

fetch() {
  partial="$work/$1.partial"
  rm -f "$partial"
  curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 \
    --output "$partial" "$base_url/$1" || { rm -f "$partial"; fail "download failed: $1"; }
  [ -s "$partial" ] || { rm -f "$partial"; fail "downloaded file is empty: $1"; }
  mv "$partial" "$work/$1"
}

printf 'Downloading Josi CLI %s for linux/%s...\n' "$VERSION" "$ARCH"
fetch "$archive"
fetch "$checksums"
fetch "$checksums.sig"
fetch "$checksums.pem"

# Cosign is part of the verification boundary. Download one exact upstream
# version and authenticate it with a digest embedded in this reviewed script.
COSIGN_VERSION=2.4.1
case "$ARCH" in
  amd64) COSIGN_SHA256=8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b ;;
  arm64) COSIGN_SHA256=3b2e2e3854d0356c45fe6607047526ccd04742d20bd44afb5be91fa2a6e7cb4a ;;
esac
curl --fail --silent --show-error --location \
  --proto '=https' --tlsv1.2 \
  --output "$work/cosign" \
  "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${ARCH}"
[ "$(sha256_file "$work/cosign")" = "$COSIGN_SHA256" ] \
  || fail 'cosign verifier digest did not match; refusing to continue'
chmod 0700 "$work/cosign"

certificate_identity="https://github.com/vaxman14/josi-ce-public/.github/workflows/release.yml@refs/tags/v${VERSION}"
printf 'Verifying the signed checksum manifest...\n'
"$work/cosign" verify-blob \
  --certificate "$work/$checksums.pem" \
  --signature "$work/$checksums.sig" \
  --certificate-identity "$certificate_identity" \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "$work/$checksums" >/dev/null \
  || fail 'release signature verification failed; nothing was installed'

# POSIX awk does not require interval regular expressions; Debian bookworm's
# default mawk therefore treats `{64}` literally unless interval support was
# enabled at build time. Validate the field by length and character exclusion,
# require the exact archive filename, and emit a digest only for one match.
expected=$(awk -v name="$archive" '
  NF == 2 && $2 == name && length($1) == 64 && $1 !~ /[^0-9a-f]/ {
    matches++
    digest=$1
  }
  END { if (matches == 1) print digest }
' "$work/$checksums")
[ -n "$expected" ] \
  || fail 'signed manifest does not contain exactly one valid digest for this archive'
actual=$(sha256_file "$work/$archive")
[ "$actual" = "$expected" ] \
  || fail 'archive checksum did not match the signed manifest; nothing was installed'

mkdir -p "$work/extract"
entries=$(tar -tzf "$work/$archive") || fail 'archive cannot be read'
[ "$entries" = josi ] || fail 'archive layout is unsafe; expected only the josi executable'
tar -xOzf "$work/$archive" josi > "$work/extract/josi.partial" \
  || fail 'archive payload could not be read as a regular file'
[ -s "$work/extract/josi.partial" ] || fail 'archive payload is empty or not a regular file'
mv "$work/extract/josi.partial" "$work/extract/josi"
chmod 0755 "$work/extract/josi"
[ "$(env -u JOSI_CLI_VERSION "$work/extract/josi" version 2>/dev/null)" = "$VERSION" ] \
  || fail 'signed archive contains a CLI with a different embedded version'

mkdir -p "$INSTALL_DIR"
[ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ] \
  || fail "install directory is not writable: $INSTALL_DIR"
target_tmp=$(mktemp "$INSTALL_DIR/.josi.install.XXXXXX")
install -m 0755 "$work/extract/josi" "$target_tmp"
[ "$(sha256_file "$target_tmp")" = "$(sha256_file "$work/extract/josi")" ] \
  || fail 'staged executable failed its pre-install digest check'
mv -f "$target_tmp" "$INSTALL_DIR/josi"
target_tmp=

printf 'Installed Josi CLI %s at %s/josi\n' "$VERSION" "$INSTALL_DIR"
case ":${PATH:-}:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf 'Add %s to PATH to run josi.\n' "$INSTALL_DIR" ;;
esac
