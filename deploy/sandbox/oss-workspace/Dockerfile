# Apply the mounted Workspace contract to an already verified runtime digest.
# Build context: deploy/sandbox/code-interpreter-vfscli. BASE_IMAGE must be an
# immutable approved image so each template retains its installed media tools.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
ENV HOME=/home/user \
    WORKSPACE_DIR=/home/user/workspace \
    STORY_SEED_WORKSPACE=/home/user/workspace \
    MEDIAKIT_OUTPUT_PATH=/home/user/workspace/media \
    XDG_CACHE_HOME=/home/user/.cache \
    NPM_CONFIG_CACHE=/home/user/.cache/npm \
    NPM_CONFIG_PREFIX=/home/user/.local/npm \
    NODE_PATH=/home/user/.local/oma-node/node_modules \
    PIP_CACHE_DIR=/home/user/.cache/pip \
    PYTHONPATH=/home/user/.local/oma-python \
    TMPDIR=/tmp
COPY story-seed-launcher /usr/local/bin/story-seed
RUN test ! -e "$WORKSPACE_DIR" && test ! -L "$WORKSPACE_DIR" && \
    install -d -o user -g user \
      /home/user/.cache/npm /home/user/.cache/pip \
      /home/user/.local/npm /home/user/.local/oma-node \
      /home/user/.local/oma-python /home/user/.local/venvs && \
    chmod 0755 /usr/local/bin/story-seed && \
    sh -n /usr/local/bin/story-seed && \
    command -v node && command -v python3 && command -v rg && command -v fd && \
    su -s /bin/sh user -c 'test -w "$HOME/.local/oma-node" && test -w "$HOME/.local/oma-python"'
# ENTRYPOINT and CMD are inherited; CSI supplies the Workspace at runtime.
