#!/usr/bin/env bash
# Build the architecture-labelled Josi CLI release archives and, when requested,
# sign their checksum manifest with Sigstore's GitHub Actions OIDC identity.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=""
OUTPUT_DIR="$ROOT/dist/cli"
SOURCE="$ROOT/scripts/josi"
SIGN=0

usage() {
  cat <<'EOF'
Usage: scripts/build-cli-release.sh --version VERSION [options]

Options:
  --output-dir DIR  Write release files to DIR (default: dist/cli)
  --source FILE     Package FILE as the josi executable (default: scripts/josi)
  --sign            Create a keyless Sigstore signature and certificate
  --help            Show this help

--sign requires cosign and an ambient protected OIDC signer, such as the
GitHub Actions id-token permission. This script never accepts a private key.
EOF
}

die() {
  printf 'build-cli-release: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --version)
      (($# >= 2)) || die '--version needs a value'
      VERSION=$2
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die '--output-dir needs a value'
      OUTPUT_DIR=$2
      shift 2
      ;;
    --source)
      (($# >= 2)) || die '--source needs a value'
      SOURCE=$2
      shift 2
      ;;
    --sign)
      SIGN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "$VERSION" ]] || die '--version is required'
VERSION=${VERSION#v}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z][0-9A-Za-z.-]*)?$ ]] \
  || die 'version must be an explicit release version such as 0.1.48'
[[ -f "$SOURCE" ]] || die "CLI source not found: $SOURCE"
[[ -r "$SOURCE" ]] || die "CLI source is not readable: $SOURCE"
command -v tar >/dev/null 2>&1 || die 'tar is required'
command -v python3 >/dev/null 2>&1 || die 'python3 is required to stamp the embedded CLI version'

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die 'sha256sum or shasum is required'
  fi
}

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
stage=$(mktemp -d "${TMPDIR:-/tmp}/josi-cli-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT

install -m 0755 "$SOURCE" "$stage/josi"
python3 - "$stage/josi" "$VERSION" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text()
old='JOSI_CLI_VERSION="${JOSI_CLI_VERSION:-0.1.0}"'
if s.count(old) != 1:
    raise SystemExit('CLI version marker is missing or ambiguous')
p.write_text(s.replace(old, f'JOSI_CLI_VERSION="${{JOSI_CLI_VERSION:-{sys.argv[2]}}}"'))
PY
bash -n "$stage/josi"
[[ "$(env -u JOSI_CLI_VERSION "$stage/josi" version)" == "$VERSION" ]] || die 'staged CLI version does not match release version'

# The CLI is a portable shell program. Publish both architecture names so an
# installer can select a conventional target without pretending the payloads
# differ. COPYFILE_DISABLE avoids macOS metadata in locally built archives.
for arch in amd64 arm64; do
  archive="josi-cli-${VERSION}-linux-${arch}.tar.gz"
  COPYFILE_DISABLE=1 tar -czf "$OUTPUT_DIR/$archive" -C "$stage" josi
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$archive")" "$archive"
done > "$OUTPUT_DIR/josi-cli-${VERSION}-checksums.txt"

checksums="$OUTPUT_DIR/josi-cli-${VERSION}-checksums.txt"
if ((SIGN)); then
  command -v cosign >/dev/null 2>&1 || die 'cosign is required with --sign'
  [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] \
    || die '--sign requires a protected GitHub Actions OIDC signer'
  cosign sign-blob --yes \
    --output-signature "$checksums.sig" \
    --output-certificate "$checksums.pem" \
    "$checksums"
fi

printf 'Built Josi CLI %s in %s\n' "$VERSION" "$OUTPUT_DIR"
