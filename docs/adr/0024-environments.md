# ADR-0024: Environments are built once into images and run from one shared warm pool

## Status

Accepted 2026-10-26 (#300) for #298. The design was settled with the
maintainer on 2026-10-25 (two grilling sessions; every choice that depended on
ACS Commit or checkpoint cloning was withdrawn in the second). The buildah
spike (#299) answered every question left open until it; its results are
recorded under "Spike results (#299)" below and in the
[report](../verification/environment-image-build-spike-2026-10-25.md).

Revises ADR-0014's Pi tool runtime placement and release order, ADR-0008's
per-Agent template overrides, ADR-0023's Session `environment` field and the
Host's Sandbox env layering, as listed under "Superseded and revised
decisions".

## Context

Every Sandbox runs one image, `auto-story-v2`, the sole maintained template. Its
recipe (`sandbox/auto-story-v2/`) is built by hand on an amd64 builder and mixes
three things: what the platform needs (Node 22 and the exact Pi tool runtime,
rg/fd), what video production needs (source-built FFmpeg 9.0.1 with libopenh264
and libass, CJK fonts, MediaKit, vfs-cli, ossutil, google-genai), and every
platform secret, which the SandboxSet injects from `base-secret` into the pod
spec. A Tenant cannot add a dependency except by installing it during a Turn.
The Agent field `sandbox.image` exists, but no production Agent sets it and the
image cannot be built by anyone but the platform.

Other managed-agent platforms let users describe an environment (base image,
setup script, variables); see the
[research](../research/cloud-agent-sandbox-customization.md). Volcengine Ark
runs the setup script at every Sandbox start; we rejected that because the
video dependencies alone take minutes to install.

Measured on the agent-platform cluster on 2026-10-25:

- Checkpoint cloning costs about a cold start (26–29 s), shares one envd token
  across clones and ignores create `envs`
  ([snapshot bench](../verification/environment-snapshot-bench-2026-10-25.md)).
  ACS Commit works but snapshots a running rootfs
  ([Commit bench](../verification/environment-commit-bench-2026-10-25.md)).
  Both were withdrawn.
- The gateway (`ack-sandbox-manager` v0.6.11) can claim a warm Sandbox and swap
  its main container to another image in place
  (`e2b.agents.kruise.io/image`): the pod, sidecars and CSI mounts stay, each
  claim gets its own envd token, and only layers missing from the pod are
  pulled. The swap costs about 1.5 s + container stop + 2 s + pull + 1–2 s. The
  current entrypoint ignores SIGTERM, so every swap waits out the 30 s grace
  period (35–54 s); with a 2 s grace it took 6.5–27 s. A warm claim takes about
  0.34 s and a cold start about 25 s.
- envd runs every command as `/bin/bash -l -c`. A command sees only the create
  `envs`, the command's own env and what `/etc/profile(.d)` sets; Dockerfile
  `ENV` and pod-spec env are visible to PID 1 only. Create `envs` are stored in
  plaintext in the Sandbox CR annotation `agents.kruise.io/init-runtime-request`
  ([envd token exposure](../verification/envd-token-exposure-2026-10-25.md)).
- ACS rejects privileged pods and `SYS_ADMIN`; `/dev/fuse` is available only as
  an explicit hostPath; the kernel is 5.10. Alibaba documents unprivileged
  image builds with buildah on ACS
  ([doc](https://help.aliyun.com/zh/cs/user-guide/run-a-mirror-build-task-with-an-acs-instance)).
  BuildKit rootless needs kernel ≥ 5.11 or fuse; Google's kaniko is archived;
  the ACR Personal build service cannot build a Dockerfile submitted by API.
- ACS pods reach `registry-vpc.cn-shanghai` and the Aliyun mirrors directly;
  GitHub release downloads fail direct (90 s timeouts) and take about 2.5 s
  through the cluster's sing-box proxy. ACR is Personal Edition with the single
  namespace `welltop` (207 of 300 repositories used, no SLA, no tag-delete API).
- The per-Agent injections `AUTO_STORY_*` and `OPENGROVE_WW_*` are dead: the
  allowlisted Agent IDs exist in neither schema, and `OPENGROVE_WW_*` is not
  configured in either deployment.

## Decision

### The resource

- An **Environment** is a platform **Base Image**, an init script and
  environment variables, built once into an image. Fields: `id` (`env_…`),
  `name` (unique per Tenant), `description`, `baseImage` (`oma-base` or
  `oma-media`), `env`, `initScript`, `status`, `image` (the digest that serves
  Sandboxes), the last build and its manifest.
- `status` is `pending`, `building`, `failed` or `ready`. Only a `ready`
  Environment may be bound to an Agent or passed at Session creation; otherwise
  the API answers 409 `environment_not_ready`.
- Agents and Sessions reference the Environment by ID. Changing `initScript` or
  `baseImage` starts a rebuild; while it runs, Sandboxes keep using the current
  `image`; success replaces `image`, failure leaves it and records the error.
  Changing `env`, `name` or `description` takes effect at once and never builds.
  An Environment has one active build; a newer change supersedes it.
- Built-in Environments are defined in the repository
  (`sandbox/environments/<name>/{environment.json,init.sh}`) with a fixed ID
  and `ownerType` `platform`. They differ from Tenant Environments only in
  permissions: every Tenant sees them, none may change them (403), any may copy
  one into its own. Their "built-in" label is derived from `ownerType`; there
  is no tag system. The image builder upserts them at startup and rebuilds one
  whose definition hash changed.
- `video-production` (`env_video_production`) replaces `auto-story-v2`: base
  `oma-media`; a script that installs `libgl1`, vfs-cli v0.3.21, mediakit-cli
  0.2.1 and ossutil with pinned checksums, `google-genai`, `scenedetect`,
  `Pillow` and `fonttools` constrained by the packages already present, and the
  read-only vfs-cli policy `/etc/vfs-cli/policy.json` that the pool mounted
  from a ConfigMap; the sing-box proxy (`HTTP(S)_PROXY`, with `NO_PROXY`
  covering Aliyun and cluster addresses) as platform defaults; and the platform
  secrets that `base-secret` provides today, declared one to one. The live
  image's recipe is the reference (branch `codex/sandbox-runtime-0.3.1`, image
  0.3.3), not the older recipe on main. It is the default for a new Sandboxed
  Agent that names no Environment.
- Deleting an Environment that an Agent references answers 409
  `environment_in_use`. Otherwise it is soft-deleted: hidden from lists, image
  kept, Sessions frozen to it keep running.
- API: `/v1/environments` list, get, create, `POST /{id}` update, delete;
  `POST /{id}/build` rebuilds; the last build's log is readable. Agents gain
  `environmentId`; `POST /v1/sessions` accepts `environmentId` (also
  `environment_id`). CLI: `oma-cli environment list|get|create|update|delete|rebuild|logs`
  (`--init-script @file`, `--env K=V`, `--env-file`, `--from`) and
  `oma-cli agent update --environment`. Console: Resources → Environment.
- There is no limit on the number of Environments or concurrent builds.

### Base Images

- `oma-base`: the pinned ACS `code-interpreter` image, apt/pip/npm pointed at
  Aliyun mirrors, the `/home/user` layout, Node 22, the exact Pi tool runtime and
  rg/fd, and `tini -g --` as entrypoint in front of the original command, so the
  main process exits on SIGTERM. Its `/home/user` is owned by `user` and holds
  no caches, and its image config sets no proxy variables (they would override
  the build's and every Environment's).
- `oma-media`: `oma-base` plus the source-built FFmpeg, its runtime libraries and
  CJK fonts. Video tools that change often stay in the Environment's script.
- The platform builds both by hand from `sandbox/` recipes, as today. The image
  builder's configuration pins their digests. A new digest (for example a Pi
  upgrade, which must match the Host's Pi version exactly) rebuilds every
  Environment on that Base Image. Release order: Base Images, then the image
  builder (wait until rebuilt Environments are ready), then the Runner.

### Building

- `oma-image-builder` is a third role of the server image, deployed as its own
  single-replica Deployment per deployment environment. The API writes an
  `environment_builds` row in the transaction that changes the Environment;
  the builder claims rows with a lease (ADR-0018: PG owns accepted work, the API
  executes nothing). Only the builder holds registry push credentials and the
  Kubernetes rights to run build pods and update the warm pool.
- Each build is one ACS pod (general-purpose, 4 vCPU / 8 GiB, 60 GiB ephemeral,
  unprivileged) running buildah pinned by digest and mirrored into `welltop`.
  Storage is native overlay without `mount_program` on an emptyDir, with chroot
  isolation: vfs fills the disk with this base and fuse-overlayfs needs
  `/dev/fuse`. The push credential is a mounted auth file. The builder generates
  the Dockerfile; users never write one:

  ```dockerfile
  FROM <base image>@sha256:…
  RUN --mount=type=bind,source=init.sh,target=/tmp/oma-init.sh \
      --mount=type=bind,source=build.env,target=/tmp/oma-build.env \
      cd /home/user && set -a && . /tmp/oma-build.env && set +a && \
      bash -euo pipefail /tmp/oma-init.sh
  RUN /opt/oma/bin/write-manifest > /opt/oma/manifest.json \
      && find /home/user \( ! -user user -o ! -group user \) -exec chown -h user:user {} + \
      && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
  LABEL dev.oma.environment=<id> dev.oma.build=<buildId>
  ```

  Environment variables reach the script through the bind-mounted `build.env`,
  never `ARG` or `ENV`, which would land in the image history or config. The
  manifest is written before ownership is fixed, so nothing it writes stays
  root-owned, and only files not already owned by `user` are changed, so
  `/home/user` is not copied into the new layer.

- The script runs as root in `/home/user`, cannot reach any Workspace, sees the
  Environment's plain and platform-default variables (not its secrets), and
  fails fast. The builder sets `HTTP(S)_PROXY` to the cluster's sing-box and an
  explicit `NO_PROXY` for Aliyun mirrors and cluster addresses: from ACS,
  GitHub downloads fail direct (90 s timeouts) and take about 2.5 s through
  the proxy. These build-time values are not kept in the image. A variable a Sandbox command should inherit is written to
  `/etc/profile.d/*.sh` as `export FOO="${FOO:-value}"`, because the login shell
  reads profile scripts after the injected env.
- The image is pushed (a single OCI manifest) to
  `welltop/oma-environments:<deployment>-<envId>-<buildId>` and referenced by
  digest. The builder then claims one Sandbox with the new
  image, checks envd, bash, ownership of `/home/user` and reads the manifest
  (dpkg, pip, npm and binary versions shown in the console), and only then marks
  the Environment `ready`. A build times out after 60 minutes. A script failure
  is not retried; an infrastructure failure is retried twice. The log tail
  (1 MiB) is kept in OSS at `__oma/environment-builds/<tenantId>/<buildId>.log`.
- Old images are not deleted.

### Starting a Sandbox

- Each deployment environment has one warm pool SandboxSet (`oma-sandbox`,
  8 replicas; `oma-test-sandbox`, 1 replica). Its pod template is the current
  `auto-story-v2` template without the `base-secret` env and `source.env`
  mount; its image is the image of `video-production`. When that Environment
  becomes ready, the builder creates an ACS ImageCache for the new image, waits
  until it is ready, and only then patches the pool's image: without a matching
  cache every refill pulls the whole image (1.9 GB, 73–81 s in #299).
- The Host creates every Sandbox from the pool and always passes the
  Environment's image digest as `e2b.agents.kruise.io/image`. A matching image is
  a plain claim; any other is swapped in place, pulling only the layers above
  the shared Base Image. `resolveTemplate` no longer reads the Agent.
- A Session freezes its Environment ID at creation: the override, otherwise its
  Agent's. Child Sessions use their parent's; a Loop uses its Agent's at
  trigger time. A Sandbox keeps the image it was created with until it is
  reclaimed or rebuilt; the Sandbox Binding records the Environment and image.
- Environment variables are injected into every command by the Sandbox
  Manager's `exec`, not at creation: a change applies from the next command,
  and no secret is written into a Sandbox CR. They are not part of the tool
  protocol or the model's context. Order, lowest first: platform defaults, the
  Environment's variables, the Workspace variables; system-reserved names are
  rejected when the Environment is saved.
- `span.sandbox_prepare_*` carries the Environment ID, image digest, whether the
  claim swapped, and its duration.
- `GET /v1/sessions/{id}` renames ADR-0023's `environment: {state, since,
  last_error}` to `sandbox`, and `environment` becomes `{id, name}` of the
  Session's Environment. The Redis control signal kind `environment` becomes
  `sandbox`. No alias is kept; the console changes with the API. The term
  "Environment failure" becomes **Sandbox unavailability** (`details.code`
  `sandbox_unavailable` is unchanged).

### Environment variables

- Kinds: system-reserved (rejected), platform default (overridable, for example
  `PIP_INDEX_URL`, `NPM_CONFIG_REGISTRY`), plain, and secret. Plain values must
  not be empty; all values together are at most 32 KiB.
- A secret is `{name, secretRef: {source: "platform" | "environment", key}}`
  (`vault` is reserved). Platform secrets are only obtained by copying a
  built-in Environment. Tenant secrets are encrypted like Model Provider API
  keys, write-only, and never returned; the console shows the name only.

### Migration

- Agents lose `sandbox.image` and `sandbox.env`; `sandbox.enabled` stays. Every
  Sandboxed Agent is bound to `video-production`; an Agent that set
  `sandbox.env` gets a Tenant copy of `video-production` with those variables.
  Existing Sessions are frozen to `video-production`.
- The `AUTO_STORY_*` and `OPENGROVE_WW_*` injections, the `oma-auto-story-env`
  Secret and their code are deleted. `SANDBOX_TEMPLATE` becomes the pool name.
- `auto-story-v2` keeps serving production until the production release;
  oma-test moves first.

## Considered options

- **Run the script at each Sandbox start** (Volcengine Ark): minutes per start
  for video dependencies.
- **Checkpoint clone / ACS Commit**: cold-start cost, shared envd token, runtime
  rootfs pollution; withdrawn.
- **One SandboxSet per Environment**: a dedicated pool per Environment, or a
  25 s cold start plus a full image pull for custom ones, and N SandboxSets for
  the builder to manage. The shared pool needs only one, and the most used
  Environment never swaps.
- **Pi tool runtime as a versioned bundle installed at Sandbox preparation**:
  would spare rebuilding Environments on a Pi upgrade, at the cost of a second
  install mechanism. Rejected; a Pi upgrade rebuilds Environments instead.
- **Create-time env injection**: no code change, but changes reach only new
  Sandboxes and secrets stay in plaintext in the Sandbox CR.
- **A new ACR namespace**: rejected by the maintainer; images live under
  `welltop`.

## Consequences and accepted risks

- A build pod runs the user's script as root while holding the push credential
  `ali-shanghai`, which can write every repository in `welltop`; a malicious
  script could take it. The build pod also sits on the general-purpose vSwitch.
  Accepted for an internal platform and not scheduled; the remedy is to scope
  the credential to `welltop/oma-environments` with a dedicated RAM user and
  move build pods to the Sandbox vSwitch.
- ACR Personal has no SLA and no tag deletion; image growth is accepted.
- The 2026-10-25 network finding (Sandbox egress reaches the VPC, including
  RDS) is unchanged by this decision.

## Spike results (#299)

Measured on 2026-10-25 on agent-platform
([report](../verification/environment-image-build-spike-2026-10-25.md),
[JSON](../verification/environment-image-build-spike-2026-10-25.json)):

- buildah builds and pushes from an unprivileged ACS pod with native overlay
  and chroot isolation; `RUN` is real root, so apt postinst and `chown` behave
  normally. A `video-production` draft took about 2.3 minutes from pod creation
  to pushed digest: pod start 38 s, base pull 65 s, build 30 s, push 5.5 s;
  4.4 GB of disk plus about 50 MB per build. Neither image config nor history
  held credentials or build variables. `oma-media` itself was not built there.
- Claiming with the pool's own image does not restart the container (0.18–0.21
  s). With tini the old container exits at once (code 143) and a swap to a
  32 MB Environment layer takes 3.6–5.2 s (median 4.0 s), against 34–36 s with
  the old entrypoint.
- The swap accepts both a single OCI manifest and an OCI index; builds push a
  single manifest.

## Superseded and revised decisions

- ADR-0014: the Pi tool runtime is installed in `oma-base`, not in each
  template; "Sandbox image/rebuild, then Host" becomes Base Images, Environment
  rebuilds, then Runner.
- ADR-0008: per-Agent template overrides (`sandbox.image`) are removed.
- ADR-0023: the Session field `environment` and the signal kind `environment`
  are renamed `sandbox`; "Environment failure" is renamed Sandbox
  unavailability.
- The Host's env layering (`defaultSandboxEnv` < `agent.sandbox.env` <
  per-Agent managed env < `WORKSPACE_ENV`, passed at creation) is replaced by
  the per-command order above; `base-secret` is no longer read for every
  Sandbox.
- `CONTEXT.md`'s "sole maintained template `auto-story-v2`" and "legacy
  `AUTO_STORY_*` injection remains required" no longer hold after the
  migration.
