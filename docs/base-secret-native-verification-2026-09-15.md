# Native base-secret injection verification — 2026-09-15

The release image passed an isolated live E2B verification. **The production
Host has not been switched to this release.** RBAC has been applied, but two
generation Turns are still running; the Host rollout timing awaits the user's
choice. This report does not claim production-wide enablement.

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
- The Deployment patch passed dry-run validation. It has not been
  applied to switch the production Host.

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
