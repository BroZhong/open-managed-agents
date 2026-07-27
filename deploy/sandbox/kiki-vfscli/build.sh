#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REGISTRY="${REGISTRY:-crpi-egv1p3qc9sh5spft.cn-hongkong.personal.cr.aliyuncs.com/brozhong/oma-sandbox}"
VERSION="${VERSION:-0.5.0}"
TAG="${TAG:-kiki-vfscli-${VERSION}}"
BASE_IMAGE="${BASE_IMAGE:-crpi-egv1p3qc9sh5spft.cn-hongkong.personal.cr.aliyuncs.com/brozhong/oma-sandbox:code-interpreter-vfscli-0.4.1}"
VFS_CLI_VERSION="${VFS_CLI_VERSION:-v0.2.19}"
EXPECTED_AGENT_SKILLS_COMMIT="${EXPECTED_AGENT_SKILLS_COMMIT:-d17fb790112cc23809b27e38704dc0198b69c270}"
CACHE_DIR="${CACHE_DIR:-/tmp/kiki-oma-buildx-cache}"
IMAGE="${REGISTRY}:${TAG}"

: "${VFS_CLI_SRC:?set VFS_CLI_SRC to the verified linux/amd64 vfs-cli binary}"
: "${AGENT_SKILLS_SRC:?set AGENT_SKILLS_SRC to the codex/decouple-skills-vfs-cli worktree}"

if [[ ! -x "${VFS_CLI_SRC}" ]]; then
  echo "ERROR: VFS_CLI_SRC is not executable: ${VFS_CLI_SRC}" >&2
  exit 1
fi
if [[ ! -f "${AGENT_SKILLS_SRC}/registry.json" ]]; then
  echo "ERROR: Agent-Skills registry not found under ${AGENT_SKILLS_SRC}" >&2
  exit 1
fi

actual_skills_commit="$(git -C "${AGENT_SKILLS_SRC}" rev-parse HEAD)"
if [[ "${actual_skills_commit}" != "${EXPECTED_AGENT_SKILLS_COMMIT}" ]]; then
  echo "ERROR: Agent-Skills must be ${EXPECTED_AGENT_SKILLS_COMMIT}; got ${actual_skills_commit}" >&2
  exit 1
fi

python3 "${AGENT_SKILLS_SRC}/pipeline/skill_decoupling_check.py"

context_dir="$(mktemp -d /tmp/kiki-oma-image.XXXXXX)"
trap 'rm -rf "$context_dir"' EXIT
install -m 0644 "${SCRIPT_DIR}/Dockerfile" "${context_dir}/Dockerfile"
install -m 0755 "${VFS_CLI_SRC}" "${context_dir}/vfs-cli"
mkdir -p "${context_dir}/agent-skills"

skill_count=0
while IFS= read -r skill_name; do
  skill_dir="${AGENT_SKILLS_SRC}/skills/${skill_name}"
  if [[ ! -f "${skill_dir}/SKILL.md" ]]; then
    echo "ERROR: enabled Skill is missing SKILL.md: ${skill_name}" >&2
    exit 1
  fi
  cp -R "${skill_dir}" "${context_dir}/agent-skills/${skill_name}"
  skill_count=$((skill_count + 1))
done < <(jq -r '.[] | select(.enabled == true) | .name' "${AGENT_SKILLS_SRC}/registry.json")

if [[ "${skill_count}" -ne 12 ]]; then
  echo "ERROR: expected 12 enabled decoupled Skills, got ${skill_count}" >&2
  exit 1
fi

build_output=(--load)
if [[ "${PUSH:-0}" == "1" ]]; then
  build_output=(--push)
fi

echo "==> image: ${IMAGE}"
echo "==> vfs-cli: ${VFS_CLI_VERSION}"
echo "==> Agent-Skills: ${actual_skills_commit} (${skill_count} enabled Skills)"
docker buildx build \
  --platform linux/amd64 \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  --build-arg "VFS_CLI_VERSION=${VFS_CLI_VERSION}" \
  --build-arg "AGENT_SKILLS_COMMIT=${actual_skills_commit}" \
  --cache-from "type=local,src=${CACHE_DIR}" \
  --cache-to "type=local,dest=${CACHE_DIR},mode=max" \
  -t "${IMAGE}" \
  "${build_output[@]}" \
  "${context_dir}"

echo "==> built ${IMAGE}"
