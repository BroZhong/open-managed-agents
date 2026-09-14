#!/usr/bin/env bash
# Build & push the code-interpreter-vfscli sandbox image.
#
# Build only by default. PUSH=1 explicitly publishes to REGISTRY; an image
# build does not update a SandboxSet or switch production Workspace storage.
# The ACS base mirror must be reachable from the chosen build host. The default
# is the Shanghai VPC mirror, so use vfs-dev or an authorized reachable mirror.
# vfs-cli is staged as a linux/amd64 binary; no runtime secrets enter the image.
#
# Env knobs:
#   REGISTRY     target image repository (default: Shanghai welltop registry)
#   TAG          image tag (default: code-interpreter-vfscli-<VERSION>)
#   VERSION      default tag version (0.5.0, OSS Workspace launcher)
#   BASE_IMAGE   approved ACS base reachable from the build host
#   VFS_CLI_SRC  path to an approved linux/amd64 vfs-cli binary
#   CACHE_DIR    persistent local buildx layer cache
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox}"
VERSION="${VERSION:-0.5.0}"
TAG="${TAG:-code-interpreter-vfscli-${VERSION}}"
BASE_IMAGE="${BASE_IMAGE:-registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6}"
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
# Python/local-directory layers. `--load` keeps the image locally when not pushing;
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
