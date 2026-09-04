# Optional custom code-interpreter sandbox for agent-platform / cn-shanghai.
#
# FROM the ACS-provided code-interpreter base (Debian 12; already ships
# python3/pip/curl/node + the jupyter start-up script the e2b `agent-runtime`
# runtime hooks into). The `agent-runtime` injects the e2b `envd` daemon at run
# time, so as long as we keep the base's ENTRYPOINT/CMD untouched the E2B
# protocol keeps working. We layer on only what the stock image lacks:
#
#   - a writable workspace   — #85: mkdir'ing /workspace under root-owned / used
#                              to fail silently (e2b `exec` runs as the
#                              non-privileged `user`), so `echo x > cwd/f` and
#                              program writes failed. `/home/user` is now the
#                              single model-visible and persisted Workspace root.
#   - vfs-cli on PATH        — the Go static binary (linux/amd64), COPYd in
#                              rather than curl'd (the vfs-cli release CDN is
#                              slow/unreliable from CN build hosts). VFS_TOKEN is
#                              NOT baked in — it is a per-Agent secret injected
#                              at run time via sandbox.env.
#   - story-seed on PATH     — a stable launcher that resolves the business
#                              script from an equipped Skill projection and
#                              executes it with Node. The business script stays
#                              in the Skill; the image contains no forked copy.
#   - python on a plain PATH — the base keeps python in /opt/venv/bin, which is
#                              absent from e2b exec's non-login PATH, so bare
#                              `python`/`pip` come back "command not found".
#                              We symlink them into /usr/local/bin.
#
# Layer ordering is cache-first: the arg/env/apt/symlink layers change almost
# never and sit at the top; the vfs-cli binary (the thing that actually rev's
# between builds) is COPYd last, so bumping vfs-cli re-runs only the final two
# layers, not the whole image.
#
# Mirrored by deploy/scripts/build-base-images.sh so application builds depend
# only on the welltop Shanghai ACR rather than the platform-owned ACS registry.
ARG BASE_IMAGE=registry-vpc.cn-shanghai.aliyuncs.com/welltop/sandbox-base:code-interpreter-v1.6
FROM ${BASE_IMAGE}

# The non-privileged account e2b `exec` runs commands as. A build ARG (not
# hardcoded) so a future base that renames the account only needs `--build-arg`.
ARG SANDBOX_USER=user

# Canonical workspace: E2B's recommended user directory `/home/user`. It is the
# account's own home, is writable by construction, and is shared with
# SANDBOX_WORKSPACE_ROOT in the Host runtime.
ENV WORKSPACE_DIR=/home/user

# ── Rarely-changing layers first (best cache hit) ────────────────────────────

# Expose python/pip from the venv on a minimal, non-login exec PATH, and ensure
# the workspace exists and is owned by the account that exec runs as. This is
# belt-and-braces because `/home/user` already belongs to that account.
RUN ln -sf /opt/venv/bin/python  /usr/local/bin/python  && \
    ln -sf /opt/venv/bin/python3 /usr/local/bin/python3 && \
    ln -sf /opt/venv/bin/pip     /usr/local/bin/pip     && \
    ln -sf /opt/venv/bin/pip3    /usr/local/bin/pip3    && \
    mkdir -p "${WORKSPACE_DIR}" && \
    chown -R "${SANDBOX_USER}:${SANDBOX_USER}" "${WORKSPACE_DIR}" && \
    chmod 0775 "${WORKSPACE_DIR}"

# story-seed launcher — stable image infrastructure. It resolves the actual
# script from /skills/<fork-id>/scripts/story-seed at run time.
COPY story-seed-launcher /usr/local/bin/story-seed
RUN chmod +x /usr/local/bin/story-seed && /bin/sh -n /usr/local/bin/story-seed

# ── Frequently-changing layer last (vfs-cli binary) ──────────────────────────

# vfs-cli — pre-shipped so the sandbox has it with no runtime download. Place
# the binary under ./bin/ in the build context (see build.sh). COPYing it last
# means a vfs-cli bump only invalidates this layer + the sanity check.
COPY bin/vfs-cli /usr/local/bin/vfs-cli
RUN chmod +x /usr/local/bin/vfs-cli

# Build-time sanity check: the three things this image exists to provide must
# all resolve on a plain PATH, and the workspace must be user-writable.
RUN /usr/local/bin/vfs-cli version >/dev/null && \
    command -v story-seed >/dev/null && \
    command -v node >/dev/null && \
    node --version >/dev/null && \
    command -v cmp >/dev/null && \
    /usr/local/bin/python3 --version >/dev/null && \
    su -s /bin/sh "${SANDBOX_USER}" -c "touch ${WORKSPACE_DIR}/.write-probe && rm ${WORKSPACE_DIR}/.write-probe"

# ENTRYPOINT/CMD are inherited unchanged from the base (the jupyter start-up
# script the e2b agent-runtime expects). Do NOT set them here.
