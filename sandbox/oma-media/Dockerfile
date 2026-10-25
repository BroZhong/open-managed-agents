# oma-media: oma-base plus source-built FFmpeg 9.0.1 (OpenH264, x264/x265,
# VP9, AV1, libass subtitles, ...), its runtime libraries and CJK fonts
# (ADR-0024). Video tools that change often (vfs-cli, MediaKit, ossutil,
# Python SDKs) belong to an Environment's init script, not here. Like
# oma-base, the image config adds no environment variable; ENTRYPOINT/CMD
# (tini in front of the ACS startup) are inherited.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS ffmpeg-build
USER root
ARG BUILD_JOBS=8
RUN apt-get update && \
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

FROM ${BASE_IMAGE}
USER root
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates libx264-164 libx265-199 libopenh264-7 libvpx7 libaom3 libmp3lame0 \
      libopus0 libvorbis0a libvorbisenc2 libass9 libfreetype6 libfontconfig1 \
      libfribidi0 libharfbuzz0b libwebp7 libwebpmux3 libgnutls30 zlib1g \
      fontconfig fonts-dejavu-core fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /out/ffmpeg /out/ffprobe /usr/local/bin/
COPY versions.json /tmp/oma-media-versions.json
COPY smoke.py /opt/oma/smoke/oma-media.py
ARG BASE_IMAGE
RUN chmod 0755 /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /opt/oma/smoke/oma-media.py && \
    /usr/bin/python3 -I -c 'import json, sys; v = json.load(open("/tmp/oma-media-versions.json")); json.dump({"name": "oma-media", "version": v["imageVersion"], "baseImage": sys.argv[1], "ffmpeg": v["ffmpeg"]["version"]}, open("/opt/oma/images/oma-media.json", "w"))' "${BASE_IMAGE}" && \
    rm /tmp/oma-media-versions.json && \
    test -z "$(find /home/user \( ! -user user -o ! -group user \) -print -quit)"
ARG IMAGE_VERSION
ARG BUILD_REVISION
LABEL org.opencontainers.image.title="oma-media" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      org.opencontainers.image.description="OMA Base Image: oma-base with FFmpeg 9.0.1 (OpenH264, libass), runtime libraries and CJK fonts" \
      dev.oma.base-image="oma-media"
