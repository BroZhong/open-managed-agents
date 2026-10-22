FROM registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:f95eebfa2adb297747d4ccb17d1c151ddf73e82549b76abecdc703ce39843309
USER root
COPY vfs-cli_v0.3.21_linux_amd64.tar.gz /tmp/vfs-cli.tar.gz
RUN echo "13a8125d6083d4747fe74b6d74142121c8c272c10f77b23e5b22334ab48abacb  /tmp/vfs-cli.tar.gz" | sha256sum -c - && tar -xzf /tmp/vfs-cli.tar.gz -C /usr/local/bin vfs-cli && chmod 755 /usr/local/bin/vfs-cli && rm /tmp/vfs-cli.tar.gz && mkdir -p /etc/vfs-cli
COPY update-records.py /opt/auto-story/vfs-cli-0.3.21/update-records.py
RUN python3 /opt/auto-story/vfs-cli-0.3.21/update-records.py && vfs-cli --version
LABEL org.opencontainers.image.version="0.3.3"
