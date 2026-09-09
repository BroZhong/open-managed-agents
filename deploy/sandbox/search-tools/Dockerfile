# Preserve the running template's exact base, including startup and envd hooks.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Prepared and verified by ../prepare-search-binaries.py, then checked again
# inside the image. No package upgrades or runtime downloads are involved.
COPY bin/rg bin/fd /usr/local/bin/
RUN chmod 0755 /usr/local/bin/rg /usr/local/bin/fd && \
    printf '%s\n' \
      'ebeaf56f8a25e102e9419933423738b3a2a613a444fd749d695e15eba53f71f2  /usr/local/bin/rg' \
      '0dff4a420feb3e57fd1d4402d3e29f46115aa38d962467d2f3b72e7439d3ada8  /usr/local/bin/fd' | sha256sum --check - && \
    mkdir -p /opt/pi-search && \
    rg --version > /opt/pi-search/rg-version.txt && \
    fd --version > /opt/pi-search/fd-version.txt && \
    sha256sum /usr/local/bin/rg /usr/local/bin/fd > /opt/pi-search/tool-sha256.txt

# USER, ENTRYPOINT, CMD, WORKDIR, and ENV are inherited from the pinned base.
