# auto-story 0.2.0 verification

Built, tested and pushed on 2026-09-09, then deployed to the production
`auto-story` SandboxSet after approval. Packaging and live validation are
recorded separately below.

## Published image

```text
registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox:auto-story-0.2.0
```

- OCI index digest: `sha256:65482ebbc3a0f42bbd64a122a79126aa62643e93c7e4284136d42f42ce81dd98`
- Linux amd64 manifest: `sha256:b85d8c0ca1f58c34c349f0934024d8b37a0164444427cec5f09315e20524669a`
- Registry verification: `docker buildx imagetools inspect` resolved the published tag and both digests.
- `docker image ls` displayed **3.96 GB**, compared with **8.83 GB** for `auto-story-0.1.2` (about 55% smaller; this is Docker's displayed local size, not download size).

## Contents

| Component | Verified version |
| --- | --- |
| vfs-cli | 0.3.15, linux/amd64 |
| FFmpeg / ffprobe | 9.0.1 |
| google-genai | 2.22.0 |
| mediakit-cli | 0.2.1 |

All three downloaded source/binary archives passed SHA-256 verification.
FFmpeg's detached release signature also passed GPG verification against
fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8` in an isolated keyring.

The image derives directly from the pinned ACS base. OpenMontage and Whisper
binaries, source directories, installed distributions, and model directories
are absent. FFmpeg is explicitly configured with `--disable-whisper`.

## Acceptance

`verify-image.sh` passed all ten checks with `--network none`, the non-root
`user`, `HOME=/home/user`, and `PATH=/usr/local/bin:/usr/bin:/bin`:

1. Required environment variable injection (presence only, value not logged).
2. Exact executable versions and vfs-cli architecture.
3. Gemini Files/Interactions API shape in the isolated Python environment.
4. OpenMontage/Whisper exclusion and `story-seed` launcher availability.
5. Workspace write/read/cleanup.
6. FFmpeg H.264/AAC encoding and ffprobe stream/duration validation.
7. FFmpeg subtitle burn-in through libass.
8. MediaKit local trim.
9. MediaKit local concat, preserving the actual input durations.
10. MediaKit local subtitle rendering through OpenH264.

The inherited ACS entrypoint then started Jupyter successfully in a separate
container with no network; `/api/status` returned HTTP 200. Image entrypoint
and CMD were also compared with the base and matched exactly.

No Gemini, VFS or cloud MediaKit API calls were made during image acceptance.

## Production rollout and E2B validation

Verified on 2026-09-09 at approximately 17:55 Asia/Shanghai:

- Cluster: Shanghai `agent-platform`; namespace: `sandbox-system`.
- SandboxSet: `auto-story`, generation **4**, revision `7fb5559987`.
- Pinned the published OCI index digest above, replacing image digest
  `sha256:dd6437954752ff8527225bd2198245b89c75598a43c2e17d652d3d43279a4a72`
  (`auto-story-0.1.2`). Only the image field was changed in the live resource.
- The controller replaced the old warm sandbox. The updated pool reached
  **1/1 available and updated replicas**.

`verify-live.mjs` ran inside `oma-server` using its installed E2B SDK and
gateway `sandbox.agentry.welltop.tech`. It created sandbox
`sandbox-system--auto-story-nlpsm` with a five-minute maximum lifetime and
verified:

1. Sandbox creation through the gateway using the `auto-story` template.
2. Creation-time environment injection.
3. Filesystem write/read through the SDK.
4. Reconnection to the same sandbox and reading the existing file.
5. All ten image acceptance checks, executing as UID 1000 through E2B commands.
6. Reclaiming the test sandbox through the gateway.

All checks passed. The pool replenished a new ready sandbox after the test.
The deployment manifest is [sandboxset-auto-story.yaml](../sandboxset-auto-story.yaml).
This tests the real sandbox gateway and runtime; it does not make paid model
calls or run an Agent conversation.
