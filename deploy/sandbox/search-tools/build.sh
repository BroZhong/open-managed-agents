#!/usr/bin/env bash
# Add only pinned rg/fd to an existing template, preserving its exact base.
set -euo pipefail
cd "$(dirname "$0")"

: "${BASE_IMAGE:?Set BASE_IMAGE to the running template image by immutable digest}"
: "${TAG:?Set a distinct TAG for this template search update}"
case "$BASE_IMAGE" in
  *@sha256:*) ;;
  *) echo 'BASE_IMAGE must use an immutable sha256 digest' >&2; exit 2 ;;
esac
REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox}"
IMAGE="${REGISTRY}:${TAG}"

python3 ../prepare-search-binaries.py bin
docker buildx build --platform linux/amd64 --load \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$IMAGE" .

# Ensure this narrow overlay retains the base runtime contract and layers.
python3 - "$BASE_IMAGE" "$IMAGE" <<'PY'
import json, subprocess, sys
base, image = [json.loads(subprocess.check_output(["docker", "image", "inspect", ref]))[0]
               for ref in sys.argv[1:]]
for field in ("User", "Entrypoint", "Cmd", "WorkingDir", "Env", "ExposedPorts", "Healthcheck"):
    assert image["Config"].get(field) == base["Config"].get(field), f"base config changed: {field}"
layers = base["RootFS"]["Layers"]
assert image["RootFS"]["Layers"][:len(layers)] == layers, "base layers changed"
print("Pinned base layers and runtime configuration preserved")
PY
docker run --rm --platform linux/amd64 --network none --user user \
  --workdir /home/user --entrypoint /usr/bin/env "$IMAGE" \
  -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin /bin/sh -eu -c '
    rg --version
    fd --version
    fixture=$(mktemp -d)
    trap '\''rm -rf "$fixture"'\'' EXIT
    mkdir "$fixture/.git" "$fixture/src" "$fixture/ignored"
    printf "ignored/\n" > "$fixture/.gitignore"
    printf "故事 hello\n" > "$fixture/src/child.ts"
    printf "ignored\n" > "$fixture/ignored/secret.ts"
    found=$(rg --files --hidden --glob "*.ts" "$fixture")
    test "$found" = "$fixture/src/child.ts"
    found=$(rg --no-heading --color=never --glob "*.{ts,js}" -- "\\p{L}+" "$fixture")
    test "$found" = "$fixture/src/child.ts:故事 hello"
    found=$(fd --glob --hidden --full-path -- "**/src/?hild.ts" "$fixture")
    test "$found" = "$fixture/src/child.ts"
  '
if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "$IMAGE"
fi
printf 'Built and verified: %s\n' "$IMAGE"
