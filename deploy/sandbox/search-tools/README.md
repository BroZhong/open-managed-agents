# Search tools overlay for existing sandbox templates

This adds only checksum-pinned rg 15.1.0 and fd 10.4.2 to a running template's
immutable image. Use it for the stock `code-interpreter` and an existing
`code-interpreter-vfscli` pool so a native-search update cannot regress their
preinstalled media/VFS dependencies or startup contract.

Build from the committed checkout on `vfs-dev` after obtaining the current
template digest from its ready Pod's `imageID`:

```bash
BASE_IMAGE=registry.example/current-sandbox@sha256:<current-digest> \
  TAG=code-interpreter-native-search-<release> \
  RG_SRC=/path/to/verified-linux-rg FD_SRC=/path/to/verified-linux-fd \
  PUSH=1 bash deploy/sandbox/search-tools/build.sh
```

Choose a distinct tag for each base. Preparation verifies the exact release
archives/binaries through `../prepare-search-binaries.py`; supplied `RG_SRC`
and `FD_SRC` avoid build-host downloads. Docker independently checks the binary
hashes. The build checks that base layers and runtime configuration survive,
then runs both CLIs with no network, as `user`, on a minimal PATH. The smoke
fixture exercises `.gitignore`, Unicode regex, brace globs and fd path globs.

Publish the resulting immutable image digest to the intended SandboxSet only
after those checks pass. This script does not change Kubernetes resources.
Existing Sessions retain their old sandboxes until lifecycle replacement.
