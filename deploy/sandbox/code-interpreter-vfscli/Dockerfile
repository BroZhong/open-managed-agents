# Shanghai agent-platform Sandbox image. The ACS base supplies E2B-compatible
# runtime startup; preserve its ENTRYPOINT/CMD. Only tooling and local dependency
# defaults belong in this image. CSI attaches the persistent Workspace at runtime.
ARG BASE_IMAGE=registry-cn-shanghai-vpc.ack.aliyuncs.com/acs/code-interpreter:v1.6
FROM ${BASE_IMAGE}

ARG SANDBOX_USER=user

# Keep these defaults aligned with session-router/src/workspace-environment.ts.
# HOME, dependencies, caches and temporary files stay local and may be discarded
# when this Sandbox is rebuilt. Only the mounted WORKSPACE_DIR persists.
ENV HOME=/home/user \
    WORKSPACE_DIR=/home/user/workspace \
    STORY_SEED_WORKSPACE=/home/user/workspace \
    XDG_CACHE_HOME=/home/user/.cache \
    NPM_CONFIG_CACHE=/home/user/.cache/npm \
    NPM_CONFIG_PREFIX=/home/user/.local/npm \
    NODE_PATH=/home/user/.local/oma-node/node_modules \
    PIP_CACHE_DIR=/home/user/.cache/pip \
    PYTHONPATH=/home/user/.local/oma-python \
    TMPDIR=/tmp

# The base keeps Python in /opt/venv. Expose it to the E2B non-login PATH and
# prepare only local dependency directories. A future base that adds a Workspace
# directory must be reviewed; silently shipping a writable fallback is unsafe.
RUN ln -sf /opt/venv/bin/python  /usr/local/bin/python  && \
    ln -sf /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sf /opt/venv/bin/pip     /usr/local/bin/pip     && \
    ln -sf /opt/venv/bin/pip3    /usr/local/bin/pip3    && \
    test ! -e "${WORKSPACE_DIR}" && test ! -L "${WORKSPACE_DIR}" && \
    install -d -o "${SANDBOX_USER}" -g "${SANDBOX_USER}" \
      /home/user/.cache/npm /home/user/.cache/pip \
      /home/user/.local/npm /home/user/.local/oma-node \
      /home/user/.local/oma-python /home/user/.local/venvs

# Business scripts remain in equipped Skills under /skills/<skill-name>.
# The image contains a stable launcher, with no copied Skill implementation.
COPY story-seed-launcher /usr/local/bin/story-seed
RUN chmod +x /usr/local/bin/story-seed && /bin/sh -n /usr/local/bin/story-seed

# Stage the approved linux/amd64 binary before building; credentials are injected
# at runtime. Keep this frequently changed layer after the local setup layers.
COPY bin/vfs-cli /usr/local/bin/vfs-cli
RUN chmod +x /usr/local/bin/vfs-cli

# Validate tool availability and local HOME access. A build cannot prove a CSI
# mount: the Host verifies runtime identity, real fuse.ossfs and OSS readback.
RUN /usr/local/bin/vfs-cli version >/dev/null && \
    command -v story-seed >/dev/null && \
    command -v node >/dev/null && node --version >/dev/null && \
    command -v cmp >/dev/null && \
    /usr/local/bin/python3 --version >/dev/null && \
    su -s /bin/sh "${SANDBOX_USER}" -c 'test -w /home/user/.local/oma-node && test -w /home/user/.local/oma-python' && \
    test ! -e "${WORKSPACE_DIR}" && test ! -L "${WORKSPACE_DIR}"

# ENTRYPOINT/CMD intentionally inherited from the ACS base.
