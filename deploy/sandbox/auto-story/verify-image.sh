#!/usr/bin/env bash
# Offline image acceptance; real service/Agent tests are separate.
set -euo pipefail
image="${1:?Usage: verify-image.sh IMAGE}"

# Use the E2B account and the minimal non-login PATH. No secrets, host mounts,
# network, or login dotfiles can make a missing dependency appear to work.
docker run --rm --platform linux/amd64 --network none \
  --user user --workdir /home/user --entrypoint /usr/bin/env \
  "$image" -i HOME=/home/user PATH=/usr/local/bin:/usr/bin:/bin \
  AUTO_STORY_SMOKE_VALUE=injected \
  auto-story-smoke --require-env AUTO_STORY_SMOKE_VALUE
