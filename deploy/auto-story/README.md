# auto-story

`auto-story` is a Pi Agent using the `auto-story` sandbox template. It uses the
existing local Skills directly; neither the repository nor the image embeds
new copies of those Skills. The default model follows local Pi configuration:
`openai-codex/gpt-5.6-sol`. K3 and GPT-6 Astra are also selectable, with each
model's highest supported thinking level. See [Pi models](../../docs/pi-models.md).

## Create or refresh the Agent

Set `OMA_API_URL` to the API base (agentry uses
`https://agentry.welltop.tech/api`) and provide `OMA_API_KEY` or
`OMA_BEARER_TOKEN` privately in the process environment.

```sh
# Inspect exactly which original local Skills will be imported.
node deploy/auto-story/provision.mjs --dry-run
# Import local files and equip independent Agent Skill forks.
node deploy/auto-story/provision.mjs
```

The defaults use `~/.codex/skills/byted-mediakit-{shared,audio,editing,image,video}`,
`~/.codex/skills/video-analysis`, and the original embedded VFS Skill source at
`~/github/vfs-cli/internal/skills/data/vfs-cli`. Override the skill root with
`AUTO_STORY_SKILL_ROOT`, the VFS directory with `AUTO_STORY_VFS_SKILL`, or pass
explicit existing Skill directories as positional arguments. The VFS binary also
carries its matching workflow Skills, readable through `vfs-cli skills read`.

Provisioning reuses the named Agent and existing Library Skills, refreshes only
this Agent's forks, and preserves other Agents' copies. Original local files
remain unchanged. Cross-Skill relative links in the forks are adapted to their
actual `/skills/<fork-id>/` projection paths. Hidden files and cache directories
are excluded. Duplicate Agent or Library names fail explicitly.

Use `--skills-only` when adding a workflow to an existing Agent. This preserves
its selected model, system instructions, sandbox and proxy settings. Existing
equipped Skills outside the supplied directories remain equipped.

## Narration workflow in the test environment

VFS CLI v0.3.14 supplies SeedAudio generation and audio Resource uploads. Equip
the user's original `narration-led-film` directory and the matching VFS Skill,
then configure the existing Agent's test routing:

```sh
node deploy/auto-story/provision.mjs --skills-only \
  "$NARRATION_SKILL_DIR" "$HOME/github/vfs-cli/internal/skills/data/vfs-cli"
node deploy/auto-story/configure-narration.mjs <agent-id>
```

`NARRATION_SKILL_DIR` is the existing directory containing its original SKILL.md;
the workflow is not bundled into this repository or the sandbox image.
Configuration preserves the Agent's current model and adds an idempotent system
section with exact model aliases, real-audio timing, task recovery and Gemini
review requirements. Explicit VFS API overrides select the test backend.
SeedAudio's `SEED_AUDIO_API_KEY` belongs to the VFS backend, not the sandbox.

For an authorized small generation acceptance, `story-session.mjs start
<agent-id> <local-report-directory>` starts a real Agent Session using the
fictional [narration brief](e2e/narration-brief.md). It first generates one audio
track and one reference image and saves a phase checkpoint. The `send`, `status`
and `file` commands support subsequent video/edit/review phases and inspection.
This acceptance creates VFS test resources and consumes generation quota.

## Runtime environment

The sandbox accepts arbitrary string environment values through `sandbox.env`.
Use that field for non-secret options; it is stored in the Agent record and
returned by its API. The preset supplies `MEDIAKIT_SURFACE=skill` and
`MEDIAKIT_RUNTIME=pi-agent`.

For credentials, the Host accepts these two variables together:

- `AUTO_STORY_AGENT_IDS`: comma-separated Agent ids allowed to receive the values.
- `AUTO_STORY_SANDBOX_ENV_JSON`: a JSON object of environment names and string values.

The Host injects these values only for the allowlisted ids, after Agent-provided
values, and excludes them from other adapter CLI subprocesses. A missing
allowlist or malformed JSON fails at startup without echoing its contents.
The separately managed WW endpoint/credential pairing keeps precedence.

Use a dedicated Kubernetes Secret `oma-auto-story-env` to supply both variables
atomically. `deploy/k8s.yaml` has an optional `envFrom` reference; an existing
installation can append that reference to its live Host deployment. Do not apply
the legacy complete manifest over an existing environment.

Dependency variables, as discovered from the local working setup:

| Capability | Variables |
| --- | --- |
| VFS authenticated operations | `VFS_TOKEN`; optional `VFS_ACCESS_TOKEN`, `RUNTIME_ENV` |
| VFS direct OSS upload | `VFS_OSS_AK`, `VFS_OSS_SK` |
| MediaKit Cloud | `MEDIAKIT_API_KEY`; optional `MEDIAKIT_BASE_URL` |
| Official Gemini video analysis | `GEMINI_API_KEY` or `GOOGLE_API_KEY`; optional `GEMINI_VIDEO_MODEL` |
| Host K3 model | `KIMI_CODING_API_KEY` in the Host environment, outside the sandbox JSON |
| Host Codex models | Existing Pi `auth.json` OAuth in the Host's writable Pi directory |

Local machine proxy addresses must not be copied into a remote sandbox. If an
outbound proxy is required, use a reachable deployment-specific proxy and a
matching `NO_PROXY` list for internal services. Credentials are never image
build arguments, Skill text, or verification output.

## Build and deploy

The [sandbox recipe](../sandbox/auto-story/README.md) builds and verifies the
`auto-story` image. Publish it to the installation's registry and apply only
`sandboxset-auto-story.yaml` with the verified image digest and appropriate pull
Secret. Existing Agents continue to use the existing default template.

`deploy/Dockerfile.server` builds the full Host with the sanitized Pi catalog.
For the current agentry installation, `Dockerfile.server` in this directory is
an overlay on its verified existing Host digest, preserving its internal Sandbox
Manager routing and egress fixes. It updates Pi to the locally verified version,
refreshes the file-based server dependency, and reapplies the pinned subagent
bridge against pristine extension source.

[Dockerfile.tools](Dockerfile.tools) applies the Pi read/grep/image-history
fixes to an already verified Host image selected by its immutable `BASE_IMAGE`.
The API's pnpm `file:` dependency is a snapshot: copying updated files only to
`/app/adapter` leaves the API importing old code. The recipe also resolves
`@open-managed-agents/adapter-pi-agent` from `/app/server/packages/api` and copies
`custom-tools.ts` and `translator.ts` into that actual dependency directory.
Keep this snapshot refresh when extending the overlay; it does not require
reinstalling or changing pinned dependencies. Verify the resolved import path,
both file hashes against the source files, and successful module import from
the API working directory in the built image and deployed Pod.

Update both Host containers (`server` and `seed-pi-auth`) to the same new image.
Build the web console with `VITE_API_URL=https://agentry.welltop.tech/api`, then
update its `web` image. Await rollout and SandboxSet availability before running
the Agent acceptance test.

## Verification

[The real CLI/cloud checks](e2e/README.md) exercise synthetic media, an
authenticated VFS read, actual MediaKit processing, and Gemini upload/analysis/
cleanup. They do not modify a VFS project or generate chargeable VFS assets.

```sh
# Uses the real Agent, equipped Skill projections, sandbox, and Workspace store.
node deploy/auto-story/session-e2e.mjs <agent-id> /tmp/auto-story-session-test
```

The Session test uploads only verification scripts to its new Workspace, asks
the Agent to read the equipped original Skills, runs the checks, and requires
real `read`, `bash`, and `write` events plus the saved successful report. Local
CLI success alone is not counted as Agent Session success. The Session and
synthetic media artifacts remain available for inspection.

The agentry deployment and real Session acceptance are recorded in
[the acceptance report](../../docs/auto-story-e2e-2026-09-07.md), including the
required sandbox egress configuration and the provider's interpretation limits.
The ongoing [narration acceptance report](../../docs/auto-story-narration-e2e-2026-09-07.md)
records the tools-overlay commits, deployed digest, runtime snapshot checks,
and the separate remaining story-production checks.
