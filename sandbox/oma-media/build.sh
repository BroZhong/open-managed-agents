#!/usr/bin/env bash
# Build and verify oma-media on an amd64 builder (vfs-dev), FROM the oma-base
# digest pinned in versions.json. PUSH=1 publishes the verified image under a
# new tag; an existing tag is never overwritten.
# Writes build-metadata.json and verification.json (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
read_version() { python3 -c 'import json,sys; v=json.load(open("versions.json"))
for key in sys.argv[1].split("."): v=v[key]
print(v)' "$1"; }
image_version="$(read_version imageVersion)"
base_image="$(read_version baseImage)"
repository="$(read_version repository)"
tag="${TAG:-oma-media-${image_version}}"
image="${repository}:${tag}"

# FROM must be the published oma-base, pinned by digest.
python3 - "$base_image" <<'PY'
import json, re, sys
base = sys.argv[1]
if not re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", base):
    raise SystemExit(f"baseImage must be digest-pinned: {base}")
lock = json.load(open("../oma-base/image.lock.json"))
if lock["ref"] != base:
    raise SystemExit(f"baseImage {base} is not the published oma-base {lock['ref']}")
PY

python3 ./fetch-sources.py
docker image inspect "$base_image" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$base_image"
if [[ "${PUSH:-0}" == 1 ]] && docker manifest inspect "$image" >/dev/null 2>&1; then
  echo "Tag already exists, refusing to overwrite: $image" >&2
  exit 1
fi

docker buildx build --platform linux/amd64 --load --provenance=false --progress plain \
  --build-arg "BASE_IMAGE=${base_image}" --build-arg "BUILD_JOBS=${BUILD_JOBS:-8}" \
  --build-arg "IMAGE_VERSION=${image_version}" \
  --build-arg "BUILD_REVISION=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  --tag "$image" .
# The platform contract of oma-base, then the media checks.
bash ../oma-base/verify-image.sh "$image" /opt/oma/smoke/oma-media.py > verification.json
echo "Verified: $image" >&2

if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "$image"
fi
python3 - "$image" "${PUSH:-0}" "$base_image" > build-metadata.json <<'PY'
import json, subprocess, sys
image, pushed, base = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
info = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
parent = json.loads(subprocess.check_output(["docker", "image", "inspect", base]))[0]
layers, parent_layers = info["RootFS"]["Layers"], parent["RootFS"]["Layers"]
if layers[:len(parent_layers)] != parent_layers:
    raise SystemExit("oma-media does not extend the oma-base layers")
repository = image.rsplit(":", 1)[0]
digests = [d for d in info.get("RepoDigests", []) if d.startswith(repository + "@")]
unpacked = subprocess.check_output(["docker", "image", "ls", image, "--format", "{{.Size}}"], text=True).strip()
result = {"image": image, "imageId": info["Id"], "unpackedSize": unpacked, "layers": len(layers),
          "layersAboveBase": len(layers) - len(parent_layers), "labels": info["Config"].get("Labels") or {}}
if pushed and digests:
    result["ref"] = digests[0]
    manifest = json.loads(subprocess.check_output(["docker", "buildx", "imagetools", "inspect", "--raw", digests[0]]))
    result["mediaType"] = manifest.get("mediaType")
    if "layers" in manifest:
        result["compressedBytes"] = sum(layer["size"] for layer in manifest["layers"]) + manifest["config"]["size"]
print(json.dumps(result, indent=2))
PY
cat build-metadata.json
# The published digest is the recipe's lock: commit image.lock.json.
if [[ "${PUSH:-0}" == 1 ]]; then
  python3 - "$(git rev-parse HEAD 2>/dev/null || echo unknown)" > image.lock.json <<'PY'
import json, sys
from datetime import date
meta = json.load(open("build-metadata.json"))
print(json.dumps({"tag": meta["image"], "ref": meta["ref"], "mediaType": meta.get("mediaType"),
                  "compressedBytes": meta.get("compressedBytes"), "unpackedSize": meta["unpackedSize"],
                  "layers": meta["layers"], "revision": sys.argv[1], "verifiedAt": date.today().isoformat()}, indent=2))
PY
  cat image.lock.json
fi
