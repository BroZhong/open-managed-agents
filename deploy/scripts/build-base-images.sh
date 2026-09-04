#!/usr/bin/env bash
# Bootstrap the small set of versioned bases consumed by normal OMA builds.
#
# Base publication is intentionally separate from application publication:
# upstream registries are contacted only when a base is introduced/refreshed;
# day-to-day Server/Web/Sandbox builds then pull solely from Shanghai ACR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop}"
PLATFORM="${PLATFORM:-linux/amd64}"
PNPM_VERSION="${PNPM_VERSION:-10.12.4}"

NODE_UPSTREAM="${NODE_UPSTREAM:-${REGISTRY}/node-base:22-slim}"
NGINX_UPSTREAM="${NGINX_UPSTREAM:-nginx:1.27-alpine}"
SANDBOX_UPSTREAM="${SANDBOX_UPSTREAM:-registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6}"

NODE_BASE_IMAGE="${NODE_BASE_IMAGE:-${REGISTRY}/node-base:22-slim-pnpm-${PNPM_VERSION}}"
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE:-${REGISTRY}/nginx-base:1.27-alpine}"
SANDBOX_BASE_IMAGE="${SANDBOX_BASE_IMAGE:-${REGISTRY}/sandbox-base:code-interpreter-v1.6}"

push=false
force=false
dry_run=false
components=()

usage() {
  cat <<'EOF'
Usage: deploy/scripts/build-base-images.sh [options] [node] [nginx] [sandbox]

Build the pinned base images used by OMA application builds.

Options:
  --push       Push images to the Shanghai ACR instead of loading locally.
  --force      Rebuild even when the target tag already exists in the registry.
  --dry-run    Print commands without running Docker.
  -h, --help   Show this help.

With no component arguments, all three bases are processed. Existing remote
tags are skipped during --push unless --force is supplied.
EOF
}

while (($# > 0)); do
  case "$1" in
    --push) push=true ;;
    --force) force=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    node|nginx|sandbox) components+=("$1") ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ((${#components[@]} == 0)); then
  components=(node nginx sandbox)
fi

run() {
  if [[ "${dry_run}" == true ]]; then
    printf "+"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

target_exists() {
  local image="$1"
  [[ "${push}" == true && "${force}" == false && "${dry_run}" == false ]] || return 1
  # Tags are treated as immutable by default. `--force` is the explicit escape
  # hatch for an intentional rebuild of an existing base tag.
  docker buildx imagetools inspect "${image}" >/dev/null 2>&1
}

build_base() {
  local component="$1"
  local dockerfile="$2"
  local upstream="$3"
  local target="$4"
  shift 4

  if target_exists "${target}"; then
    echo "==> ${component}: already exists, skipping ${target}"
    return 0
  fi

  local output=(--load)
  if [[ "${push}" == true ]]; then
    output=(--push)
  fi

  echo "==> ${component}: ${upstream} -> ${target}"
  run docker buildx build \
    --platform "${PLATFORM}" \
    --file "${dockerfile}" \
    --build-arg "UPSTREAM_IMAGE=${upstream}" \
    "$@" \
    --tag "${target}" \
    "${output[@]}" \
    "${REPO_ROOT}/deploy/base-images"
}

for component in "${components[@]}"; do
  case "${component}" in
    node)
      build_base node \
        "${REPO_ROOT}/deploy/base-images/Dockerfile.node" \
        "${NODE_UPSTREAM}" "${NODE_BASE_IMAGE}" \
        --build-arg "PNPM_VERSION=${PNPM_VERSION}"
      ;;
    nginx)
      build_base nginx \
        "${REPO_ROOT}/deploy/base-images/Dockerfile.nginx" \
        "${NGINX_UPSTREAM}" "${NGINX_BASE_IMAGE}"
      ;;
    sandbox)
      build_base sandbox \
        "${REPO_ROOT}/deploy/base-images/Dockerfile.sandbox" \
        "${SANDBOX_UPSTREAM}" "${SANDBOX_BASE_IMAGE}"
      ;;
  esac
done

printf '\nBase image references:\n'
printf 'NODE_BASE_IMAGE=%s\n' "${NODE_BASE_IMAGE}"
printf 'NGINX_BASE_IMAGE=%s\n' "${NGINX_BASE_IMAGE}"
printf 'SANDBOX_BASE_IMAGE=%s\n' "${SANDBOX_BASE_IMAGE}"
