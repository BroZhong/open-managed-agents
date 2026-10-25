# oma-base: the platform Base Image every Environment is built on (ADR-0024).
# The pinned ACS code-interpreter image with Aliyun apt/pip/npm mirrors, Node
# 22 and the Host's exact Pi tool runtime, rg/fd, and tini in front of the
# original startup so the main process exits on SIGTERM. The image config adds
# no environment variables (no proxy, no secrets): Sandbox commands only see
# what envd's login shell sets, and an ENV here would override every
# Environment build's settings. Inputs are pinned in versions.json; build.sh
# passes them as build arguments.
ARG BASE_IMAGE
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS node

FROM ${BASE_IMAGE}
USER root
ARG TINI_VERSION
ARG PROCPS_VERSION
ARG UNZIP_VERSION
# Debian through the Aliyun mirror. The nodesource list is dropped: Node comes
# from the Host's node-base below; the base's apt Node 20 stays only for npm.
RUN rm -f /etc/apt/sources.list.d/nodesource.list && \
    sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      "tini=${TINI_VERSION}" "procps=${PROCPS_VERSION}" "unzip=${UNZIP_VERSION}" && \
    rm -rf /var/lib/apt/lists/*
COPY pip.conf /etc/pip.conf
# npm resolves its global config from the running node's prefix (/usr/local).
COPY npmrc /usr/local/etc/npmrc
# Pi 0.83 requires Node >=22.19; the ACS base ships Node 20.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY pi-tools/package.json pi-tools/package-lock.json pi-tools/smoke.mjs /opt/oma-pi-tools/
RUN cd /opt/oma-pi-tools && \
    npm ci --omit=dev --no-audit --no-fund --cache /tmp/oma-npm-cache && \
    rm -rf /tmp/oma-npm-cache
COPY stage/rg stage/fd /usr/local/bin/
COPY versions.json /tmp/oma-base-versions.json
COPY write-manifest /opt/oma/bin/write-manifest
COPY smoke.py /opt/oma/smoke/oma-base.py
# Sandbox commands run in a login shell whose PATH (/etc/profile) omits the
# ACS venv: these wrappers make python3/pip3 the venv's on any PATH.
RUN printf '%s  %s\n' \
      ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2 /usr/local/bin/rg \
      0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8 /usr/local/bin/fd | sha256sum --check - && \
    chmod 0755 /usr/local/bin/rg /usr/local/bin/fd /opt/oma/bin/write-manifest /opt/oma/smoke/oma-base.py && \
    for name in python3 python; do \
      printf '#!/bin/sh\nexec /opt/venv/bin/python3 "$@"\n' > "/usr/local/bin/${name}"; done && \
    for name in pip3 pip; do \
      printf '#!/bin/sh\nexec /opt/venv/bin/python3 -m pip "$@"\n' > "/usr/local/bin/${name}"; done && \
    chmod 0755 /usr/local/bin/python3 /usr/local/bin/python /usr/local/bin/pip3 /usr/local/bin/pip && \
    mkdir -p /opt/oma/images && \
    /usr/bin/python3 -I -c 'import json; v = json.load(open("/tmp/oma-base-versions.json")); json.dump({"name": "oma-base", "version": v["imageVersion"], "baseImage": v["baseImage"], "node": v["node"]["version"], "pi": v["pi-coding-agent"]["version"]}, open("/opt/oma/images/oma-base.json", "w"))' && \
    rm /tmp/oma-base-versions.json && \
    test ! -e /home/user/workspace && \
    find /home/user \( ! -user user -o ! -group user \) -exec chown -h user:user {} +
# tini is PID 1 and forwards SIGTERM to the whole startup process group (-g):
# the old `bash start-up.sh` ignored SIGTERM and waited out the grace period.
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "/root/.jupyter/start-up.sh"]
ARG IMAGE_VERSION
ARG BUILD_REVISION
LABEL org.opencontainers.image.title="oma-base" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.description="OMA Base Image: ACS code-interpreter, Aliyun mirrors, Node 22, Pi tool runtime, rg/fd, tini" \
      dev.oma.base-image="oma-base"
