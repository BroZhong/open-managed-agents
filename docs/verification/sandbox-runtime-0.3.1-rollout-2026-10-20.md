# Sandbox 0.3.1 production rollout

Verified on 2026-10-20 (Asia/Shanghai). Production rollout and Runner restart
were explicitly authorized, including possible interruption of active Turns.

## Deployment

- Build source: `7714959c04e408bcf5ca8fdb29329f6fa68af659`.
- Manifest pin: `f354b4d`, branch `codex/sandbox-runtime-0.3.1`.
- Image tag: `auto-story-v2-0.3.1-20261020`.
- Image: `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:d0a845742fc6fd1b435a5066c5911ce52100e97678addecd04b17c49be8ee095`.
- Patched only the image in `sandbox-system/auto-story-v2`, with
  resourceVersion and previous-image JSON Patch tests. Kept live replicas at 8
  and preserved other live fields. Full application of the historical manifest
  would have changed unrelated live settings.
- Merged the six proxy defaults from `runtime-overlay/proxy.env` into
  `sandbox-system/base-secret`, preserving unrelated keys.
- Restarted `oma-infra/oma-runner`; rollout succeeded.
  New pod: `oma-runner-67c5578fc5-zrzwr`. Runner image unchanged.
- SandboxSet generation 18: 8 replicas, 8 updated and available,
  revision `68c6bfcbc8`.
- All 309 previously claimed Sandboxes remained present with unchanged UIDs
  and container images after verification.

## Real Session acceptance

Session: `sess_ZdLTeGN-cIHdYlYefwG0k`.
Agent: `agent_YFRfREaZIP9RU6-LnJ89w`, with no sandbox environment overrides.
Sandbox: `auto-story-v2-jkl44`, matching the deployed digest.

Executed through the Session's actual bash tool, without installing packages
or overriding proxy variables:

- Python smoke passed: SceneDetect 0.7.1, Pillow 11.3.0, fonttools 4.61.1,
  libGL loaded, PNG round-trip, font cmap read, scene cut detected.
- pip mirror: `https://mirrors.aliyun.com/pypi/simple/`.
- vfs-cli v0.3.19; NumPy 1.26.4 and OpenCV 4.11.0.86 retained.
- Pi 0.83.0 smoke passed with all seven tools.
- All four HTTP/HTTPS proxy environment variables matched shared defaults.
- Image version 0.3.1.
- Default urllib requests: agentry health HTTP 200 (0.085 s),
  creativefitting.cn HTTP 200 (0.111 s), Google HTTP 204 (0.760 s).
- Proxy egress check succeeded, public IP `192.204.58.87`.
- FFmpeg generated an 8-second video in the OSS-backed workspace.
- A second Session bash call downloaded the signed OSS file using default
  environment routing: 8,112,647 bytes in 0.172 s (44.87 MiB/s).
  SHA-256 matched the generated source; ffprobe confirmed 8-second duration.
  This is one local-region fixture measurement, not a speed guarantee for
  every video source.
- Both verification Turns completed successfully; Session returned to idle.

Correlated sing-box logs by test pod IP `172.26.95.208`:

| Destination | Actual route |
| --- | --- |
| agentry.welltop.tech | rule 0 domain_keyword, direct |
| creativefitting.cn | rule 0 domain_keyword, direct |
| www.google.com | vless proxy |
| api.ipify.org | vless proxy |
| agentry.oss-cn-shanghai.aliyuncs.com | rule 4 domain_suffix, direct |

## Observed restart impact

The two business Sessions inspected during rollout reported expired subagent
execution leases (`recovery_required`). Their Sandbox generation processes
survived and produced additional results. The first parent Session inspected
state and delegated continuation; the second still awaited its progress-check
command at the last inspection. This validates preservation of Sandbox
processes, but does not claim interruption-free preservation of active Turns.

Existing retained Sandboxes do not automatically acquire the new image or
creation-time environment. No old Sandbox was modified during this rollout.
