#!/usr/bin/env bash
# Build the CE image for both target architectures from this one Dockerfile.
#
# CE is meant to run on an old 64-bit desktop and on a Raspberry Pi, so amd64
# and arm64 are both first-class. They are built from the same source in the
# same invocation; there is no separate ARM branch to drift.
#
#   scripts/build-multiarch.sh                  build both, keep in the cache
#   scripts/build-multiarch.sh --push ghcr.io/…  build both and push a manifest
#   scripts/build-multiarch.sh --load-native     build only this host's arch and
#                                                load it into the local daemon
#
# A multi-platform build cannot be `--load`ed into the local daemon — Docker's
# image store holds one architecture per tag — so verifying both locally means
# inspecting the build cache rather than running the foreign one.
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORMS="linux/amd64,linux/arm64"
BUILDER="josi-ce-builder"
IMAGE="${JOSI_IMAGE:-josi-ce}"
TAG="${JOSI_TAG:-local}"

command -v docker >/dev/null 2>&1 || { echo "docker is not installed"; exit 2; }
docker buildx version >/dev/null 2>&1 || { echo "docker buildx is required"; exit 2; }

if [[ "${1:-}" == "--load-native" ]]; then
  native="linux/$(docker info --format '{{.Architecture}}' | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
  echo "==> building $native only, loading into the local daemon"
  docker buildx build --platform "$native" --tag "${IMAGE}:${TAG}" --load .
  docker image inspect "${IMAGE}:${TAG}" --format 'built {{.Os}}/{{.Architecture}}  {{.Size}} bytes'
  exit 0
fi

# A dedicated builder with the docker-container driver: the default `docker`
# driver cannot do multi-platform.
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  echo "==> creating buildx builder $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use >/dev/null
fi
docker buildx use "$BUILDER"

# Cross-building arm64 on an amd64 host (or the reverse) needs QEMU registered
# with the kernel. Docker Desktop ships this; a bare Linux host may not.
echo "==> available platforms"
docker buildx inspect --bootstrap "$BUILDER" | grep -i platforms || true

if [[ "${1:-}" == "--push" ]]; then
  registry="${2:?usage: --push <registry/namespace>}"
  echo "==> building ${PLATFORMS} and pushing ${registry}/${IMAGE}:${TAG}"
  docker buildx build --platform "$PLATFORMS" --tag "${registry}/${IMAGE}:${TAG}" --push .
  echo "==> manifest"
  docker buildx imagetools inspect "${registry}/${IMAGE}:${TAG}"
else
  echo "==> building ${PLATFORMS} (cache only; use --push to publish a manifest)"
  docker buildx build --platform "$PLATFORMS" --tag "${IMAGE}:${TAG}" .
  echo
  echo "Both architectures built. Neither was loaded into the local daemon:"
  echo "a multi-platform result cannot be --load'ed, only pushed to a registry."
fi
