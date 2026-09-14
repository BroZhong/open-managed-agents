# Native base-secret injection verification — 2026-09-15

The release image passed an isolated live E2B verification and was subsequently
deployed to the production Host. Both generation Turns had finished before the
rollout; a read-only database check found zero running Sessions and zero pending
events. No active Turn was interrupted for this release.

## Release

- Code commit: `e2589775193670ad7155dbaf5844834df1345f96`.
- Server image:
  `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-server@sha256:54dad117d9938dfe74dcd25de636295b74a12942493f7182950f0fb81832ee7a`.
- Credential source: the existing `sandbox-system/base-secret`.

The Host reads valid environment keys from this Secret at startup and passes
them through the Environment Spec to E2B `Sandbox.create({ envs })`. This supplies
shared defaults for existing and future Sandboxed Agents without an Agent ID
allowlist. File keys such as `source.env` are excluded. Values are not copied
into Agent records or Host `process.env`.

## Live verification

An isolated verification Pod used the release image and the dedicated
`oma-infra/oma-server` ServiceAccount. The loader read the shared Secret over
HTTPS using the ServiceAccount CA and bypassed the Host's outbound proxy.

The resulting values were injected into a real E2B Sandbox. A command running
as the ordinary Sandbox user, UID `1000`, compared all **18 environment values**
with their source using HMAC equality checks: **18 of 18 passed**. The same
command confirmed that `/etc/profile.d/acs_env.sh` did not exist. This verifies
native E2B command injection without the shell-profile synchronization bridge.

The local evidence file was
`/tmp/oma-base-secret-native-verification.jsonl`; its verification record reports
`keyCount: 18`, `uid: 1000`, `profileExists: false`, and 18 true comparison results.
No Secret values or HMAC digests are included in this report. The temporary Pod,
ConfigMap, and test Sandbox were cleaned up.

## Checks

- Secret loader: 40 tests passed; environment policy: 16 tests passed. These
  56 targeted tests include the final legacy-preset credential-rotation case.
- SessionRouter Sandbox tests: 28 passed.
- The earlier full API suite passed 398 tests with one optional test skipped;
  the subsequently added legacy-rotation test passed in the targeted run above.
- API TypeScript checking passed.
- RBAC permits only `get` on `sandbox-system/base-secret`; checks denied reading
  another Secret, listing Secrets, and updating the shared Secret.
- The Deployment patch passed dry-run validation and the production rollout
  completed successfully. Pod `oma-server-55986b7d8f-jzd5q` uses the release digest
  and the dedicated ServiceAccount; Deployment generation 23 was observed with
  one updated and ready replica.
- The new Host logged that it loaded 18 shared environment variables, and the
  public `/api/health` returned `{"status":"ok"}`. A read-only probe using the
  deployed loader and policy found all 18 keys with identical effective values
  for all six existing Agents, including `test1`. This policy check does not
  claim a separate model Turn or native-tool probe for each Agent.
- The Host's Kimi credential remained present. The three legacy auto-story
  Agents still receive their three additional VFS variables.

## Operational behavior

Secret rotation requires restarting the Host; existing process environments do
not refresh automatically. After the rollout, a Session's next Sandbox is
created with the newly loaded values, while Workspace files remain in OSS.

Explicit Agent `sandbox.env` values still override shared defaults. The legacy
auto-story preset only supplements keys absent from the base Secret, so its
older copies cannot override rotated shared credentials. Explicitly scoped WW
configuration retains its precedence, and fixed Workspace environment values
are applied last. Without the base Secret integration, legacy preset behavior
is unchanged.

## Legacy Secret retirement audit

Neither legacy Secret was deleted during this audit.

`sandbox-system/oma-auto-story-source-readonly` has no current Pod, Sandbox,
or SandboxSet consumer. The sole discovered reference is historical
SandboxTemplate `auto-story-v2-6d778d944c`. The current revision is
`auto-story-v2-59ddb969c6`; both current Sandboxes use that revision and mount
`base-secret` at `/run/auto-story-source`. The old Secret's two direct OSS read
keys equal those in base. Its `source.env` contains only those two assignments;
the base file contains both with equal values plus additional assignments.
Retire the historical template together with this Secret to avoid leaving a
rollback target with missing credentials.

`oma-infra/oma-auto-story-env` remains referenced by the Host Deployment and
its Pod. In addition to the legacy Agent allowlist and sandbox JSON, it supplies
`KIMI_CODING_API_KEY`, which is absent from both `base-secret` and `oma-secrets`.
The live Host has `PI_CODING_AGENT_DIR=/opt/pi-agent-seed`. Secret
`oma-pi-gateway` mounts its `models.json` and `auth.json` into this directory,
overriding the image's seed files. The effective Kimi provider's API-key setting
is `${KIMI_CODING_API_KEY}`; the mounted auth file only has an `openai-codex`
credential. Thus the Kimi setting still resolves the legacy Host environment
variable. This conclusion comes from the live files, not `deploy/pi-models.json`.
The current Kimi endpoint is `api.kimi.com`; only the OpenAI provider routes
through `sub2api.sub2api.svc.cluster.local`.

Keep the Kimi credential with the existing model configuration by moving it to
a separate data key in `oma-pi-gateway` and adding an explicit Host
`secretKeyRef` for that key before removing the old Secret reference. Native
sandbox injection does not supply the Host's model credentials. This refines the
earlier suggestion to move it to the general-purpose `oma-secrets`; no Kimi
credential was moved during either audit.

The legacy sandbox JSON has 18 keys that match base plus three extra keys:
`VFS_ACCESS_TOKEN`, `VFS_OSS_AK`, and `VFS_OSS_SK`. The access token equals base's
`VFS_TOKEN`, but the variable names are separate. The VFS OSS key pair differs
from base's OSS read key pair. Preserve the still-required VFS capabilities by
explicitly migrating their variables before removing both `AUTO_STORY_*`
settings and the old Secret. Do not replace the VFS pair with the OSS read pair.
Historical Host ReplicaSets also retain references to the old Secret and must
be considered when retiring rollback revisions.
