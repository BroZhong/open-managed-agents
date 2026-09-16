# 使用 Docker BuildKit 内置 frontend，避免构建时额外访问 Docker Hub。
# auto-story-v2 — 新增组件（基础镜像已有 Node/Python/Jupyter，不重复安装）
#   FFmpeg / ffprobe 9.0.1   音视频处理，源码编译
#   google-genai    2.22.0  Gemini SDK，独立 Python venv
#   ripgrep (rg)    15.1.0  原生文本搜索
#   fd              10.4.2  原生文件搜索
#   mediakit-cli    0.2.1   火山媒体处理
#   vfs-cli         0.3.16  VFS API（包含上游任务错误详情）
# 归档/二进制校验：versions.json、../prepare-search-binaries.py。
# Debian 库和字体随 APT 仓库解析，不锁补丁版本；实际版本记录于 debian-packages.txt。
# 缓存顺序：低频基础层 → 独立 FFmpeg/Python 构建 → 搜索工具 → MediaKit → VFS → 验收。
# 保留 ACS Jupyter ENTRYPOINT/CMD；Workspace 由 CSI 挂载，禁止预建。
ARG BASE_IMAGE=registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter@sha256:b53bc461e59fda3bff45bb3682d1b56f071e772989d3579cd1773165b4e761fb
FROM ${BASE_IMAGE} AS base
USER root
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources && \
    rm -f /etc/apt/apt.conf.d/docker-clean

# 1. 低频：FFmpeg 9.0.1 编译依赖与源码；CLI 更新不影响此阶段。
FROM base AS ffmpeg-build
ARG BUILD_JOBS=6
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential nasm pkg-config xz-utils ca-certificates \
      libx264-dev libx265-dev libopenh264-dev libvpx-dev libaom-dev libmp3lame-dev \
      libopus-dev libvorbis-dev libass-dev libfreetype6-dev libfontconfig1-dev \
      libfribidi-dev libharfbuzz-dev libwebp-dev libgnutls28-dev zlib1g-dev
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

# 2. 中低频：google-genai 2.22.0；只随 requirements/安装脚本变化重建。
FROM base AS python-build
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
COPY requirements.txt install-python.sh /opt/auto-story/
RUN --mount=type=cache,target=/root/.cache/pip \
    sh /opt/auto-story/install-python.sh

# 3. 低频：运行库、中文字体与用户目录。
FROM base AS runtime
ENV HOME=/home/user \
    WORKSPACE_DIR=/home/user/workspace \
    MEDIAKIT_OUTPUT_PATH=/home/user/workspace/media \
    XDG_CACHE_HOME=/home/user/.cache \
    NPM_CONFIG_CACHE=/home/user/.cache/npm \
    NPM_CONFIG_PREFIX=/home/user/.local/npm \
    NODE_PATH=/home/user/.local/oma-node/node_modules \
    PIP_CACHE_DIR=/home/user/.cache/pip \
    PYTHONPATH=/home/user/.local/oma-python \
    TMPDIR=/tmp \
    MEDIAKIT_SURFACE=skill \
    MEDIAKIT_RUNTIME=pi-agent \
    PATH=/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
# 编解码/字幕/字体运行库；编译器与头文件仅存在于 ffmpeg-build。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates libx264-164 libx265-199 libopenh264-7 libvpx7 libaom3 libmp3lame0 \
      libopus0 libvorbis0a libvorbisenc2 libass9 libfreetype6 libfontconfig1 \
      libfribidi0 libharfbuzz0b libwebp7 libwebpmux3 libgnutls30 zlib1g \
      fontconfig fonts-dejavu-core fonts-noto-cjk && \
    mkdir -p /opt/auto-story && \
    test ! -e "$WORKSPACE_DIR" && test ! -L "$WORKSPACE_DIR" && \
    install -d -o user -g user /home/user/.cache/npm /home/user/.cache/pip \
      /home/user/.local/npm /home/user/.local/oma-node \
      /home/user/.local/oma-python /home/user/.local/venvs
COPY --from=python-build /opt/auto-story/ /opt/auto-story/
COPY --from=python-build /out/bin/ /usr/local/bin/
COPY --from=ffmpeg-build /out/ffmpeg /out/ffprobe /usr/local/bin/
# 4. 按预期变更频率从低到高组装；各工具独立 COPY，避免互相覆盖缓存。
COPY --chmod=0755 bin/rg bin/fd /usr/local/bin/
COPY --chmod=0755 bin/mediakit-cli /usr/local/bin/
COPY --chmod=0755 bin/vfs-cli /usr/local/bin/

# 5. 高频：完整版本清单、校验与验收必须放在昂贵依赖层之后。
COPY versions.json /opt/auto-story/
COPY bin/SHA256SUMS /opt/auto-story/tool-sha256.txt
RUN cd /usr/local/bin && sha256sum --check /opt/auto-story/tool-sha256.txt && \
    dpkg-query -W > /opt/auto-story/debian-packages.txt

COPY --chmod=0755 smoke.py /usr/local/bin/auto-story-smoke
RUN su -s /bin/sh user -c 'cd /home/user && env -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin auto-story-smoke'
ARG IMAGE_VERSION
LABEL org.opencontainers.image.title="auto-story-v2" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.description="E2B media sandbox with vfs-cli, FFmpeg, Gemini SDK and MediaKit; no OpenMontage or Whisper"
