#!/usr/bin/env bash
# Build & push the code-interpreter-vfscli sandbox image.
#
# The image FROMs the ACS code-interpreter base and layers on a user-writable
# canonical /home/user (#85), vfs-cli, and python on a
# plain PATH. See ./Dockerfile for the layer-by-layer rationale.
#
# Field-tested constraints this script encodes (see .scratch/deploy notes):
#   - Sandboxes run linux/amd64 on the brozhong HK cluster → always build amd64,
#     even from an arm64 Mac (emulation is fine; the image is small).
#   - The ACS base only pulls from a *region-local VPC* ACR mirror. On the
#     Shanghai build host (vfs-dev) that is the cn-shanghai-vpc mirror; the HK
#     VPC / public variants are unreachable from there. BASE_IMAGE is overridable
#     for exactly this reason.
#   - vfs-cli's release CDN is slow/flaky from CN hosts, so the binary is COPYd
#     from bin/ rather than curl'd at build time. Populate bin/vfs-cli first.
#   - buildx + a persistent cache dir turns a warm rebuild (vfs-cli bump only)
#     into two layers instead of the whole image.
#
# Usage:
#   ./build.sh                 # build only, tag locally
#   PUSH=1 ./build.sh          # build + push to $REGISTRY
#
# Env knobs (all have sensible defaults):
#   REGISTRY     target repo (default: brozhong HK personal ACR)
#   TAG          image tag   (default: code-interpreter-vfscli-<VERSION>)
#   VERSION      semantic bump used in the default tag (default: 0.4.1)
#   BASE_IMAGE   ACS base    (default: HK VPC mirror; set cn-shanghai-vpc on vfs-dev)
#   VFS_CLI_SRC  path to the linux/amd64 vfs-cli binary to stage into bin/
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-crpi-egv1p3qc9sh5spft.cn-hongkong.personal.cr.aliyuncs.com/brozhong/oma-sandbox}"
VERSION="${VERSION:-0.4.1}"
TAG="${TAG:-code-interpreter-vfscli-${VERSION}}"
BASE_IMAGE="${BASE_IMAGE:-registry-cn-hongkong-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6}"
PLATFORM="linux/amd64"
IMAGE="${REGISTRY}:${TAG}"
CACHE_DIR="${CACHE_DIR:-.buildx-cache}"

# ── Stage the vfs-cli binary into the build context ──────────────────────────
# The Dockerfile COPYs bin/vfs-cli. If VFS_CLI_SRC is given, stage it; otherwise
# require that bin/vfs-cli already exists (e.g. placed by a prior run or scp).
mkdir -p bin
if [[ -n "${VFS_CLI_SRC:-}" ]]; then
  echo "==> staging vfs-cli from ${VFS_CLI_SRC}"
  install -m 0755 "${VFS_CLI_SRC}" bin/vfs-cli
fi
if [[ ! -x bin/vfs-cli ]]; then
  echo "ERROR: bin/vfs-cli is missing. Set VFS_CLI_SRC=/path/to/linux-amd64/vfs-cli" >&2
  echo "       (the binary is a build artifact, intentionally not committed)." >&2
  exit 1
fi
echo "==> vfs-cli: $(file -b bin/vfs-cli 2>/dev/null || echo present)"

# The image ships only a generic launcher; the business script remains in each
# Skill. Exercise the launcher against the repository's three identical Skill
# copies before spending time on a Docker build.
sh ./test-story-seed-launcher.sh

# ── Build (cache-first) ──────────────────────────────────────────────────────
# Local layer cache persisted under CACHE_DIR so a vfs-cli-only bump reuses the
# apt/symlink/chown layers. `--load` keeps the image locally when not pushing;
# `--push` streams straight to the registry.
BUILD_OUTPUT=(--load)
if [[ "${PUSH:-0}" == "1" ]]; then
  BUILD_OUTPUT=(--push)
fi

echo "==> building ${IMAGE} (${PLATFORM}) from ${BASE_IMAGE}"
docker buildx build \
  --platform "${PLATFORM}" \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  --cache-from "type=local,src=${CACHE_DIR}" \
  --cache-to "type=local,dest=${CACHE_DIR},mode=max" \
  -t "${IMAGE}" \
  "${BUILD_OUTPUT[@]}" \
  .

echo "==> done: ${IMAGE}"
if [[ "${PUSH:-0}" != "1" ]]; then
  echo "    (built locally; re-run with PUSH=1 to push to ACR)"
fi
