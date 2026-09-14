#!/usr/bin/env bash
# Canonical release-image entry point for local use and the vfs-dev builder.
#
# The implementation lives under deploy/scripts so image construction and
# Kubernetes deployment remain separate operations. This wrapper intentionally
# forwards every argument unchanged; run `bash build.sh --help` for components,
# tags, dirty-tree protection, and push options.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${REPO_ROOT}/deploy/scripts/build-images.sh" "$@"
