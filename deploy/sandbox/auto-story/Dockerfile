# E2B-compatible media workspace. Keep the ACS entrypoint/CMD: agent-runtime
# injects envd around the existing Jupyter startup contract.
ARG BASE_IMAGE=registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:0a3711009bf5aa907716f57364c8d69ad6e1b65e93d967c6f15615baf286d383
# A pinned, previously verified auto-story image can supply unchanged runtime
# dependencies for a CLI-only release. The default builds that runtime below.
ARG RUNTIME_IMAGE=runtime
FROM ${BASE_IMAGE} AS runtime

ARG SANDBOX_USER=user
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/

# Only non-secret defaults belong in the image. Per-Agent environment values
# are supplied through sandbox.env / the Host's scoped secret injection.
ENV WORKSPACE_DIR=/home/user \
    MEDIAKIT_OUTPUT_PATH=/home/user/media \
    MEDIAKIT_SURFACE=skill \
    MEDIAKIT_RUNTIME=pi-agent

USER root
RUN if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg ca-certificates && \
    rm -rf /var/lib/apt/lists/*; \
    fi && \
    ln -sf /opt/venv/bin/python /usr/local/bin/python && \
    ln -sf /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sf /opt/venv/bin/pip /usr/local/bin/pip && \
    ln -sf /opt/venv/bin/pip3 /usr/local/bin/pip3 && \
    mkdir -p /home/user/media /opt/auto-story && \
    chown "${SANDBOX_USER}:${SANDBOX_USER}" /home/user /home/user/media

COPY requirements.txt /opt/auto-story/requirements.txt
# Keep Jupyter's base environment intact while retaining its preinstalled
# scientific packages for agent scripts through system-site-packages.
RUN /opt/venv/bin/python3 -m venv --system-site-packages /opt/auto-story/venv && \
    /opt/auto-story/venv/bin/python3 -m pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /opt/auto-story/requirements.txt && \
    ln -sf /opt/auto-story/venv/bin/python /usr/local/bin/python && \
    ln -sf /opt/auto-story/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sf /opt/auto-story/venv/bin/pip /usr/local/bin/pip && \
    ln -sf /opt/auto-story/venv/bin/pip3 /usr/local/bin/pip3
# Invoking a Python binary through a symlink outside its venv loses pyvenv.cfg
# discovery. An exec launcher preserves the venv on envd's minimal PATH.
RUN rm /usr/local/bin/python /usr/local/bin/python3 && \
    printf '#!/bin/sh\nexec /opt/auto-story/venv/bin/python3 "$@"\n' > /usr/local/bin/python3 && \
    chmod 0755 /usr/local/bin/python3 && \
    ln -s /usr/local/bin/python3 /usr/local/bin/python && \
    python3 -c 'import pathlib,subprocess,sysconfig; pathlib.Path(sysconfig.get_paths()["purelib"], "acs-base.pth").write_text(subprocess.check_output(["/opt/venv/bin/python3", "-c", "import site; print(chr(10).join(site.getsitepackages()))"], text=True))'

FROM ${RUNTIME_IMAGE}
ARG SANDBOX_USER=user
ARG VFS_CLI_VERSION=v0.3.14
ARG MEDIAKIT_CLI_VERSION=0.2.1
USER root
# Pi search binaries are staged from pinned, checksum-verified upstream releases.
# Keep this in the final stage so RUNTIME_IMAGE reuse also gets the new tools.
COPY bin/rg bin/fd /usr/local/bin/
RUN chmod 0755 /usr/local/bin/rg /usr/local/bin/fd && \
    printf '%s\n' \
      'ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2  /usr/local/bin/rg' \
      '0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8  /usr/local/bin/fd' | sha256sum --check - && \
    mkdir -p /opt/pi-search && \
    rg --version > /opt/pi-search/rg-version.txt && \
    fd --version > /opt/pi-search/fd-version.txt && \
    grep -Fx 'fd 10.4.2' /opt/pi-search/fd-version.txt && \
    sha256sum /usr/local/bin/rg /usr/local/bin/fd > /opt/pi-search/tool-sha256.txt
# Linux binaries are staged and checked before build. No runtime installation
# and no installer side effects in HOME or the equipped Skill projections.
COPY bin/vfs-cli bin/mediakit-cli /usr/local/bin/
COPY smoke.py /usr/local/bin/auto-story-smoke
RUN chmod 0755 /usr/local/bin/vfs-cli /usr/local/bin/mediakit-cli /usr/local/bin/auto-story-smoke && \
    vfs-cli version > /opt/auto-story/vfs-cli.json && \
    python3 -c 'import json,sys; assert json.load(open("/opt/auto-story/vfs-cli.json"))["data"]["version"] == sys.argv[1]' "${VFS_CLI_VERSION}" && \
    mediakit-cli --version > /opt/auto-story/mediakit-version.txt && \
    grep -Fx "mediakit-cli version ${MEDIAKIT_CLI_VERSION}" /opt/auto-story/mediakit-version.txt && \
    sha256sum /usr/local/bin/vfs-cli /usr/local/bin/mediakit-cli > /opt/auto-story/tool-sha256.txt && \
    python3 -m pip freeze > /opt/auto-story/python-packages.txt && \
    su -s /bin/sh "${SANDBOX_USER}" -c 'cd /home/user && env -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin auto-story-smoke'

# No ENTRYPOINT/CMD overrides. E2B commands execute as SANDBOX_USER at runtime.
