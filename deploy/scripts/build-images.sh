#!/usr/bin/env bash
# Build the Server, Web, and optional custom Sandbox release images.
#
# Design constraints:
#   - all runtime images are linux/amd64 because agent-platform runs amd64;
#   - every Dockerfile starts from a pinned base in the Shanghai ACR;
#   - clean Git commits receive reproducible SHA tags;
#   - local BuildKit caches survive source-only iterations;
#   - building/pushing never mutates Kubernetes resources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop}"
PLATFORM="${PLATFORM:-linux/amd64}"
# The cache is deliberately repository-owned and fixed. Later `rm -rf` calls
# are therefore bounded to this ignored directory rather than an arbitrary
# caller-provided path.
CACHE_ROOT="${REPO_ROOT}/.buildx-cache"
WEB_API_URL="${WEB_API_URL:-/api}"

NODE_BASE_IMAGE="${NODE_BASE_IMAGE:-${REGISTRY}/node-base:22-slim-pnpm-10.12.4}"
NGINX_BASE_IMAGE="${NGINX_BASE_IMAGE:-${REGISTRY}/nginx-base:1.27-alpine}"
SANDBOX_BASE_IMAGE="${SANDBOX_BASE_IMAGE:-${REGISTRY}/sandbox-base:code-interpreter-v1.6}"

push=false
dry_run=false
allow_dirty=false
tag=""
components=()

usage() {
  cat <<'EOF'
Usage: deploy/scripts/build-images.sh [options] [server] [web] [sandbox]

Build OMA release images from the pinned Shanghai base images.

Options:
  --tag TAG       Image tag. Defaults to the current Git short SHA.
  --push          Push to the Shanghai ACR instead of loading locally.
  --allow-dirty   Permit a dirty checkout. The auto tag gains a dirty timestamp.
  --dry-run       Print commands without running Docker.
  -h, --help      Show this help.

With no component arguments, server and web are built. Building sandbox also
requires VFS_CLI_SRC or an already staged executable at
deploy/sandbox/code-interpreter-vfscli/bin/vfs-cli.
EOF
}

while (($# > 0)); do
  case "$1" in
    --tag)
      (($# >= 2)) || { echo "--tag requires a value" >&2; exit 2; }
      tag="$2"
      shift
      ;;
    --push) push=true ;;
    --allow-dirty) allow_dirty=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    server|web|sandbox) components+=("$1") ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

cd "${REPO_ROOT}"
git rev-parse --is-inside-work-tree >/dev/null
git_sha="$(git rev-parse --short=12 HEAD)"
dirty=false
if [[ -n "$(git status --porcelain)" ]]; then
  dirty=true
fi

if [[ "${dirty}" == true && "${allow_dirty}" == false ]]; then
  echo "Refusing to build a dirty checkout. Commit the release or pass --allow-dirty." >&2
  exit 1
fi

if [[ -z "${tag}" ]]; then
  tag="${git_sha}"
  if [[ "${dirty}" == true ]]; then
    tag="${git_sha}-dirty-$(date -u +%Y%m%d%H%M%S)"
  fi
fi

if [[ ! "${tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid image tag: ${tag}" >&2
  exit 2
fi

if ((${#components[@]} == 0)); then
  components=(server web)
fi

if [[ -L "${CACHE_ROOT}" ]]; then
  echo "Refusing to use a symlink as the managed build cache: ${CACHE_ROOT}" >&2
  exit 1
fi

render_dir="$(mktemp -d "${TMPDIR:-/tmp}/oma-image-build.XXXXXX")"
trap 'rm -rf "${render_dir}"' EXIT
server_dockerfile="${render_dir}/Dockerfile.server"
server_dockerignore="${render_dir}/Dockerfile.server.dockerignore"
cp "${REPO_ROOT}/deploy/Dockerfile.server.dockerignore" "${server_dockerignore}"

marker_counts="$(awk '
  /^# BEGIN WORKSPACE PACKAGE MANIFESTS$/ { begin += 1 }
  /^# END WORKSPACE PACKAGE MANIFESTS$/ { end += 1 }
  END { printf "%d %d", begin, end }
' "${REPO_ROOT}/deploy/Dockerfile.server")"
if [[ "${marker_counts}" != "1 1" ]]; then
  echo "Dockerfile.server must contain exactly one workspace manifest marker pair." >&2
  exit 1
fi

shopt -s nullglob
workspace_manifests=(
  "${REPO_ROOT}"/adapter/packages/*/package.json
  "${REPO_ROOT}"/server/packages/*/package.json
)
if ((${#workspace_manifests[@]} == 0)); then
  echo "No adapter or server workspace package manifests found." >&2
  exit 1
fi

# Keep the expensive dependency layer stable without maintaining a brittle
# hand-written list of workspace packages. The tracked Dockerfile remains
# readable; this rendered copy reflects every package in the current checkout.
{
  sed -n '1,/^# BEGIN WORKSPACE PACKAGE MANIFESTS$/p' "${REPO_ROOT}/deploy/Dockerfile.server"
  for manifest in "${workspace_manifests[@]}"; do
    relative_manifest="${manifest#${REPO_ROOT}/}"
    relative_dir="$(dirname "${relative_manifest}")"
    printf 'COPY %s ./%s/\n' "${relative_manifest}" "${relative_dir}"
  done
  sed -n '/^# END WORKSPACE PACKAGE MANIFESTS$/,$p' "${REPO_ROOT}/deploy/Dockerfile.server"
} >"${server_dockerfile}"

for root_copy in \
  'COPY adapter/pnpm-workspace.yaml adapter/package.json adapter/pnpm-lock.yaml ./adapter/' \
  'COPY server/pnpm-workspace.yaml server/package.json server/pnpm-lock.yaml ./server/'; do
  if ! grep -Fqx "${root_copy}" "${server_dockerfile}"; then
    echo "Rendered Dockerfile.server is missing: ${root_copy}" >&2
    exit 1
  fi
done

run() {
  if [[ "${dry_run}" == true ]]; then
    printf "+"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

build_with_cache() {
  local component="$1"
  shift
  local cache_dir="${CACHE_ROOT}/${component}"
  local cache_next="${cache_dir}.next"
  local output=(--load)
  if [[ "${push}" == true ]]; then
    output=(--push)
  fi

  # BuildKit cannot reliably import and export the same local cache directory.
  # Export to a sibling and swap it in only after a successful image build, so
  # a failed build leaves the last known-good cache untouched.
  run mkdir -p "${cache_dir}"
  run rm -rf "${cache_next}"
  run docker buildx build \
    --platform "${PLATFORM}" \
    --cache-from "type=local,src=${cache_dir}" \
    --cache-to "type=local,dest=${cache_next},mode=max" \
    "${output[@]}" \
    "$@"
  run rm -rf "${cache_dir}"
  run mv "${cache_next}" "${cache_dir}"
}

server_image="${REGISTRY}/oma-server:${tag}"
web_image="${REGISTRY}/oma-web:${tag}"
sandbox_image="${REGISTRY}/oma-sandbox:code-interpreter-vfscli-${tag}"

for component in "${components[@]}"; do
  case "${component}" in
    server)
      echo "==> server: ${server_image}"
      build_with_cache server \
        --file "${server_dockerfile}" \
        --build-arg "NODE_BASE=${NODE_BASE_IMAGE}" \
        --tag "${server_image}" \
        "${REPO_ROOT}"
      ;;
    web)
      echo "==> web: ${web_image}"
      build_with_cache web \
        --file "${REPO_ROOT}/deploy/Dockerfile.web" \
        --build-arg "NODE_BASE=${NODE_BASE_IMAGE}" \
        --build-arg "NGINX_BASE=${NGINX_BASE_IMAGE}" \
        --build-arg "VITE_API_URL=${WEB_API_URL}" \
        --tag "${web_image}" \
        "${REPO_ROOT}"
      ;;
    sandbox)
      echo "==> sandbox: ${sandbox_image}"
      sandbox_push=0
      [[ "${push}" == true ]] && sandbox_push=1
      sandbox_command=(
        env
        "REGISTRY=${REGISTRY}/oma-sandbox"
        "TAG=code-interpreter-vfscli-${tag}"
        "BASE_IMAGE=${SANDBOX_BASE_IMAGE}"
        "PUSH=${sandbox_push}"
      )
      if [[ -n "${VFS_CLI_SRC:-}" ]]; then
        sandbox_command+=("VFS_CLI_SRC=${VFS_CLI_SRC}")
      fi
      sandbox_command+=(bash "${REPO_ROOT}/deploy/sandbox/code-interpreter-vfscli/build.sh")
      run "${sandbox_command[@]}"
      ;;
  esac
done

printf '\nRelease images (tag %s):\n' "${tag}"
for component in "${components[@]}"; do
  case "${component}" in
    server) printf 'SERVER_IMAGE=%s\n' "${server_image}" ;;
    web) printf 'WEB_IMAGE=%s\n' "${web_image}" ;;
    sandbox) printf 'SANDBOX_IMAGE=%s\n' "${sandbox_image}" ;;
  esac
done
