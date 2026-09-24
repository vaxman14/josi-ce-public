#!/usr/bin/env bash
# Derive every Josi mark from the one approved master.
#
# THE IDENTITY: a white J on navy. The animal mark it replaced is retired; see
# docs/DECISION_TRACEABILITY.md M7-M10 for that history.
#
# The J is not drawn here. It is the J from `josi-wordmark.png`, which is the
# approved artwork — same letterform, same warm white, same navy field. Cutting
# the mark out of the wordmark is what keeps the two from drifting into two
# slightly different J's, and it is why this script exists rather than a set of
# hand-exported files nobody can reproduce.
#
#   bash scripts/build-brand.sh
#
# Needs ffmpeg. Everything it writes is committed, so an ordinary build does not
# run this — only a change to the master does.
set -euo pipefail

cd "$(dirname "$0")/.."

# 2026-09-02: the wordmark master was replaced with a transparent-alpha export
# (1231x573, no navy field, no vignette, plain dot over the i — the tennis-ball
# tittle left with the retired mascot). The crop/navy constants below describe
# the OLD flattened 1360x660 master and must be re-derived before this script
# is run again. Nothing runs it automatically; every output is committed.
WORDMARK="apps/web/public/brand/josi-wordmark.png"
NAVY="0x0A1B33"      # the wordmark's field, flattened — it carries a vignette
GLYPH_R=253          # the wordmark's own warm white, sampled: #fdf6ea
GLYPH_G=246
GLYPH_B=234

# The J's bounding box inside the 1360x660 wordmark.
CROP="400:530:55:70"
# How tall the glyph sits on a 1024 canvas. 600/1024 keeps it inside the 80%
# safe zone every maskable icon is cut down to, so one master serves both.
GLYPH_H=600

command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required" >&2; exit 2; }
[ -f "$WORDMARK" ] || { echo "missing $WORDMARK" >&2; exit 2; }

# Alpha is rebuilt from the glyph's own brightness rather than colour-keyed.
# The wordmark's background is a vignette, not one flat colour, so a key leaves
# a visible rectangle of the darker corner behind — which is exactly what the
# first attempt at this produced.
render() {
  local out="$1" size="$2" glyph_h="$3"
  ffmpeg -y -v error \
    -f lavfi -i "color=c=${NAVY}:s=${size}x${size}" \
    -i "$WORDMARK" \
    -filter_complex "\
[1:v]crop=${CROP},format=rgba,\
geq=r='${GLYPH_R}':g='${GLYPH_G}':b='${GLYPH_B}':a='clip(((r(X,Y)+g(X,Y)+b(X,Y))/3-40)*5,0,255)',\
scale=-1:${glyph_h}:flags=lanczos[j];\
[0:v][j]overlay=(W-w)/2:(H-h)/2" \
    -frames:v 1 "$out"
  echo "  wrote $out (${size}x${size})"
}

echo "Josi brand assets — white J on navy, cut from the approved wordmark"

render apps/web/public/brand/josi-mark.png 1024 "$GLYPH_H"
render apps/web/public/icons/icon-512.png    512 $((GLYPH_H * 512 / 1024))
render apps/web/public/icons/icon-192.png    192 $((GLYPH_H * 192 / 1024))

# Maskable icons are cropped to a circle by the platform, so the glyph is
# smaller: it has to survive losing the corners. 60% of the canvas rather than
# 59% of a square that keeps its edges.
render apps/web/public/icons/icon-maskable-512.png 512 $((512 * 44 / 100))

cp apps/web/public/brand/josi-mark.png docs-site/brand/josi-mark.png
echo "  copied docs-site/brand/josi-mark.png"

echo
echo "The wordmark itself is the master and is never regenerated."
