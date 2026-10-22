#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
image=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-0.3.3-20261022
archive=vfs-cli_v0.3.21_linux_amd64.tar.gz
if [[ ! -f "$archive" ]]; then
  curl -fL --retry 3 --connect-timeout 20 --max-time 300 -o "$archive" "https://github.com/welltop-cn/vfs-cli-dist/releases/download/v0.3.21/$archive"
fi
echo "13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb  $archive" | sha256sum -c -
docker buildx build --platform linux/amd64 --load --progress plain -t "$image" .
docker run --rm --network none --entrypoint python3 "$image" /opt/auto-story/runtime-overlay/inventory.py verify
docker run --rm --network none --entrypoint python3 "$image" /opt/auto-story/runtime-overlay/smoke.py
docker run --rm --network none --entrypoint node "$image" /opt/oma-pi-tools/smoke.mjs
docker run --rm --network none --entrypoint vfs-cli "$image" --version
if [[ "${PUSH:-0}" == 1 ]]; then docker push "$image"; fi
docker image inspect "$image" --format '{{json .RepoDigests}}' > build-metadata.json
