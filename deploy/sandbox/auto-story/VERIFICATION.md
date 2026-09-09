# auto-story 0.2.1 verification

Built, tested and published on 2026-09-09 for Shanghai `agent-platform`.
This release adds the pinned native Pi search tools to the clean 0.2.0 image
recipe and retains access to the clean ACS scientific packages. Historical
0.1.x acceptance is preserved in [VERIFICATION-0.1.2.md](./VERIFICATION-0.1.2.md).

## Published image

```text
registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.2.1
```

- OCI index digest: `sha256:16112ce4b3b8ccb2b8e42c4c5c6ad8bf0d71363ee5d54338fee601a178effbec`
- Linux amd64 manifest: `sha256:50b647c0f6ea9a431710ebe9b3cf97b4ee978ddffd1f69ff6e83cdeb0b7a7c2e`
- The additional unknown/unknown manifest is the build provenance attestation.
- `docker buildx imagetools inspect` confirmed the published tag and digests.
- Docker displayed **3.97 GB** local disk usage and **942 MB** content size,
  compared with **8.83 GB** local disk usage for `auto-story-0.1.2`.

## Contents

| Component | Verified version |
| --- | --- |
| vfs-cli | 0.3.15, linux/amd64 |
| FFmpeg / ffprobe | 9.0.1 |
| google-genai | 2.22.0 |
| mediakit-cli | 0.2.1 |
| ripgrep / fd | 15.1.0 / 10.4.2 |
| Retained ACS numpy / pandas | 1.26.4 / 2.2.3 |

Official source archives and CLI binaries passed their pinned SHA-256 checks.
FFmpeg's detached release signature also passed GPG verification against
fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` in an isolated keyring.

The image derives directly from the digest-pinned clean ACS base. OpenMontage
and Whisper binaries, source directories and installed distributions are
absent; their model weights are not downloaded. FFmpeg is configured with
`--disable-whisper`. The obsolete story-seed launcher is no longer bundled.

## Image acceptance

`verify-image.sh` passed all **13 checks** with `--network none`, UID 1000,
`HOME=/home/user`, and `PATH=/usr/local/bin:/usr/bin:/bin`:

1. Creation environment marker presence without logging its value.
2. Exact executable versions and vfs-cli architecture.
3. Gemini Files/Interactions SDK availability without network calls.
4. `python3 -I` selects the Gemini venv and can import the original ACS numpy/pandas.
5. OpenMontage/Whisper exclusion across the SDK, base and system environments.
6. Workspace write/read and temporary-file cleanup.
7. rg Unicode regex, brace globs and `.gitignore`; fd recursive and path globs.
8. Embedded VFS Skills, SeedAudio schema, generation dry-run, and audio Resource URL/file dry-runs.
9. FFmpeg H.264/AAC encoding and ffprobe stream/duration validation.
10. FFmpeg subtitle burn-in through libass.
11. MediaKit local trim.
12. MediaKit local concat preserving actual input durations.
13. MediaKit local subtitle rendering through OpenH264.

The inherited ACS entrypoint started Jupyter successfully in a separate
container with no network; `/api/status` returned HTTP 200. Entrypoint and CMD
were compared with the base and matched exactly. Push ran only after these
checks passed. No model generation or authenticated cloud media call was made.

## Repository checks

- Sandbox: 108 tests, including default selection and explicit Agent override.
- Adapter: 297 tests, including native-search parity and sandbox boundary checks.
- Server CI path: 564 tests; 3 existing opt-in integration cases skipped.
- Relevant TypeScript checks and OpenAPI artifact verification passed.
- Deployment contracts: 9 passed, 1 optional package-overlay case skipped.
- Both sandbox build entrypoints passed dry-run checks; 11 isolated deployment
  checks verified pool selection, image overrides and cluster/apply gates.
- GitHub PR CI passed contract, server, adapter-and-deploy and web checks.

## Production default rollout and E2B validation

Verified on 2026-09-09 at approximately 18:21 Asia/Shanghai:

- Cluster: Shanghai `agent-platform`; sandbox namespace: `sandbox-system`.
- SandboxSet `auto-story`: generation **5**, revision `6996f47d7b`.
- Patched only its image from the 0.2.0 digest
  `sha256:65482ebbc3a0f42bbd64a122a79126aa62643e93c7e4284136d42f42ce81dd98`
  to the published 0.2.1 digest above; the pool reached **1/1 available and updated replicas**.
- Patched only `oma-server-config.data.SANDBOX_TEMPLATE` from
  `code-interpreter-vfscli` to **`auto-story`**, then restarted `oma-server`.
  The Deployment returned to **1/1 ready and updated replicas** with the same
  application image; the new process confirmed `SANDBOX_TEMPLATE=auto-story`.
- The Server's existing Agent allowlist and scoped credential configuration
  were preserved. Agents with explicit templates keep their selections;
  existing Session sandboxes pick up the image only when rebuilt.

`verify-live.mjs` ran inside the restarted Server against
`sandbox.agentry.welltop.tech`. It imported the deployed `E2BSandboxClient`,
configured it exactly as the Host does, and called `create` **without an image
or template override**. Sandbox `sandbox-system--auto-story-gs5lw` was allocated
from the auto-story pool with a five-minute maximum lifetime.

All six gateway checks passed: global-default creation, creation-time
environment injection, client file write/read, SDK reconnection, all **13 image
acceptance checks** through E2B commands as UID 1000, and test-sandbox reclamation.
The pool replenished and returned to **1/1 available and updated replicas**.

This validates the real default sandbox creation and runtime, including rg/fd
search and media operations. It does not run an Agent conversation or submit
paid model generation. The canonical image and pool settings are in
[sandboxset-auto-story.yaml](../sandboxset-auto-story.yaml).
