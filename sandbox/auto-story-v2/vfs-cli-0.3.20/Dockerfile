FROM registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:d0a845742fc6fd1b435a5066c5911ce52100e97678addecd04b17c49be8ee095
USER root
COPY vfs-cli_v0.3.20_linux_amd64.tar.gz /tmp/vfs-cli.tar.gz
RUN echo "a9192a9f784642c8189027ca5662636cab03988973e8656ee2aaf69d9d8dfafd  /tmp/vfs-cli.tar.gz" | sha256sum -c - && tar -xzf /tmp/vfs-cli.tar.gz -C /usr/local/bin vfs-cli && chmod 755 /usr/local/bin/vfs-cli && rm /tmp/vfs-cli.tar.gz && mkdir -p /etc/vfs-cli
COPY update-records.py /opt/auto-story/vfs-cli-0.3.20/update-records.py
RUN python3 /opt/auto-story/vfs-cli-0.3.20/update-records.py && vfs-cli --version
LABEL org.opencontainers.image.version="0.3.2"
