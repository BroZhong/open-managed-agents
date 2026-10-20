# Preserve the exact live 0.3.0 image, including offline Whisper, Pi and ACS.
FROM registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:6f5eedfc6c0b68056c79d316b9676487a481eb28dcc2f035ffed28d8db591eb8
USER root
COPY release.json requirements.txt inventory.py update-records.py /opt/auto-story/runtime-overlay/
RUN python3 /opt/auto-story/runtime-overlay/inventory.py capture
COPY pip.conf /etc/pip.conf
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-upgrade libgl1 && \
    rm -rf /var/lib/apt/lists/* && \
    python3 -m pip install --no-cache-dir \
      -c /opt/auto-story/runtime-overlay/constraints.txt \
      -r /opt/auto-story/runtime-overlay/requirements.txt
COPY vfs-cli_v0.3.19_linux_amd64.tar.gz /tmp/vfs-cli.tar.gz
RUN echo '8c3251bab72e3eec6753ed5c4055ae298cdbddcee6b9b8c8d8b594bcc26104e8  /tmp/vfs-cli.tar.gz' | sha256sum -c - && \
    mkdir /tmp/vfs-cli-extract && tar -xzf /tmp/vfs-cli.tar.gz -C /tmp/vfs-cli-extract && \
    install -m 0755 /tmp/vfs-cli-extract/vfs-cli /usr/local/bin/vfs-cli && \
    rm -rf /tmp/vfs-cli.tar.gz /tmp/vfs-cli-extract && \
    python3 /opt/auto-story/runtime-overlay/update-records.py && \
    python3 /opt/auto-story/runtime-overlay/inventory.py verify && \
    python3 -m pip freeze > /opt/auto-story/python-packages.txt && \
    dpkg-query -W > /opt/auto-story/debian-packages.txt
COPY smoke.py /opt/auto-story/runtime-overlay/smoke.py
COPY proxy.env /etc/oma/proxy.env
# Image defaults apply to inheriting processes. E2B tool envs must also be
# injected at Sandbox creation; the release must validate that separately.
ENV HTTP_PROXY=http://sing-box.oma-infra.svc.cluster.local:7890 \
    HTTPS_PROXY=http://sing-box.oma-infra.svc.cluster.local:7890 \
    http_proxy=http://sing-box.oma-infra.svc.cluster.local:7890 \
    https_proxy=http://sing-box.oma-infra.svc.cluster.local:7890 \
    NO_PROXY=localhost,127.0.0.1,::1,.svc,.cluster.local \
    no_proxy=localhost,127.0.0.1,::1,.svc,.cluster.local
ARG BUILD_REVISION
LABEL org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.version="0.3.1" \
      org.opencontainers.image.title="auto-story-v2-runtime-overlay" \
      org.opencontainers.image.base.name="registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:6f5eedfc6c0b68056c79d316b9676487a481eb28dcc2f035ffed28d8db591eb8" \
      tech.welltop.vfs-cli.version="v0.3.19"
