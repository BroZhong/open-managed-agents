# Kiki sandbox overlay for open-managed-agents.
#
# The base is the production code-interpreter-vfscli image already used by the
# Hong Kong cluster. This overlay keeps that image's runtime contract intact,
# replaces only the independently versioned vfs-cli binary, and installs the
# enabled Agent-Skills snapshot as immutable, token-free files.
ARG BASE_IMAGE=crpi-egv1p3qc9sh5spft.cn-hongkong.personal.cr.aliyuncs.com/brozhong/oma-sandbox:code-interpreter-vfscli-0.4.1
FROM ${BASE_IMAGE}

ARG VFS_CLI_VERSION
ARG AGENT_SKILLS_COMMIT

LABEL org.opencontainers.image.title="Kiki open-managed-agents sandbox" \
      com.welltop.kiki.vfs-cli-version="${VFS_CLI_VERSION}" \
      com.welltop.kiki.agent-skills-commit="${AGENT_SKILLS_COMMIT}"

ENV OMA_AGENT_SKILLS_ROOT=/opt/agent-skills

COPY vfs-cli /usr/local/bin/vfs-cli
COPY agent-skills/ /opt/agent-skills/

RUN chmod 0755 /usr/local/bin/vfs-cli && \
    find /opt/agent-skills -type d -exec chmod 0755 {} + && \
    find /opt/agent-skills -type f -exec chmod 0444 {} + && \
    /usr/local/bin/vfs-cli version | grep -F "${VFS_CLI_VERSION}" >/dev/null && \
    test "$(find /opt/agent-skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)" -eq 12

# ENTRYPOINT and CMD remain inherited from the production sandbox base.
