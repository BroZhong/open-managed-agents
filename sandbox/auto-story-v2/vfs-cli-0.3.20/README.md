# Sandbox 0.3.2 / vfs-cli 0.3.20

This overlay inherits the deployed 0.3.1 image by digest. It replaces only
vfs-cli and its version/hash records; Python packages, system packages,
media tools, models, entrypoint and proxy defaults remain inherited.

Build on vfs-dev from the repository checkout:

```sh
PUSH=1 bash sandbox/auto-story-v2/vfs-cli-0.3.20/build.sh
```

The archive is the same Linux amd64 release used by the public installer,
pinned to its published SHA-256. Build checks validate inherited runtime,
scene detection, libGL, Pillow, fonttools, pip mirror and Pi tools.

Apply `policy-configmap.yaml` before the SandboxSet. The immutable ConfigMap
is mounted as the read-only `/etc/vfs-cli` directory with mode 0444, exposing
`/etc/vfs-cli/policy.json` containing `{"environment":"test"}`. This restriction
is intentional even though the Sandbox pool is deployed in production.

For an existing production pool, patch only the image and policy volume/mount;
retain live replicas, resources, environment and other settings. Do not apply
the full historical manifest over live settings. Claimed Sandboxes retain their
previous image and mounts; no Runner restart is required.

Create an **ACS** ImageCache using `aliyun acc create-image-cache` for the exact
pinned image reference, the cluster network and existing registry credentials.
Wait for cache readiness before switching the pool. Keep the template annotation
`image.alibabacloud.com/enable-image-cache: 'true'`. Verify the actual cache ID
in new pods' `image.alibabacloud.com/matched-image-caches` annotation. ECI cache
resources are a separate service and must not be substituted for ACS caches.

Verification must check `vfs-cli --version`, policy contents, EROFS on write,
and an environment conflict returning exit 2 / `environment_policy_conflict`
even with `--force --yes`. Do not use real production IDs for conflict probes.
