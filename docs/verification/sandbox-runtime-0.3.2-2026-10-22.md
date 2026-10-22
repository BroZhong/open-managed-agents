# Sandbox 0.3.2 rollout / 2026-10-22

Production update explicitly requested by the user. Target: Shanghai
agent-platform, sandbox-system/auto-story-v2. Existing Session Sandboxes retained.

## Artifacts

- Build source: `0f9ab83d` on `codex/sandbox-runtime-0.3.1`.
- Builder: `vfs-dev:~/workspace/yuzhong/oma-sandbox-runtime-0.3.1`.
- Command: `PUSH=1 bash sandbox/auto-story-v2/vfs-cli-0.3.20/build.sh`.
- Tag: `auto-story-v2-0.3.2-20261022`.
- Digest: `sha256:f95eebfa2adb297747d4ccb17d1c151ddf73e82549b76abecdc703ce39843309`.
- Parent: deployed 0.3.1, digest `d0a845742fc6fd1b435a5066c5911ce52100e97678addecd04b17c49be8ee095`.
- Release archive SHA-256: `a9192a9f784642c8189027ca5662636cab03988973e8656ee2aaf69d9d8dfafd`.
- ACS cache: `imc-uf6gkz5kw63q6bdw0o2l`, name
  `oma-sandbox-032-vfs0320-20261022`, Ready before pool update.

Cache created via ACS `acc create-image-cache` with the exact deployed digest.
An initially created ECI cache (`imc-uf63rnucq41sz848olnm`) was removed before
rollout; it is not the cache used by ACS Sandbox Pods.

## Scope and verification

Guarded JSON Patch changed only the image and added the policy volume/mount.
Live replicas (8), resources, environment references, startup and proxy settings
were preserved. No Runner restart or old Sandbox patch was performed.

Immutable ConfigMap `vfs-cli-policy-test-v1`, mode 0444, is mounted as read-only
`/etc/vfs-cli`, exposing `policy.json` containing `{"environment":"test"}`.

Build verification passed: inherited runtime inventory (185 Python package
versions, 288 Debian package versions, 24 asset hashes), overlay smoke
(SceneDetect, libGL, Pillow, fonttools, Aliyun pip mirror), and seven Pi tools.
The full 0.3.1 parent layer prefix and startup configuration including all
inherited environment variables were compared and unchanged.

Live verification on `auto-story-v2-2vxs7`:

- vfs-cli version v0.3.20; imageVersion 0.3.2.
- Exact policy JSON read successfully.
- `os.open(policy, O_WRONLY)` rejected with errno 30 / EROFS; no write performed.
- `RUNTIME_ENV=PRO vfs-cli project query --teamwork-id verification-only
  --force --yes` with a dummy token rejected before networking with exit 2,
  subtype `environment_policy_conflict`.
- Pod cache annotation identifies `imc-uf6gkz5kw63q6bdw0o2l`, size 5 GiB.

The pre-rollout snapshot contained 461 claimed Sandboxes. At the subsequent
check, 458 retained the same UID and image; three were no longer present.
This rollout did not issue any deletion or mutation of those claimed Sandboxes.

ACS matching semantics reference:
https://www.alibabacloud.com/help/en/cs/user-guide/accelerate-acs-pod-startup-using-image-caching

Final pool verification: generation 19, revision `77df8bcff7`, all 8 replicas
updated and available. All eight new Pods reported the new ACS cache ID.
