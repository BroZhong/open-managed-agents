#!/usr/bin/env bash
# Build only: never mutates Kubernetes or existing Sandboxes.
set -euo pipefail
cd "$(dirname "$0")"
parent="$(python3 -c 'import json;print(json.load(open("release.json"))["parent"])')"
tag="$(python3 -c 'import json;print(json.load(open("release.json"))["tag"])')"
image="registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:${tag}"
archive=vfs-cli_v0.3.19_linux_amd64.tar.gz
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 300 \
    -o "${archive}.partial" "https://github.com/welltop-cn/vfs-cli-dist/releases/download/v0.3.19/${archive}"
  mv "${archive}.partial" "$archive"
fi
printf '%s  %s\n' 8c3251bab72e3eec6753ed5c4055ae298cdbddcee6b9b8c8d8b594bcc26104e8 "$archive" | sha256sum -c -
docker buildx build --platform linux/amd64 --load --progress plain \
  --build-arg "BUILD_REVISION=$(git rev-parse HEAD)" -t "$image" .
# RootFS prefix and startup config must match the pinned production parent.
python3 - "$parent" "$image" <<'PY'
import json, subprocess, sys
parent, image = [json.loads(subprocess.check_output(['docker','image','inspect',s]))[0] for s in sys.argv[1:]]
a, b = parent['RootFS']['Layers'], image['RootFS']['Layers']
assert b[:len(a)] == a
for k in ['Entrypoint','Cmd','User','WorkingDir','Healthcheck']:
    assert parent['Config'].get(k) == image['Config'].get(k), k
old = dict(s.split('=', 1) for s in parent['Config']['Env'])
new = dict(s.split('=', 1) for s in image['Config']['Env'])
assert all(new.get(k) == v for k,v in old.items())
print('Parent layers, startup contract and all inherited environment values preserved')
PY
docker run --rm --network none --entrypoint python3 "$image" /opt/auto-story/runtime-overlay/inventory.py verify
bash ../verify-image.sh "$image"
docker run --rm --network none --user user --workdir /home/user --entrypoint /usr/bin/env "$image" \
  -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin \
  node /opt/oma-pi-tools/smoke.mjs
docker run --rm --network none --user user --workdir /home/user --entrypoint /usr/bin/env "$image" \
  -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin \
  python3 /opt/auto-story/runtime-overlay/smoke.py | tee verification.json
if [[ "${PUSH:-0}" == 1 ]]; then docker push "$image"; fi
docker image inspect "$image" --format '{{json .}}' | python3 -c '
import json,sys
x=json.load(sys.stdin)
print(json.dumps({"imageId":x["Id"],"repoDigests":x.get("RepoDigests",[]),"size":x["Size"],"labels":x["Config"]["Labels"]},indent=2))' > build-metadata.json
printf 'Verified image: %s\n' "$image"
cat build-metadata.json
