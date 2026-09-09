#!/usr/bin/env bash
# Run on an amd64 builder with access to the Shanghai ACS base-image mirror.
set -euo pipefail
cd "$(dirname "$0")"
prepare_only=0
if [[ "$#" == 1 && "$1" == --prepare-only ]]; then
  prepare_only=1
elif [[ "$#" != 0 ]]; then
  echo 'Usage: build.sh [--prepare-only]' >&2
  exit 2
fi
if [[ -n "${RUNTIME_IMAGE:-}" ]]; then
  echo 'RUNTIME_IMAGE is no longer supported: build from the clean ACS base to exclude OpenMontage and Whisper.' >&2
  exit 2
fi
# Component versions and hashes are updated together in versions.json, never
# silently replaced through a legacy version environment variable.
for key in VFS_CLI_VERSION MEDIAKIT_CLI_VERSION; do
  if [[ -n "${!key:-}" ]]; then
    echo "${key} is pinned in versions.json; update the lock and acceptance checks together." >&2
    exit 2
  fi
done
image_version="${VERSION:-$(python3 -c 'import json; print(json.load(open("versions.json"))["imageVersion"])')}"
base_image="${BASE_IMAGE:-$(python3 -c 'import json; print(json.load(open("versions.json"))["baseImage"])')}"
registry="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox}"
tag="${TAG:-auto-story-${image_version}}"
image="${registry}:${tag}"
python3 ./fetch-sources.py
if [[ "$prepare_only" == 1 ]]; then
  exit 0
fi
# docker-container builders do not load the base into the Docker Engine.
if ! docker image inspect "$base_image" >/dev/null 2>&1; then
  docker pull --platform linux/amd64 "$base_image"
fi
docker buildx build --platform linux/amd64 --load --progress plain \
  --build-arg "BASE_IMAGE=${base_image}" --build-arg "BUILD_JOBS=${BUILD_JOBS:-6}" \
  --build-arg "IMAGE_VERSION=${image_version}" \
  --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}" \
  --metadata-file build-metadata.json --tag "$image" .
bash ./verify-image.sh "$image" | tee verification.json
expected_startup="$(docker image inspect "$base_image" --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}')"
actual_startup="$(docker image inspect "$image" --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}')"
if [[ "$actual_startup" != "$expected_startup" ]]; then
  echo 'Image changed the ACS startup contract' >&2
  exit 1
fi
if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "$image"
fi
printf 'Image: %s\n' "$image"
docker image inspect "$image" --format 'Size: {{.Size}} bytes; digests: {{json .RepoDigests}}'
