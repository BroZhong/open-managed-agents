# OSS Workspace deployment and recovery

Production uses Shanghai `agent-platform` with `auto-story-v2` as its only
template. [The current manifest](../sandbox/auto-story-v2/sandboxset.yaml)
records its pinned image. The [2026-09-14 release record](./oss-workspace-production-release.md)
is historical migration evidence, not the current image inventory.

This is the operational handoff for issues #124–#127 and
[ADR-0008](./adr/0008-oss-mounted-workspaces.md). The application remains on its
existing infrastructure: PostgreSQL, Redis, Supabase Skills storage, proxy and
application namespace are unchanged. Workspace files use Shanghai OSS and
execution uses the Shanghai Sandbox namespace. Application and Sandbox
resources are in the same `agent-platform` Shanghai cluster.

The application manifest is [`deploy/k8s.yaml`](../deploy/k8s.yaml). The Shanghai
cluster inventory, Agent Identity declarations and live evidence are in
[`deploy/oss-workspace/`](../deploy/oss-workspace/README.md).
Production uses `auto-story-v2` for the default and existing Agent overrides.
The maintained [image recipe](../sandbox/auto-story-v2/Dockerfile) includes
the mounted Workspace environment directly; no overlay image is required.
Use an explicit Shanghai kubeconfig and namespace for both application and
Sandbox changes. Do not change the default
kubectl context or restore any removed cloud profile. The inventory's local
verification commands use the authorized `welltop` profile; another environment
must use its own authorized credentials.

## Host configuration

The production/full Host entry point validates one coherent configuration in
`workspaceConfigFromEnv`, then assembles `OSSArtifactStore` and
`E2BSandboxClient` in `dev-server.ts`. There is no Workspace backend selector,
Supabase fallback, local filesystem fallback or dual-write mode.

| Variable | Requirement and deployed value |
| --- | --- |
| `WORKSPACE_OSS_REGION` | Required: `oss-cn-shanghai`; do not append `-internal` to the region. |
| `WORKSPACE_OSS_BUCKET` | Required: `agentry`, private with public access blocked. Must match the CSI provider's bucket. |
| `WORKSPACE_OSS_ACCESS_KEY_ID` | Required Host credential from the application's managed Secret. |
| `WORKSPACE_OSS_ACCESS_KEY_SECRET` | Required Host credential from the same secret source. Never pass it to an Agent or Sandbox. |
| `WORKSPACE_OSS_STS_TOKEN` | Optional token when the Host uses temporary credentials. |
| `WORKSPACE_OSS_ENDPOINT` | Host API endpoint. This manifest uses `https://oss-cn-shanghai.aliyuncs.com` to share the verified regional Host SDK configuration. CSI uses the internal endpoint. |
| `WORKSPACE_OSS_PUBLIC_ENDPOINT` | Public HTTPS signing endpoint. The manifest retains `https://oss-cn-shanghai.aliyuncs.com`; set an explicitly configured HTTPS custom domain attached to this Bucket for inline previews where default-domain policies restrict them. Internal/private endpoints and mismatched OSS regions are rejected. |
| `WORKSPACE_OSS_AGENT_NAME` | `agentry-workspace`; optional in code, explicit in the deployment. |
| `WORKSPACE_OSS_PV_NAME` | `agentry-workspace-oss`; optional in code, explicit in the deployment. |
| `WORKSPACE_OSS_CREDENTIAL_PROVIDER` | `agentry-oss-rw`; optional in code, explicit in the deployment. |
| `SANDBOX_ENABLED` | Required literal `true`. Disabling it is a startup error for this storage assembly. |
| `SANDBOX_TEMPLATE` | `auto-story-v2`. Check every Agent's stored template override too. |
| `E2B_DOMAIN` | Required: `sandbox.agentry.welltop.tech`; production keeps the existing Secret reference. |
| `E2B_API_KEY` | Required Shanghai gateway key from `oma-infra/oma-secrets`; an old gateway key is not interchangeable. |
| `E2B_REQUEST_TIMEOUT_MS` | Default and manifest value `185000`; accepted range `180000`–`300000`. |

Host credentials need Workspace object list/read/write/delete capabilities and
signed GET access for the configured bucket. They also need to list the
startup-check prefix described below and read runtime verification objects.
Production uses RAM user `agentry-workspace-host` with policy
`AgentryHostWorkspaceAccess`, limited to bucket `agentry`; its
[policy document](../deploy/oss-workspace/ram-host-permissions-policy.json)
contains no credential. The application reads its access key from
`oma-infra/oma-secrets`; rotate the key through that managed Secret and restart
the Host. This principal is separate from the operator's `welltop` CLI profile.
Use the existing secret-management process to provision the required
`WORKSPACE_OSS_ACCESS_KEY_ID`, `WORKSPACE_OSS_ACCESS_KEY_SECRET` and Shanghai
`E2B_API_KEY` keys before rollout. The Host also supports
`WORKSPACE_OSS_STS_TOKEN` for temporary credentials; the current production
manifest does not configure it. No secret values are present
in the repository's manifests or examples.

An environment-injected Host STS token is static in the current assembly;
`dev-server.ts` does not configure automatic Host STS refresh. Its renewal and
process lifecycle must be managed by the deployment environment. This is
separate from the Sandbox's Agent Identity refresh contract. Do not infer that
a passing Sandbox credential-refresh probe also renews Host credentials.

The SDK request timeout is separate from the Sandbox lifetime. Shanghai's ALB
allows 180 seconds and observed cold starts can exceed 60 seconds; 185 seconds
lets the ALB response reach the SDK. All bindings use lifecycle-managed
never-timeout creation and confirmed idle reclamation instead.
Neither a longer HTTP timeout nor a longer Sandbox lifetime
extends an expiring credential.

For local configuration, [`server/.env.example`](../server/.env.example)
contains placeholders only for credentials. The full Host does not load `.env`
automatically; supply variables through the process supervisor or an explicit
shell environment. Keep local `.env` files untracked. Memory-only development
fixtures are not evidence of an OSS production deployment.

## Direct browser reads

ADR-0012 makes Workspace file reads return JSON metadata and a signed OSS GET
URL through the single `/files/{path}` read endpoint. The Host does not
buffer file content for browser or program downloads. The existing manifest
keeps its public regional endpoint until an actual custom domain is provisioned;
it does not create a domain, certificate or Bucket CORS rule.

Use the regional OSS domain when actual browser tests pass. If its default-domain
policies prevent the required previews, attach a dedicated file domain to the Bucket, enable HTTPS
on it and set `WORKSPACE_OSS_PUBLIC_ENDPOINT` to that HTTPS origin. Use a domain
separate from the console's origin so Workspace HTML does not run with console
origin privileges. CNAME mode is selected automatically for an explicitly
configured custom domain. Default OSS-domain preview restrictions and generic
ossfs MIME metadata must be checked with real files before release. Custom-domain
signing can apply MIME inference without modifying object metadata; regional
signing preserves stored MIME.

Browser text reads and media elements using anonymous CORS need a Bucket CORS
rule for the actual console origin (currently `https://agentry.welltop.tech`),
permitting `GET`/`HEAD` and exposing
the response headers needed by clients (`Content-Type`, `Content-Length`,
`Content-Range`, `Accept-Ranges`, `ETag`, `Content-Disposition`). Allow `Range`
and conditional headers if the client sends them; add development origins only
to the appropriate development environment. An authorized API response does not
prove that a browser can read the OSS response. OSS requests must not include
the platform's Authorization or x-api-key headers.

Before rollout, verify text preview through CORS, real JPG/PNG/audio/video,
generic MIME objects, Range/206 seeking, attachment downloads with Unicode
names, refreshing an expired URL and cancelling a superseded file selection.
Compare the browser network trace: media selection must request metadata once
and then load from OSS, with no full media GET through the Host. Run
`node server/test-workspace-api.mjs` with the target environment's authorized
configuration for file lifecycle checks; this script writes temporary fixtures
and is not a read-only production check. Local tests alone do not establish
live Bucket configuration.

## Host credentials and CSI identity are separate

The Host authorizes Tenant/Workspace ownership before computing the single
object prefix, `<tenantId>/<workspaceId>/`. IDs allow 1–128 ASCII letters,
digits, `_` or `-`. The same helper supplies the file API and Environment Spec;
CSI `subPath` removes only the final slash. A browser cannot choose arbitrary
prefixes, mount paths or credential-provider metadata.

The Shanghai Sandbox uses the existing `agentry-workspace` AgentIdentity,
`agentry-oss-rw` CredentialProvider and `agentry-workspace-oss` PV. RRSA issues
bucket/subPath-restricted STS credentials; the PV uses
`https://oss-cn-shanghai-internal.aliyuncs.com`. These infrastructure resources
are already deployed and versioned in the inventory. Do not recreate roles,
replace compatible add-ons or copy Host access keys into E2B metadata.

Inside the Sandbox, `/home/user/workspace` is a root-owned symlink to the CSI
mount under `/run/csi/mount-root/oss/`. Kernel mountinfo reports `fuse.ossfs` with
a generic `ossfs` source, so checking its filesystem type alone cannot prove
the bucket or prefix. Before tools run, the application verifies gateway
storage identity and the real mount, writes/closes/reads a random probe as
UID/GID 1000, and independently reads that value through the Host OSS store
from the exact expected prefix. Cleanup runs afterward. Probe objects are
confined to the reserved `.oma-workspace-checks/` subtree, which business file
APIs hide and reject. Interrupted cleanup can leave only reserved probe
residue; a cleanup or readback failure blocks execution instead of reporting a
successful check.

`HOME=/home/user` remains local. Node packages, Python packages/venvs and caches
follow the [supported local installation paths](../sandbox/auto-story-v2/README.md#workspace-and-local-directories).
Rebuilds can discard them. Only mounted Workspace content persists. Arbitrary
shell commands are not rewritten to exclude `node_modules` or `.venv`.

## Skills remain on Supabase

Retain `S3_ENDPOINT` or `SUPABASE_STORAGE_URL`, and `S3_SERVICE_KEY` or
`SUPABASE_SERVICE_KEY`. `S3_BUCKET` defaults to the existing `workspace` bucket;
that historical bucket name now identifies Skills storage, not Workspace file
storage. Do not rename or clear it merely because Workspace files moved to OSS.
The application manifest preserves its existing endpoint and service-key Secret
reference. The full Host still requires these Skills settings at startup.

Equipped Skills remain read-only projections outside the Workspace at
`/skills/<skill-name>/`. Internal storage lookup and authorization still use
Skill IDs. Unsafe or duplicate equipped names fail visibly. Refresh/rebuild
reprojects Skills and removes obsolete named paths; neither Skills nor Agent
Files become Workspace objects.

## Read-only OSS startup check

Before the HTTP listener opens, the full Host performs an OSS listing of
`oma_startup/storage_check/`. It creates, overwrites, migrates and deletes no OSS
objects. The check requires a reachable endpoint, existing bucket and sufficient
Host list permission. A configuration or storage error stops startup clearly;
Supabase settings cannot satisfy missing OSS configuration.

This read-only OSS check does not prove write permission, a working CSI mount,
all per-Workspace permissions, or that previously open file handles saved.
Runtime probe/readback checks supply mounted-execution evidence separately.
Other startup responsibilities, such as existing database initialization and
pending-input recovery, remain application behavior.

Inspect only the relevant non-secret startup status messages, such as
`OSS Workspace enabled; Sandbox mount checks required; Skills projected from Supabase`
or the explicit `OSS Workspace startup check failed` error. Do not dump Secret
contents, environment variables, cloud responses containing tokens, or signed
URLs into release notes or logs.

## Coordinated storage maintenance

The initial OSS migration is complete. The procedure below applies only when
a future change alters the storage contract; ordinary image releases follow
[the deployment guide](../deploy/README.md). The file API uses Workspace IDs,
requires no Session and permits concurrent writes (ADR-0009).

Complete the [acceptance evidence](./oss-workspace-acceptance.md) before choosing
a maintenance window. Infrastructure checks alone do not replace the
application's authenticated browser → Host OSS → Agent → browser flow.
The required real credential-refresh run must span more than one hour; a short
simulation is not a substitute. Unfinished checks remain release blockers.

1. Review drift against the Shanghai inventory. Confirm public browser reachability,
   Host endpoint access, the private bucket, identity resources, TLS and ALB
   timeout. Keep the existing application PG/Redis/Skills/LLM-proxy addresses.
2. Publish the reviewed Sandbox image to an authorized registry and pin the
   resulting registry digest in the Shanghai SandboxSet. The
   [local image check](../sandbox/auto-story-v2/README.md#build-and-verify)
   alone is insufficient; use the published registry digest. Also build and pin
   the reviewed Host/web artifacts.
3. Inventory active Sessions, running Turns, accepted Queued Input and app-owned
   Sandbox resources. Review every Agent's stored template override: the live
   inventory previously observed a different default, and an Agent override can
   bypass a new default. Validate or replace overrides through the normal
   authorized configuration workflow; the stock reference template is not an
   accepted substitute.
4. During the approved window, use existing ingress/release controls to stop new
   Turns and Workspace mutations. Let active Turns and accepted Queued Input
   drain on the existing Host. The application provides no new maintenance
   endpoint or Workspace-wide lock. If work cannot drain, obtain a deliberate
   operator/user decision before Interrupting it; do not silently discard queued
   input or terminate business execution. A process shutdown grace period alone
   is not evidence that all Sessions drained.
5. Retire the old app-owned execution resources once their work is finished.
   Preserve Session history and all Workspace objects. Apply the reviewed
   Shanghai template with its explicit kubeconfig and wait for warm readiness;
   apply the coordinated Host OSS configuration/secrets and Host/web artifacts
   to `oma-infra` in the same cluster using the explicit kubeconfig. Keep
   traffic closed until both sides use the same OSS prefix contract. Do not
   let a Host serving OSS files continue an old local/Supabase-backed Sandbox.
6. Verify startup and run isolated authenticated acceptance: upload, list,
   text/binary preview/download, Agent read/edit/shell-created files, concurrent
   Sessions, rebuild, isolation, mount failure/recovery, Turn-end refresh error,
   Interrupt, Session deletion retaining files, and named Skills. Confirm no
   new hydrate/sync behavior and clean only the test instances/prefixes. Reopen
   traffic after the required checks pass and record the deployed digests.

An established Session may see an empty OSS Workspace after the switch because
historical Supabase files are not copied. Explain this visibility boundary
before the window. There is no historical migration, no dual write, and no
permission to delete an old bucket or business objects as cleanup.

## Failure handling and recovery

| Symptom | Response |
| --- | --- |
| Missing Host settings or startup-list failure | Keep the new Host unavailable; verify configured bucket, network, required Secret keys and Host permissions. Do not switch backend or fabricate an empty directory. |
| Missing mount, wrong prefix, expired permission or probe/readback failure | Block affected execution, repair the storage/identity condition, and retry after the next mount check succeeds. Preserve already saved files. |
| Turn finished but storage check or web file refresh failed | Keep the answer and completed Turn state. Show the storage error and retry the file refresh/check; do not silently rerun the Turn or claim all files were saved. |
| Explicit Session termination cleanup failed | Report the resource-cleanup failure and retry cleanup of the identified Sandbox. Workspace objects remain. Console soft deletion is separate and does not terminate execution or reclaim a Sandbox. |

Saved means that an individual file operation completed and closed successfully.
There is no Turn transaction, rollback, locking, conflict merge, version history
or undo. Same-file concurrent writes may overwrite one another; rename remains
non-atomic. OSS caches can delay visibility, and measured probe latency is not
an SLA. Long-running background processes and open handles are not guaranteed
to finish saving at Turn end or Sandbox disposal.

If a switch fails, keep affected traffic closed and preserve both stores while
repairing the coherent OSS configuration. Rolling application code back alone
does not copy OSS files into Supabase: the older code would expose the older
store's file set, while newly saved OSS files remain in OSS. Decide and document
that visibility consequence before any authorized rollback. Do not add silent
back-copying, dual write, destructive cleanup or automatic Turn reruns.

## Certificate and credential maintenance

The public E2B certificate covers the main and wildcard Sandbox domains and
expires **2026-12-13 07:53:21 UTC**. Automatic renewal is not configured as of
the 2026-09-14 inventory. Track renewal as an explicit operations obligation:
use the approved certificate process, update `agentry-sandbox-tls` in the
Shanghai deployment during a planned change, and verify the public chain,
hostnames and new expiry. Implementing a renewal system is outside this storage
replacement. Host credentials, Sandbox STS refresh and TLS expiry are separate
operational concerns; success of one check does not establish the others.
