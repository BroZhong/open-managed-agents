#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
image=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-v2-0.3.2-20261022
archive=vfs-cli_v0.3.20_linux_amd64.tar.gz
curl -fL --retry 3 -o "$archive" "https://github.com/welltop-cn/vfs-cli-dist/releases/download/v0.3.20/$archive"
echo "a9192a9f784642c8189027ca5662636cab03988973e8656ee2aaf69d9d8dfafd  $archive" | sha256sum -c -
docker buildx build --platform linux/amd64 --load --progress plain -t "$image" .
docker run --rm --network none --entrypoint python3 "$image" /opt/auto-story/runtime-overlay/inventory.py verify
docker run --rm --network none --entrypoint python3 "$image" /opt/auto-story/runtime-overlay/smoke.py
docker run --rm --network none --entrypoint node "$image" /opt/oma-pi-tools/smoke.mjs
docker run --rm --network none --entrypoint vfs-cli "$image" --version
if [[ "${PUSH:-0}" == 1 ]]; then docker push "$image"; fi
docker image inspect "$image" --format '{{json .RepoDigests}}' > build-metadata.json
