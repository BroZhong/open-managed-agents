#!/usr/bin/env bash
# Build the Server, Web, and Sandbox release images.
#
# Design constraints:
#   - all runtime images are linux/amd64 because agent-platform runs amd64;
#   - every Dockerfile starts from a pinned base in the Shanghai ACR;
#   - images are tagged with their build time in Beijing time (YYYYMMDDHHmm),
#     never with a deployment, and labelled with their Git revision; digests,
#     not tags, are what deployments reference;
#   - a pushed tag is never overwritten;
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

push=false
dry_run=false
allow_dirty=false
tag=""
sandbox_template="auto-story-v2"
components=()

usage() {
  cat <<'EOF'
Usage: deploy/scripts/build-images.sh [options] [server] [web] [sandbox]

Build OMA release images from the pinned Shanghai base images.

Options:
  --tag TAG       Image tag. Defaults to the build time in Beijing time,
                  YYYYMMDDHHmm (e.g. 202610261444), the same for every image.
                  With --push, a default tag that any of the images already
                  has becomes TAG-2, TAG-3, ...; an explicit TAG that exists
                  is refused.
  --sandbox-template auto-story-v2
                  Only maintained sandbox template (default: auto-story-v2).
  --push          Push to the Shanghai ACR instead of loading locally.
  --allow-dirty   Permit a dirty checkout. The default tag gains -dirty.
  --dry-run       Print the build commands without running them. With --push
                  it still asks the registry which tag is free.
  -h, --help      Show this help.

Images carry org.opencontainers.image.revision (the full Git SHA) and
org.opencontainers.image.created labels; tags never name a deployment.

With no component arguments, server and web are built. The sandbox component
builds and verifies auto-story-v2 using sandbox/auto-story-v2/ and its pinned releases.
EOF
}

while (($# > 0)); do
  case "$1" in
    --tag|--sandbox-template)
      (($# >= 2)) || { echo "$1 requires a value" >&2; exit 2; }
      case "$1" in
        --tag) tag="$2" ;;
        --sandbox-template) sandbox_template="$2" ;;
      esac
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

if [[ "${sandbox_template}" != auto-story-v2 ]]; then
  echo "Only --sandbox-template auto-story-v2 is maintained." >&2
  exit 2
fi

cd "${REPO_ROOT}"
git rev-parse --is-inside-work-tree >/dev/null
git_revision="$(git rev-parse HEAD)"
dirty=false
if [[ -n "$(git status --porcelain)" ]]; then
  dirty=true
fi

if [[ "${dirty}" == true && "${allow_dirty}" == false ]]; then
  echo "Refusing to build a dirty checkout. Commit the release or pass --allow-dirty." >&2
  exit 1
fi

if [[ -n "${tag}" && ! "${tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid image tag: ${tag}" >&2
  exit 2
fi

if ((${#components[@]} == 0)); then
  components=(server web)
fi

# One clock reading gives the default tag and the images' creation time.
# Without zoneinfo, TZ=Asia/Shanghai would silently mean UTC.
read -r build_minute created utc_offset < <(TZ=Asia/Shanghai date '+%Y%m%d%H%M %Y-%m-%dT%H:%M:%S+08:00 %z')
if [[ "${utc_offset}" != "+0800" ]]; then
  echo "TZ=Asia/Shanghai resolved to ${utc_offset:-nothing}, not +0800: install tzdata." >&2
  exit 1
fi

# The images the selected components produce under tag $1.
images_tagged() {
  local component
  for component in "${components[@]}"; do
    case "${component}" in
      server) printf '%s\n' "${REGISTRY}/oma-server:$1" ;;
      web) printf '%s\n' "${REGISTRY}/oma-web:$1" ;;
      sandbox) printf '%s\n' "${REGISTRY}/oma-sandbox:${sandbox_template}-$1" ;;
    esac
  done
}

# Print the first image the registry already has under tag $1; fail if none.
existing_image() {
  local image
  while read -r image; do
    if docker manifest inspect "${image}" </dev/null >/dev/null 2>&1; then
      printf '%s\n' "${image}"
      return 0
    fi
  done < <(images_tagged "$1")
  return 1
}

if [[ -z "${tag}" ]]; then
  tag="${build_minute}"
  if [[ "${dirty}" == true ]]; then
    tag="${build_minute}-dirty"
  fi
  if [[ "${push}" == true ]]; then
    default_tag="${tag}"
    suffix=1
    while existing_image "${tag}" >/dev/null; do
      suffix=$((suffix + 1))
      tag="${default_tag}-${suffix}"
    done
  fi
elif [[ "${push}" == true ]] && existing="$(existing_image "${tag}")"; then
  echo "Refusing to overwrite an existing tag: ${existing}" >&2
  exit 1
fi

git_described="${git_revision}"
if [[ "${dirty}" == true ]]; then
  git_described="${git_revision}-dirty"
fi
oci_labels=(
  --label "org.opencontainers.image.revision=${git_revision}"
  --label "org.opencontainers.image.created=${created}"
)

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
    --provenance=false \
    --cache-from "type=local,src=${cache_dir}" \
    --cache-to "type=local,dest=${cache_next},mode=max" \
    "${output[@]}" \
    "$@"
  run rm -rf "${cache_dir}"
  run mv "${cache_next}" "${cache_dir}"
}

server_image="${REGISTRY}/oma-server:${tag}"
web_image="${REGISTRY}/oma-web:${tag}"
sandbox_image="${REGISTRY}/oma-sandbox:${sandbox_template}-${tag}"

for component in "${components[@]}"; do
  case "${component}" in
    server)
      echo "==> server: ${server_image} (git ${git_described})"
      build_with_cache server \
        --file "${server_dockerfile}" \
        --build-arg "NODE_BASE=${NODE_BASE_IMAGE}" \
        "${oci_labels[@]}" \
        --tag "${server_image}" \
        "${REPO_ROOT}"
      ;;
    web)
      echo "==> web: ${web_image} (git ${git_described})"
      build_with_cache web \
        --file "${REPO_ROOT}/deploy/Dockerfile.web" \
        --build-arg "NODE_BASE=${NODE_BASE_IMAGE}" \
        --build-arg "NGINX_BASE=${NGINX_BASE_IMAGE}" \
        --build-arg "VITE_API_URL=${WEB_API_URL}" \
        "${oci_labels[@]}" \
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
        "TAG=${sandbox_template}-${tag}"
        "PUSH=${sandbox_push}"
      )
      if [[ -n "${AUTO_STORY_BASE_IMAGE:-}" ]]; then
        sandbox_command+=("BASE_IMAGE=${AUTO_STORY_BASE_IMAGE}")
      fi
      if [[ -n "${VFS_CLI_SRC:-}" ]]; then
        sandbox_command+=("VFS_CLI_SRC=${VFS_CLI_SRC}")
      fi
      sandbox_command+=(bash "${REPO_ROOT}/sandbox/auto-story-v2/build.sh")
      run "${sandbox_command[@]}"
      ;;
  esac
done

printf '\nRelease images (tag %s, git %s):\n' "${tag}" "${git_described}"
printf 'GIT_REVISION=%s\n' "${git_revision}"
for component in "${components[@]}"; do
  case "${component}" in
    server) printf 'SERVER_IMAGE=%s\n' "${server_image}" ;;
    web) printf 'WEB_IMAGE=%s\n' "${web_image}" ;;
    sandbox) printf 'POOL_IMAGE=%s\n' "${sandbox_image}" ;;
  esac
done
