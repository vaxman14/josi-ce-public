#!/usr/bin/env bash
# Run the complete bootstrap under Debian bookworm's real default mawk on both
# supported CPU architectures. Network-shaped fixtures preserve the production
# get.heyjosi.com and GitHub Cosign URL paths without trusting live services.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Keep fixtures under the checked-out tree: Docker Desktop on macOS does not
# mount every host /var/folders path, while GitHub's Linux runner accepts this too.
TMP="$(mktemp -d "$ROOT/.tmp-cli-installer.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
FIX="$TMP/fixture"
VERSION=1.2.3
RELEASE="$FIX/public/github.com/vaxman14/josi-ce-public/releases/download/v$VERSION"
mkdir -p "$RELEASE" "$FIX/public/github.com/sigstore/cosign/releases/download/v2.4.1" "$FIX/manifests" "$FIX/bin" "$TMP/payload"

cat > "$TMP/payload/josi" <<'EOF'
#!/bin/sh
if [ "${1:-}" = version ]; then
  printf '%s\n' 1.2.3
  exit 0
fi
printf '%s\n' installed-fixture
EOF
chmod 0755 "$TMP/payload/josi"
for arch in amd64 arm64; do
  tar -czf "$RELEASE/josi-cli-$VERSION-linux-$arch.tar.gz" -C "$TMP/payload" josi
done
{
  for arch in amd64 arm64; do
    archive="josi-cli-$VERSION-linux-$arch.tar.gz"
    printf '%s  %s\n' "$(sha256sum "$RELEASE/$archive" | awk '{print $1}')" "$archive"
  done
} > "$FIX/manifests/good"
cp "$FIX/manifests/good" "$RELEASE/josi-cli-$VERSION-checksums.txt"
printf '%s\n' signature > "$RELEASE/josi-cli-$VERSION-checksums.txt.sig"
printf '%s\n' certificate > "$RELEASE/josi-cli-$VERSION-checksums.txt.pem"
cat "$FIX/manifests/good" "$FIX/manifests/good" > "$FIX/manifests/duplicate"
awk '{ print "z" substr($1, 2), $2 }' "$FIX/manifests/good" > "$FIX/manifests/nonhex"
awk '{ print substr($1, 1, 63), $2 }' "$FIX/manifests/good" > "$FIX/manifests/short"
awk '{ print $1, $2 ".extra" }' "$FIX/manifests/good" > "$FIX/manifests/inexact"

cat > "$FIX/cosign" <<'EOF'
#!/bin/sh
args=$*
case "$args" in
  *"--certificate-identity https://github.com/vaxman14/josi-ce-public/.github/workflows/release.yml@refs/tags/v1.2.3"*) ;;
  *) exit 1 ;;
esac
case "$args" in
  *"--certificate-oidc-issuer https://token.actions.githubusercontent.com"*) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod 0700 "$FIX/cosign"
cp "$FIX/cosign" "$FIX/public/github.com/sigstore/cosign/releases/download/v2.4.1/cosign-linux-amd64"
cp "$FIX/cosign" "$FIX/public/github.com/sigstore/cosign/releases/download/v2.4.1/cosign-linux-arm64"

cat > "$FIX/bin/curl" <<'EOF'
#!/bin/sh
set -eu
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2 ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  https://get.heyjosi.com/install.sh)
    source=/source/get.heyjosi.com/install.sh
    ;;
  https://github.com/vaxman14/josi-ce-public/releases/download/v1.2.3/josi-cli-1.2.3-checksums.txt)
    source="/fixture/manifests/${FIXTURE_VARIANT:-good}"
    ;;
  https://github.com/vaxman14/josi-ce-public/releases/download/v1.2.3/*)
    source="/fixture/public/${url#https://}"
    ;;
  https://github.com/sigstore/cosign/releases/download/v2.4.1/cosign-linux-amd64|https://github.com/sigstore/cosign/releases/download/v2.4.1/cosign-linux-arm64)
    source="/fixture/public/${url#https://}"
    ;;
  *)
    printf 'unexpected fixture URL: %s\n' "$url" >&2
    exit 22
    ;;
esac
[ -s "$source" ] || exit 22
if [ -n "$out" ]; then cp "$source" "$out"; else cat "$source"; fi
EOF

cat > "$FIX/bin/sha256sum" <<'EOF'
#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && [ "${1##*/}" = cosign ]; then
  case "$(uname -m)" in
    x86_64|amd64) digest=8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b ;;
    aarch64|arm64) digest=3b2e2e3854d0356c45fe6607047526ccd04742d20bd44afb5be91fa2a6e7cb4a ;;
    *) exit 1 ;;
  esac
  printf '%s  %s\n' "$digest" "$1"
else
  exec /usr/bin/sha256sum "$@"
fi
EOF
chmod 0755 "$FIX/bin/curl" "$FIX/bin/sha256sum"

run_arch() {
  local platform=$1 arch=$2 out="$TMP/out-$2" image
  case "$arch" in
    amd64) image='debian:bookworm-slim@sha256:f3034a6ec3c1205360777c4aae76234998866ad18806ae62b63a3f84ccad782b' ;;
    arm64) image='debian:bookworm-slim@sha256:0c8bbb8e987a035fe1d9704eb2e571b7e9a836e1caa46345290674b45b69e417' ;;
    *) return 1 ;;
  esac
  mkdir -p "$out"
  docker run --rm --platform "$platform" \
    -v "$ROOT:/source:ro" \
    -v "$FIX:/fixture:ro" \
    -v "$out:/out" \
    "$image" sh -eu -c '
      export PATH=/fixture/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      awk -W version 2>&1 | grep -q "mawk 1.3.4"
      [ "$(dpkg --print-architecture)" = "$1" ]
      curl -fsSL https://get.heyjosi.com/install.sh \
        | sh -s -- --version 1.2.3 --install-dir /out --yes
      [ "$(/out/josi version)" = 1.2.3 ]
      before=$(/usr/bin/sha256sum /out/josi | awk "{print \$1}")
      for variant in duplicate nonhex short inexact; do
        if FIXTURE_VARIANT=$variant sh /source/get.heyjosi.com/install.sh \
          --version 1.2.3 --install-dir /out --yes >/tmp/failure.out 2>&1; then
          printf "invalid manifest unexpectedly installed: %s\n" "$variant" >&2
          exit 1
        fi
        grep -q "signed manifest does not contain exactly one valid digest" /tmp/failure.out
        [ "$(/usr/bin/sha256sum /out/josi | awk "{print \$1}")" = "$before" ]
        [ -z "$(find /out -name ".josi.install.*" -print -quit)" ]
      done
    ' sh "$arch"
  printf 'Debian bookworm/mawk clean-install regression passed: %s\n' "$platform"
}

run_arch linux/amd64 amd64
run_arch linux/arm64 arm64
