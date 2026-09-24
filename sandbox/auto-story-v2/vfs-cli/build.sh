#!/usr/bin/env bash
# Build an additive vfs-cli-only image from the live production parent.
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${OVERLAY_DIR}/.." && pwd)"
cd "${ROOT}"

base_image="${BASE_IMAGE:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:2486e0b67f23cfda15055aaa9f5e0655a0e32acb45879124c191e7e1478d082c}"
expected_parent='registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:2486e0b67f23cfda15055aaa9f5e0655a0e32acb45879124c191e7e1478d082c'
if [[ "${base_image}" != "${expected_parent}" ]]; then
  echo "BASE_IMAGE must remain the live production digest: ${expected_parent}" >&2
  exit 2
fi

registry="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox}"
vfs_version="$(python3 -c 'import json; print(json.load(open("versions.json"))["vfs-cli"]["version"].removeprefix("v"))')"
vfs_archive_sha256="$(python3 -c 'import json; print(json.load(open("versions.json"))["vfs-cli"]["sha256"])')"
vfs_binary_sha256="$(python3 -c 'import json; print(json.load(open("versions.json"))["vfs-cli"]["binarySha256"])')"
tag="${TAG:-auto-story-v2-vfs-cli-${vfs_version}}"
image="${registry}:${tag}"

# Stage and verify only the vfs-cli archive. This does not invoke the clean
# recipe's broader fetch-sources.py or rebuild any inherited runtime layers.
python3 - "${ROOT}" <<'PY'
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.parse import urlparse

root = Path(sys.argv[1])
spec = json.loads((root / "versions.json").read_text())["vfs-cli"]
source = root / "sources" / Path(urlparse(spec["url"]).path).name
binary = root / "bin" / "vfs-cli"
source.parent.mkdir(exist_ok=True)
binary.parent.mkdir(exist_ok=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

if not source.exists() or digest(source) != spec["sha256"]:
    partial = source.with_suffix(source.suffix + ".partial")
    subprocess.run([
        "curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "20",
        "--max-time", "300", "--output", str(partial), spec["url"],
    ], check=True)
    if digest(partial) != spec["sha256"]:
        partial.unlink(missing_ok=True)
        raise SystemExit("vfs-cli archive SHA-256 mismatch")
    partial.replace(source)
elif binary.exists() and digest(binary) == spec["binarySha256"]:
    print(f"Verified staged vfs-cli {spec['version']}: {digest(binary)}", flush=True)
    raise SystemExit(0)

with tarfile.open(source) as archive:
    members = [member for member in archive.getmembers() if member.isfile() and Path(member.name).name == "vfs-cli"]
    if len(members) != 1:
        raise SystemExit(f"expected exactly one vfs-cli binary in {source}")
    extracted = archive.extractfile(members[0])
    if extracted is None:
        raise SystemExit("could not extract vfs-cli binary")
    partial_binary = binary.with_suffix(binary.suffix + ".partial")
    with partial_binary.open("wb") as destination:
        shutil.copyfileobj(extracted, destination)
    partial_binary.chmod(0o755)
    partial_binary.replace(binary)

if digest(binary) != spec["binarySha256"]:
    raise SystemExit("vfs-cli binary SHA-256 mismatch")
print(f"Verified staged vfs-cli {spec['version']}: {digest(binary)}", flush=True)
PY

docker buildx build --platform linux/amd64 --load --progress plain \
  --build-arg "BASE_IMAGE=${base_image}" \
  --build-arg "VFS_VERSION=${vfs_version}" \
  --build-arg "VFS_ARCHIVE_SHA256=${vfs_archive_sha256}" \
  --build-arg "VFS_BINARY_SHA256=${vfs_binary_sha256}" \
  --file "${OVERLAY_DIR}/Dockerfile" \
  --tag "${image}" \
  "${ROOT}"

if [[ "${VERIFY:-1}" == 1 ]]; then
  bash "${ROOT}/verify-image.sh" "${image}"
fi

if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "${image}"
fi

printf 'Image: %s\n' "${image}"
docker image inspect "${image}" --format 'Local image ID: {{.Id}}; Repo digests: {{json .RepoDigests}}'
