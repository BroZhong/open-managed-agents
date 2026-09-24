# Additive vfs-cli-only overlay for the live production sandbox image.
# Keep this parent digest pinned: the live image contains Whisper/scenedetect
# layers that are intentionally retained for this rollout.
ARG BASE_IMAGE=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:2486e0b67f23cfda15055aaa9f5e0655a0e32acb45879124c191e7e1478d082c
FROM ${BASE_IMAGE}

USER root
ARG BASE_IMAGE
ARG VFS_VERSION=0.3.18
ARG VFS_ARCHIVE_SHA256=6de350642795b6adc555424dd3d6194483aae8e7665cda29af7f014d429ee48e
ARG VFS_BINARY_SHA256=9c5d365165aafd6c29c835deebf216e966eeafe3d372f49d2bbfca7bfd85c348

# The binary is staged by build.sh from the official Linux amd64 archive.
COPY bin/vfs-cli /tmp/vfs-cli

RUN set -eux; \
    printf '%s  %s\n' "${VFS_BINARY_SHA256}" /tmp/vfs-cli | sha256sum -c -; \
    install -m 0755 /tmp/vfs-cli /usr/local/bin/vfs-cli; \
    rm -f /tmp/vfs-cli

# Keep the production image's complete runtime lock and smoke suite. Change
# only the vfs-cli records so Whisper/scenedetect and all inherited checks stay
# intact.
RUN VFS_VERSION="${VFS_VERSION}" VFS_ARCHIVE_SHA256="${VFS_ARCHIVE_SHA256}" VFS_BINARY_SHA256="${VFS_BINARY_SHA256}" python3 - <<'PY'
import json
import os
from pathlib import Path
import re

version = os.environ["VFS_VERSION"]
archive_sha256 = os.environ["VFS_ARCHIVE_SHA256"]
binary_sha256 = os.environ["VFS_BINARY_SHA256"]

versions_path = Path("/opt/auto-story/versions.json")
versions = json.loads(versions_path.read_text())
vfs = versions.get("vfs-cli")
if not isinstance(vfs, dict):
    raise SystemExit("/opt/auto-story/versions.json has no vfs-cli record")
vfs["version"] = f"v{version}"
vfs["url"] = f"https://github.com/welltop-cn/vfs-cli-dist/releases/download/v{version}/vfs-cli_v{version}_linux_amd64.tar.gz"
vfs["sha256"] = archive_sha256
vfs["binarySha256"] = binary_sha256
versions_path.write_text(json.dumps(versions, indent=2) + "\n")

smoke_path = Path("/usr/local/bin/auto-story-smoke")
smoke = smoke_path.read_text()
pattern = re.compile(r'(?m)^(\s*["\']vfs-cli["\']\s*:\s*["\'])[^"\']+(["\'])')
smoke, count = pattern.subn(rf"\g<1>{version}\g<2>", smoke)
if count != 1:
    raise SystemExit(f"expected one vfs-cli smoke expectation, found {count}")
smoke_path.write_text(smoke)

hashes_path = Path("/opt/auto-story/tool-sha256.txt")
lines = hashes_path.read_text().splitlines()
matches = [index for index, line in enumerate(lines) if line.endswith("  /usr/local/bin/vfs-cli")]
if len(matches) != 1:
    raise SystemExit(f"expected one vfs-cli tool hash, found {len(matches)}")
lines[matches[0]] = f"{binary_sha256}  /usr/local/bin/vfs-cli"
hashes_path.write_text("\n".join(lines) + "\n")
PY

RUN printf '%s  %s\n' "${VFS_BINARY_SHA256}" /usr/local/bin/vfs-cli | sha256sum -c - && \
    test "$(python3 -c 'import json; print(json.load(open("/opt/auto-story/versions.json"))["vfs-cli"]["version"])')" = "v${VFS_VERSION}" && \
    grep -F "\"vfs-cli\": \"${VFS_VERSION}\"" /usr/local/bin/auto-story-smoke >/dev/null && \
    grep -F "${VFS_BINARY_SHA256}  /usr/local/bin/vfs-cli" /opt/auto-story/tool-sha256.txt >/dev/null

LABEL org.opencontainers.image.title="auto-story-v2-vfs-cli-overlay" \
      org.opencontainers.image.version="vfs-cli-${VFS_VERSION}" \
      org.opencontainers.image.base.name="${BASE_IMAGE}"
