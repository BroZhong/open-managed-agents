#!/usr/bin/env bash
# Build, verify, then optionally push auto-story. Secrets are runtime inputs.
# VFS_CLI_SRC must be a Linux amd64 binary matching VFS_CLI_VERSION.
# MEDIAKIT_CLI_SRC can supply a prepared Linux binary for offline build hosts.
# --prepare-only stages the binaries without starting Docker.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${VERSION:-0.1.2}"
REGISTRY="${REGISTRY:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox}"
TAG="${TAG:-auto-story-${VERSION}}"
IMAGE="${REGISTRY}:${TAG}"
BASE_IMAGE="${BASE_IMAGE:-registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:0a3711009bf5aa907716f57364c8d69ad6e1b65e93d967c6f15615baf286d383}"
RUNTIME_IMAGE="${RUNTIME_IMAGE:-runtime}"
VFS_CLI_VERSION="${VFS_CLI_VERSION:-v0.3.14}"
MEDIAKIT_CLI_VERSION="${MEDIAKIT_CLI_VERSION:-0.2.1}"
# Official GitHub v0.2.1 checksums.txt, verified 2026-09-07. The checksum
# bundled in the locally installed npm package is stale for this release.
MEDIAKIT_ARCHIVE_SHA256="${MEDIAKIT_ARCHIVE_SHA256:-8c25ebd7c9446813dabb27700a9d4357c7d2325e528fe9caab31696aa1326987}"

case "${1:-}" in
  ""|--prepare-only) ;;
  *) echo "Usage: $0 [--prepare-only]" >&2; exit 2 ;;
esac

python3 ../prepare-search-binaries.py bin
mkdir -p bin
if [[ -n "${VFS_CLI_SRC:-}" ]]; then
  install -m 0755 "$VFS_CLI_SRC" bin/vfs-cli
fi
if [[ ! -f bin/vfs-cli ]]; then
  echo 'Set VFS_CLI_SRC to a Linux amd64 vfs-cli binary before building.' >&2
  exit 1
fi
if [[ -n "${MEDIAKIT_CLI_SRC:-}" ]]; then
  install -m 0755 "$MEDIAKIT_CLI_SRC" bin/mediakit-cli
elif [[ ! -f bin/mediakit-cli ]]; then
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  archive="mediakit-cli_${MEDIAKIT_CLI_VERSION}_linux_amd64.tar.gz"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 180 \
    "https://github.com/volcengine/mediakit-cli/releases/download/v${MEDIAKIT_CLI_VERSION}/${archive}" \
    --output "$download_dir/$archive"
  python3 - "$download_dir/$archive" "$MEDIAKIT_ARCHIVE_SHA256" <<'PY'
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit("MediaKit release archive checksum mismatch")
PY
  tar -xzf "$download_dir/$archive" -C "$download_dir" mediakit-cli
  install -m 0755 "$download_dir/mediakit-cli" bin/mediakit-cli
fi

# Fail before a slow build if a caller accidentally supplies their Mac CLI.
python3 - <<'PY'
import pathlib, struct
for name in ("vfs-cli", "mediakit-cli"):
    header = (pathlib.Path("bin") / name).read_bytes()[:20]
    if len(header) != 20 or header[:6] != b"\x7fELF\x02\x01" or struct.unpack("<H", header[18:20])[0] != 62:
        raise SystemExit(f"{name}: expected a Linux amd64 ELF binary")
print("Linux amd64 CLI inputs verified")
PY
if [[ "${1:-}" == --prepare-only ]]; then
  exit 0
fi

docker buildx build --platform linux/amd64 --load \
  --build-arg "BASE_IMAGE=$BASE_IMAGE" \
  --build-arg "RUNTIME_IMAGE=$RUNTIME_IMAGE" \
  --build-arg "VFS_CLI_VERSION=$VFS_CLI_VERSION" \
  --build-arg "MEDIAKIT_CLI_VERSION=$MEDIAKIT_CLI_VERSION" \
  --build-arg "PIP_INDEX_URL=${PIP_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple/}" \
  -t "$IMAGE" .
./verify-image.sh "$IMAGE"
if [[ "${PUSH:-0}" == 1 ]]; then
  docker push "$IMAGE"
fi
printf 'Built and verified: %s\n' "$IMAGE"
