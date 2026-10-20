# Production-preserving 0.3.1 overlay

Use this recipe for the October 20 runtime update, **not** the sibling clean
ACS recipe. The exact production parent is pinned in Dockerfile and release.json
(`6f5eedfc…591eb8`, auto-story 0.3.0 with vfs-cli 0.3.18). It retains offline
Whisper and model weights, Node 22 / Pi 0.83, FFmpeg, MediaKit, Gemini, ACS
Jupyter / E2B startup, languages, fonts, search utilities and Python wrappers.

Changes: libgl1; SceneDetect 0.7.1; Pillow >=10.4,<13 and fonttools >=4.50,<5;
vfs-cli 0.3.19; system-wide Aliyun pip source; HTTP(S) proxy defaults for the
existing sing-box service. All inherited Python package versions are constrained,
including NumPy 1.26.4 and OpenCV 4.11.0.86. No headless OpenCV is added over the
existing cv2 distribution. Existing package versions and retained asset hashes
must remain identical; inherited acceptance includes actual offline Whisper
inference. Additional checks exercise scene detection, image/font processing,
minimal-PATH Python and pip configuration. All seven native Pi tools and Jupyter
startup are checked too.

Build on vfs-dev from a checkout containing this recipe:

```sh
bash sandbox/auto-story-v2/runtime-overlay/build.sh
# Optional publishing, still no runtime rollout:
PUSH=1 bash sandbox/auto-story-v2/runtime-overlay/build.sh
```

The verified vfs-cli archive may be copied into this directory in advance.
Output metadata and logs are gitignored. The build does not apply manifests,
restart Runner or touch existing Sandboxes. The production SandboxSet must be
updated separately with a verified immutable registry digest; its warm pool
must supply the new revision before claiming new Sessions use it.

## Proxy deployment boundary

The image includes non-secret proxy defaults in Docker ENV and
`/etc/oma/proxy.env`. This is **not evidence** that E2B commands inherit them:
minimal command environments need the same values injected at Sandbox creation.
That rollout/injection work and a real new Session test remain separate from
image construction. Do not patch envd, replace shell/Python wrappers, or modify
shared Runner settings merely to make an image-only test appear successful.

The service at `sing-box.oma-infra.svc.cluster.local:7890` retains business domain
keyword direct rules for welltop.tech and creativefitting.cn and the existing
routing policy. NO_PROXY bypasses loopback and cluster suffixes. Proxy hostnames
are cluster-specific; tools outside that cluster need their own overrides.
No credentials or business files are baked into this image.
