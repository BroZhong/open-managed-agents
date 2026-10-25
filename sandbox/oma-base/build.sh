#!/usr/bin/env bash
# Build and verify oma-base on an amd64 builder that reaches the Shanghai VPC
# registry and the Aliyun mirrors (vfs-dev). PUSH=1 publishes the verified
# image under a new tag; an existing tag is never overwritten.
# Writes build-metadata.json and verification.json (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
read_version() { python3 -c 'import json,sys; v=json.load(open("versions.json"))
for key in sys.argv[1].split("."): v=v[key]
print(v)' "$1"; }
image_version="$(read_version imageVersion)"
base_image="$(read_version baseImage)"
node_image="$(read_version node.image)"
repository="$(read_version repository)"
tag="${TAG:-oma-base-${image_version}}"
image="${repository}:${tag}"

# The Pi tool runtime must be the Host's exact version (ADR-0014).
python3 - <<'PY'
import json
versions = json.load(open("versions.json"))["pi-coding-agent"]
host = json.load(open("../../" + versions["hostPackage"]))["dependencies"]["@earendil-works/pi-coding-agent"]
lock = json.load(open(versions["lockfile"]))["packages"]["node_modules/@earendil-works/pi-coding-agent"]["version"]
if not host == lock == versions["version"]:
    raise SystemExit(f"Pi versions differ: Host {host}, lockfile {lock}, versions.json {versions['version']}")
print(f"Pi {lock} matches the Host")
PY

# rg/fd: pinned release binaries (RG_SRC / FD_SRC may supply them offline).
python3 ../prepare-search-binaries.py stage
for ref in "$base_image" "$node_image"; do
  docker image inspect "$ref" >/dev/null 2>&1 || docker pull --platform linux/amd64 "$ref"
done
if [[ "${PUSH:-0}" == 1 ]] && docker manifest inspect "$image" >/dev/null 2>&1; then
  echo "Tag already exists, refusing to overwrite: $image" >&2
  exit 1
fi

docker buildx build --platform linux/amd64 --load --provenance=false --progress plain \
  --build-arg "BASE_IMAGE=${base_image}" --build-arg "NODE_IMAGE=${node_image}" \
  --build-arg "TINI_VERSION=$(read_version debian.tini)" \
  --build-arg "PROCPS_VERSION=$(read_version debian.procps)" \
  --build-arg "UNZIP_VERSION=$(read_version debian.unzip)" \
  --build-arg "IMAGE_VERSION=${image_version}" \
  --build-arg "BUILD_REVISION=$(git rev-parse HEAD 2>/dev/null || echo unknown)" \
  --tag "$image" .
bash ./verify-image.sh "$image" > verification.json
echo "Verified: $image" >&2

if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "$image"
fi
python3 - "$image" "${PUSH:-0}" > build-metadata.json <<'PY'
import json, subprocess, sys
image, pushed = sys.argv[1], sys.argv[2] == "1"
info = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
repository = image.rsplit(":", 1)[0]
digests = [d for d in info.get("RepoDigests", []) if d.startswith(repository + "@")]
result = {"image": image, "imageId": info["Id"], "uncompressedBytes": info["Size"],
          "layers": len(info["RootFS"]["Layers"]), "labels": info["Config"].get("Labels") or {}}
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
                  "compressedBytes": meta.get("compressedBytes"), "uncompressedBytes": meta["uncompressedBytes"],
                  "layers": meta["layers"], "revision": sys.argv[1], "verifiedAt": date.today().isoformat()}, indent=2))
PY
  cat image.lock.json
fi
