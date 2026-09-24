#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ORIGINAL_PATH="$PATH"
REAL_SHA256SUM="$(command -v sha256sum 2>/dev/null || true)"
REAL_SHASUM="$(command -v shasum 2>/dev/null || true)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"; FIX="$TMP/fixtures"; DEST="$TMP/dest"; mkdir -p "$BIN" "$FIX" "$DEST" "$TMP/stage"
printf '#!/bin/sh\n[ "${1:-}" = version ] && { echo 1.2.3; exit 0; }; echo installed-fixture\n' > "$TMP/stage/josi"; chmod 755 "$TMP/stage/josi"
tar -czf "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz" -C "$TMP/stage" josi
real_hash(){ if command -v sha256sum >/dev/null; then command sha256sum "$1" | awk '{print $1}'; else command shasum -a 256 "$1" | awk '{print $1}'; fi; }
printf '%s  %s\n' "$(real_hash "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz")" 'josi-cli-1.2.3-linux-amd64.tar.gz' > "$FIX/josi-cli-1.2.3-checksums.txt"
GOOD_MANIFEST="$TMP/good-checksums.txt"; cp "$FIX/josi-cli-1.2.3-checksums.txt" "$GOOD_MANIFEST"
printf 'signature\n' > "$FIX/josi-cli-1.2.3-checksums.txt.sig"; printf 'certificate\n' > "$FIX/josi-cli-1.2.3-checksums.txt.pem"
cat > "$FIX/cosign" <<'EOF'
#!/bin/sh
[ "${FAKE_SIGNATURE_OK:-1}" = 1 ]
EOF
chmod 700 "$FIX/cosign"
cat > "$BIN/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = -m ] && echo x86_64 || echo Linux
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=''; url="${@: -1}"
for ((i=1;i<=$#;i++)); do [[ "${!i}" == --output ]] && { j=$((i+1)); out="${!j}"; }; done
name="${url##*/}"
case "$name" in
  cosign-linux-amd64) cp "$FAKE_FIX/cosign" "$out";;
  josi-cli-1.2.3-linux-amd64.tar.gz) cp "$FAKE_FIX/$name" "$out"; if [[ "${FAKE_PARTIAL_FAIL:-0}" == 1 ]]; then head -c 10 "$FAKE_FIX/$name" > "$out"; exit 22; fi; if [[ "${FAKE_TAMPER:-0}" == 1 ]]; then printf x >> "$out"; fi;;
  *) cp "$FAKE_FIX/$name" "$out";;
esac
EOF
cat > "$BIN/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
f="${@: -1}"
if [[ "$f" == */cosign ]]; then echo '8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b  cosign'
elif [[ -n "${REAL_SHA256SUM:-}" ]]; then "$REAL_SHA256SUM" "$f"
else "$REAL_SHASUM" -a 256 "$f"; fi
EOF
chmod +x "$BIN/"*
export PATH="$BIN:$ORIGINAL_PATH" FAKE_FIX="$FIX" REAL_SHA256SUM REAL_SHASUM
INSTALLER="$ROOT/get.""hey""josi.com""/install.sh"
pass=0; ok(){ pass=$((pass+1)); echo "ok $pass - $1"; }; bad(){ echo "not ok - $1" >&2; exit 1; }
grep -q 'base_url="https://github.com/vaxman14/josi-ce-public/releases/download/v${VERSION}"' "$INSTALLER" || bad public-origin
grep -q 'github.com/vaxman14/josi-ce/releases/download' "$INSTALLER" && bad private-origin
ok 'unauthenticated installs use the public versioned artifact origin'
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --non-interactive >/dev/null
[[ -x "$DEST/josi" ]] || bad valid; ok 'valid signed/checksummed noninteractive install succeeds'
installed_hash=$(real_hash "$DEST/josi"); FAKE_TAMPER=1 sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad tamper
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad tamper-write; ok 'archive tampering fails closed and preserves the prior atomic install'
cp "$GOOD_MANIFEST" "$FIX/josi-cli-1.2.3-checksums.txt"; cat "$GOOD_MANIFEST" >> "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad duplicate-digest
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad duplicate-write; ok 'duplicate valid manifest entries fail closed'
tr 'a-f' 'A-F' < "$GOOD_MANIFEST" > "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad uppercase-digest
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad uppercase-write; ok 'non-canonical digest characters fail closed'
sed 's/josi-cli-1.2.3-linux-amd64.tar.gz/josi-cli-1.2.3-linux-amd64.tar.gz.extra/' "$GOOD_MANIFEST" > "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad inexact-name
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad inexact-write; ok 'an inexact archive filename fails closed'
awk '{ print substr($1, 1, 63), $2 }' "$GOOD_MANIFEST" > "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad short-digest
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad short-write; ok 'a digest with the wrong length fails closed'
cp "$GOOD_MANIFEST" "$FIX/josi-cli-1.2.3-checksums.txt"
FAKE_SIGNATURE_OK=0 sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad signature
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad signature-write; ok 'detached signature failure refuses installation'
FAKE_PARTIAL_FAIL=1 sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad partial
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] && [[ -z "$(find "$DEST" -name '.josi.install.*' -print -quit)" ]] || bad partial-write; ok 'partial downloads and temporary install files are removed on failure'
python3 - "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz" <<'PY'
import io,sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as t:
    d=b'#!/bin/sh\necho 1.2.3\n'; i=tarfile.TarInfo('../josi'); i.mode=0o755; i.size=len(d); t.addfile(i,io.BytesIO(d))
PY
printf '%s  %s\n' "$(real_hash "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz")" 'josi-cli-1.2.3-linux-amd64.tar.gz' > "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad traversal
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad traversal-write; ok 'archive traversal entries are rejected before extraction'
python3 - "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz" <<'PY'
import sys,tarfile
with tarfile.open(sys.argv[1],'w:gz') as t:
    i=tarfile.TarInfo('josi'); i.type=tarfile.SYMTYPE; i.linkname='/etc/passwd'; i.mode=0o755; t.addfile(i)
PY
printf '%s  %s\n' "$(real_hash "$FIX/josi-cli-1.2.3-linux-amd64.tar.gz")" 'josi-cli-1.2.3-linux-amd64.tar.gz' > "$FIX/josi-cli-1.2.3-checksums.txt"
sh "$INSTALLER" --version 1.2.3 --install-dir "$DEST" --yes >/dev/null 2>&1 && bad symlink
[[ "$(real_hash "$DEST/josi")" == "$installed_hash" ]] || bad symlink-write; ok 'archive symlink payloads are rejected before installation'
sh "$INSTALLER" --install-dir "$DEST" --yes >/dev/null 2>&1 && bad version
ok 'missing explicit version is rejected'
sh "$INSTALLER" --version latest --install-dir "$DEST" --yes >/dev/null 2>&1 && bad latest
ok 'moving latest version is rejected'
echo "installer tests passed: $pass"
