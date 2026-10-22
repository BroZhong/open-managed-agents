# Sandbox 0.3.3 / vfs-cli 0.3.21

Incremental overlay on deployed 0.3.2. Build on vfs-dev from the repository:

```sh
PUSH=1 bash sandbox/auto-story-v2/vfs-cli-0.3.21/build.sh
```

Uses the published Linux amd64 archive, pinned by SHA-256. All parent layers,
startup settings and existing dependencies are retained. The existing immutable
`vfs-cli-policy-test-v1` ConfigMap and read-only `/etc/vfs-cli` mount remain in
the SandboxSet; its source remains `../vfs-cli-0.3.20/policy-configmap.yaml`.

Create an ACS cache for the exact new digest, wait for Ready, then use a guarded
image-only patch to the live pool. Retain live replicas and all other fields.
Verify new Pod cache matching, CLI version, read-only policy and environment
conflict rejection. Do not mutate claimed Sandboxes or restart the Runner.
