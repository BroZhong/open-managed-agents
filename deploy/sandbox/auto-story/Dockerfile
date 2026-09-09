# Clean ACS base: no OpenMontage layers, Whisper packages, or model weights.
# Preserve the base's Jupyter entrypoint/CMD for ACK agent-runtime / E2B envd.
ARG BASE_IMAGE=registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter@sha256:b53bc461e59fda3bff45bb3682d1b56f071e772989d3579cd1773165b4e761fb
FROM ${BASE_IMAGE} AS ffmpeg-build
USER root
ARG BUILD_JOBS=6
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential nasm pkg-config xz-utils ca-certificates \
      libx264-dev libx265-dev libopenh264-dev libvpx-dev libaom-dev libmp3lame-dev \
      libopus-dev libvorbis-dev libass-dev libfreetype6-dev libfontconfig1-dev \
      libfribidi-dev libharfbuzz-dev libwebp-dev libgnutls28-dev zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
COPY sources/ffmpeg-9.0.1.tar.xz /tmp/ffmpeg.tar.xz
RUN echo 'cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635  /tmp/ffmpeg.tar.xz' | sha256sum -c - && \
    mkdir /tmp/ffmpeg-src && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg-src --strip-components=1 && \
    cd /tmp/ffmpeg-src && \
    ./configure --prefix=/usr/local \
      --disable-debug --disable-doc --disable-ffplay --disable-shared --enable-static \
      --enable-gpl --enable-gnutls --enable-libx264 --enable-libx265 --enable-libopenh264 \
      --enable-libvpx --enable-libaom --enable-libmp3lame --enable-libopus \
      --enable-libvorbis --enable-libass --enable-libfreetype --enable-libfontconfig \
      --enable-libfribidi --enable-libharfbuzz --enable-libwebp --disable-whisper && \
    make -j"${BUILD_JOBS}" ffmpeg ffprobe && \
    mkdir -p /out && cp ffmpeg ffprobe /out/ && strip /out/ffmpeg /out/ffprobe

FROM ${BASE_IMAGE} AS runtime
USER root
ARG IMAGE_VERSION=0.2.1
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV WORKSPACE_DIR=/home/user \
    MEDIAKIT_OUTPUT_PATH=/home/user/media \
    MEDIAKIT_SURFACE=skill \
    MEDIAKIT_RUNTIME=pi-agent \
    PATH=/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates libx264-164 libx265-199 libopenh264-7 libvpx7 libaom3 libmp3lame0 \
      libopus0 libvorbis0a libvorbisenc2 libass9 libfreetype6 libfontconfig1 \
      libfribidi0 libharfbuzz0b libwebp7 libwebpmux3 libgnutls30 zlib1g \
      fontconfig fonts-dejavu-core fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /home/user/media /opt/auto-story && \
    chown user:user /home/user /home/user/media && chmod 0775 /home/user /home/user/media
COPY requirements.txt versions.json /opt/auto-story/
# Install Gemini independently; expose scientific packages from the clean ACS
# base after this venv's packages, without modifying Jupyter's environment.
RUN /opt/venv/bin/python3 -m venv /opt/auto-story/venv && \
    /opt/auto-story/venv/bin/python3 -m pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r /opt/auto-story/requirements.txt && \
    /opt/auto-story/venv/bin/python3 -c 'import pathlib, site; pathlib.Path(site.getsitepackages()[0], "acs-base.pth").write_text("/opt/venv/lib/python3.11/site-packages\n")' && \
    printf '#!/bin/sh\nexec /opt/auto-story/venv/bin/python3 "$@"\n' > /usr/local/bin/python3 && \
    printf '#!/bin/sh\nexec /opt/auto-story/venv/bin/python3 -m pip "$@"\n' > /usr/local/bin/pip3 && \
    chmod 0755 /usr/local/bin/python3 /usr/local/bin/pip3 && \
    ln -sf /usr/local/bin/python3 /usr/local/bin/python && \
    ln -sf /usr/local/bin/pip3 /usr/local/bin/pip && \
    /opt/auto-story/venv/bin/python3 -m pip freeze > /opt/auto-story/python-packages.txt
COPY --from=ffmpeg-build /out/ffmpeg /out/ffprobe /usr/local/bin/
COPY bin/vfs-cli bin/mediakit-cli bin/rg bin/fd /usr/local/bin/
RUN chmod 0755 /usr/local/bin/vfs-cli /usr/local/bin/mediakit-cli /usr/local/bin/rg /usr/local/bin/fd && \
    printf '%s\n' \
      'fb9b291e8940a4cfaf7812fc897ee85d0e679b08c6c12b4f44adb63aa4b9ec63  /usr/local/bin/vfs-cli' \
      '2c962efef686307e8e839face4a347634e939b84b2a4df5caf292b035e5f96ca  /usr/local/bin/mediakit-cli' \
      'ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2  /usr/local/bin/rg' \
      '0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8  /usr/local/bin/fd' | sha256sum --check - && \
    mkdir -p /opt/pi-search && \
    rg --version > /opt/pi-search/rg-version.txt && fd --version > /opt/pi-search/fd-version.txt && \
    sha256sum /usr/local/bin/rg /usr/local/bin/fd > /opt/pi-search/tool-sha256.txt && \
    sha256sum /usr/local/bin/vfs-cli /usr/local/bin/mediakit-cli /usr/local/bin/ffmpeg /usr/local/bin/ffprobe > /opt/auto-story/tool-sha256.txt && \
    dpkg-query -W > /opt/auto-story/debian-packages.txt
COPY smoke.py /usr/local/bin/auto-story-smoke
RUN chmod 0755 /usr/local/bin/auto-story-smoke && \
    su -s /bin/sh user -c 'cd /home/user && env -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin auto-story-smoke'
LABEL org.opencontainers.image.title="auto-story" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.description="E2B media sandbox with vfs-cli, FFmpeg, Gemini SDK and MediaKit; no OpenMontage or Whisper"
