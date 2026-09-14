# OSS Workspace deployment inventory

Production was subsequently deployed with `auto-story-v2` as its only template.
Use the [production release record](../../../docs/oss-workspace-production-release.md)
and `production-verification.json` for current image digests and live acceptance.
The inventory and isolated checks below retain their pre-release context.

This directory records the Shanghai configuration verified on 2026-09-14 for
issues #124–#127. It does not perform a production storage switch. Existing
RAM roles and compatible managed add-ons must be reused. There is no Workspace
data migration, dual write, or authorization to delete old storage.

## Verified infrastructure

| Item | Observed value |
| --- | --- |
| CLI identity | Alibaba profile `welltop`; never restore or use `brozhong` |
| Cluster | `agent-platform`, `c4d4dbd36064d4341835496ed01023600`, `cn-shanghai` |
| Kubernetes | `1.36.1-aliyun.1`; cluster `running` |
| Agent Identity | `0.5.1`, active; RRSA enabled |
| Sandbox controller | `v0.6.6-release.1`, active |
| Sandbox manager | `v0.6.11`, active; 1/1 ready |
| Sandbox gateway | image `ack-sandbox-gateway:v0.3.0`; 1/1 ready |
| E2B | `sandbox.agentry.welltop.tech`; public HTTPS verified |
| OSS | bucket `agentry`, `oss-cn-shanghai`, private, block public access true |
| Mount endpoint | `https://oss-cn-shanghai-internal.aliyuncs.com` |
| Browser endpoint | `https://oss-cn-shanghai.aliyuncs.com` |
| RAM | `AgentrySandboxOssRole`, max STS session 3600 seconds; policy `AgentrySandboxOssAccess` v1 |
| Identity resources | `agentry-workspace`, `agentry-oss-rw`, `agentry-workspace-storage` in `sandbox-system` |
| PV | `agentry-workspace-oss`, `Retain`, `ReadWriteMany`, `agent-identity` |
| STS policy | Bucket/subPath narrowed by provider template, valid `1h` |
| Mount options | `-o sigv4 -o region=cn-shanghai -o uid=1000 -o gid=1000 -o umask=007 -o allow_other` |
| Template | `code-interpreter-vfscli`, warm replicas 1, available 1 |
| Resources | 2 CPU, 4 GiB memory, 50 GiB ephemeral-storage request |
| Template networking | `ClusterFirst`, `network.alibabacloud.com/wait-clusterip-ready: "*"` |
| Image pull Secret | `ali-shanghai` in `sandbox-system`; no credentials in this directory |
| HTTPS ALB | port 443, `requestTimeout: 180`; HTTP port 80 also configured |
| TLS Secret | `agentry-sandbox-tls`; main and wildcard sandbox domains |
| Certificate expiry | **2026-12-13 07:53:21 UTC**; no automatic renewal configured |

The 50 GiB PV capacity is a Kubernetes declaration, not an OSS quota. The live
SandboxSet image digest is captured in
[`../sandboxset-code-interpreter-vfscli.yaml`](../sandboxset-code-interpreter-vfscli.yaml).
That image predates the application changes in these issues: rebuild and pin a
new digest before cutover when launcher or dependency settings change.

`storage.yaml` is the sanitized current Kubernetes declaration. The two RAM
JSON files document the existing role's trust and maximum permissions. The
CredentialProvider policy in `storage.yaml` additionally restricts each issued
STS credential to the requested bucket/subPath. Do not replace these with
bucket-wide credentials inside a Sandbox. The trust permits only this cluster's
`ack-agent-identity:credential-provider` ServiceAccount.

## Safe read-only verification

Keep `welltop` explicit. Do not switch the default kubectl context; on this
machine it still points at a different cluster. Acquire a temporary kubeconfig
without printing its content:

```bash
umask 077
OMA_SHANGHAI_KUBECONFIG="$(mktemp -t oma-shanghai-kubeconfig)"
export OMA_SHANGHAI_KUBECONFIG
aliyun cs GET /k8s/c4d4dbd36064d4341835496ed01023600/user_config \
  --profile welltop | jq -r .config > "$OMA_SHANGHAI_KUBECONFIG"

kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" -n sandbox-system \
  get sbs code-interpreter-vfscli
kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" -n sandbox-system \
  get agentidentity agentry-workspace
kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" -n sandbox-system \
  get credentialprovider agentry-oss-rw
kubectl --kubeconfig "$OMA_SHANGHAI_KUBECONFIG" get pv agentry-workspace-oss

aliyun cs ListClusterAddonInstances \
  --cluster_id c4d4dbd36064d4341835496ed01023600 --profile welltop \
  | jq '[.addons[] | select(.name | test("agent|sandbox")) | {name,version,state}]'
aliyun ossutil api get-bucket-info --bucket agentry --region cn-shanghai \
  --endpoint https://oss-cn-shanghai.aliyuncs.com --profile welltop \
  --output-format json
```

Raw Alibaba cluster-detail and add-on-config responses may contain embedded
E2B API keys. Always select explicit non-secret fields **before** displaying
those responses. Never print Kubernetes Secret data, cloud keys, E2B keys,
credential-provider responses, runtime token annotations, or signed URLs into
logs or review artifacts.

The local CLI versions verified were aliyun `3.4.2`, ossutil `2.4.0`; the probe
uses E2B SDK `2.24.0` to match the application. Certificate inspection can use
`openssl s_client` and `openssl x509 -noout -dates -ext subjectAltName`; only the
public certificate is needed.

Remove the temporary kubeconfig after verification and any tests using it:

```bash
rm -f "$OMA_SHANGHAI_KUBECONFIG"
unset OMA_SHANGHAI_KUBECONFIG
```

## Maintenance and release gate

At inventory time production `oma-infra/oma-server-config` selected
`SANDBOX_TEMPLATE=auto-story`, and at least one Sandbox was claimed. Do not
assume that selecting a new Host default replaces per-Agent image overrides or
already-created Sandboxes. Inventory active Sessions and all effective Agent
templates before scheduling a consistent maintenance switch. Do not interrupt
business Sessions or roll storage configuration while they still execute.

Review drift before applying any declaration. Existing compatible add-ons and
RAM resources need no reinstall, upgrade, or recreation. In an approved
maintenance window, apply only the reviewed changes with the explicit Shanghai
kubeconfig. Confirm the new template's image, DNS and runtime settings, and
wait for warm availability. Roll the Host's final OSS configuration and recycle
old execution resources together; an old Sandbox must not keep running against
the previous Workspace store while its Host serves OSS files.

The release gate includes: authenticated browser upload/list/preview/download,
Agent read/edit/create, concurrent Sessions, rebuild, cross-Tenant and
cross-Workspace rejection, mount/permission failure, Turn-end refresh failure,
Interrupt, Session deletion retaining Workspace files, Skills regression, and
real mounted writes more than one STS lifetime apart. A passing infrastructure
probe does not establish all application acceptance cases. Record gaps as
release blockers, not passing checks.

On a failed switch, stop new affected execution and show the storage error.
Repair configuration/mounts and recheck before retrying. Rolling code back
alone does not copy OSS files into the former Workspace store: users would see
that store's old file set, and files written in OSS remain there. Preserve both
stores; choose an explicit, reviewed recovery plan before reopening execution.

## Real credential refresh probe

The companion script creates only a unique `probe_<uuid>/ws_<uuid>` prefix and
its own Sandboxes, writes test bytes as ordinary UID/GID 1000, checks public
Host reads, waits 65 minutes, writes and reads again, and cleans only those
instances and that exact prefix in `finally`. A Sandbox TTL of 85 minutes and
185-second SDK request timeout accommodate the observed cold starts and the
180-second ALB limit. No short-duration simulation counts as the real refresh
test. If a run is interrupted or a cleanup call fails, use the recorded test
IDs to finish its exact cleanup; TTL alone does not remove OSS objects.

The probe report belongs beside the release evidence and must contain no keys
or signed URLs. Current-run evidence will be recorded in `verification.json`.

Run the probe only from an authorized environment after installing the repository
dependencies. It reads the existing E2B key into process memory from the explicit
Shanghai kubeconfig above, or uses an already-injected `E2B_API_KEY`:

```bash
pnpm --dir server install --frozen-lockfile
OMA_PROBE_REPORT=/tmp/oma-oss-workspace-verification.json \
  node deploy/sandbox/oss-workspace/verify-credential-refresh.mjs
```

`OMA_SHANGHAI_KUBECONFIG` must still be exported. Do not put an E2B key on the
command line. Keep the process alive until `credential-refresh-passed`,
`sandbox-cleaned`, and `prefix-cleaned` are recorded; SIGINT/SIGTERM also attempt
cleanup. Killing the process with SIGKILL or losing the machine prevents the
finally block, so use the report's exact Sandbox ID and generated prefix for
manual cleanup if necessary.

The observed mount is a root-owned symlink from `/home/user/workspace` to
`/run/csi/mount-root/oss/<opaque-hash>`. Mountinfo identifies `fuse.ossfs` but
its source is the literal `ossfs`, with filesystem root `/`: it does not encode
the bucket or prefix. E2B consumes the initial `csi-volume-config` metadata and
returns `security.agents.kruise.io/storage-auth`, a JSON string carrying the
credential provider, bucket name, and sub-path. Mount verification must check
both the canonical mount target and that trusted metadata; checking only a
literal `/home/user/workspace` mountinfo row rejects a valid CSI mount.

## Isolated application acceptance

`verify-application.mts` assembles the actual HTTP application, SessionRouter,
DefaultSandboxManager, E2BSandboxClient and OSSArtifactStore. It registers and
logs in through the actual local application handlers, then sends the same
Workspace and event requests as the console. It creates independent random
Tenant/Workspace identities and only its own live E2B instances. No production
HTTP service, user, Session, Postgres database or Redis database is modified.

Only the control metadata/auth stores and Skill artifact source are in memory.
A deterministic Adapter drives the real injected ToolExecutor at the existing
Adapter seam. Skill bytes still pass through the actual S3ProvisionSource and
become Sandbox files outside the Workspace. This verifies application wiring
and persistence behavior, without claiming a model/provider request, production
Supabase read, or browser rendering check. The repository's existing Supabase
Skill tests must also pass before release.

```bash
# After repository dependencies are installed; explicit Shanghai kubeconfig is
# exported as above. Reads only the existing welltop profile's credentials into
# process memory; never prints them or embeds them in the command line.
OMA_PROBE_REPORT=/tmp/oma-application-verification.json \
  pnpm --dir server --filter @oma-server/api exec tsx \
  ../../../deploy/sandbox/oss-workspace/verify-application.mts
```

The scenarios include login/upload, Agent edit and shell-created Unicode binary
files, Host list/preview/download and public signed GET, Tenant/Workspace/path
isolation, concurrent Sessions with the existing 423 edit gate, Sandbox rebuild,
Skill re-projection, failure after an answer or completed write, unavailable
file-list responses, pre-execution mount checks and explicit retry, Interrupt,
Session deletion retaining files, and Host rename/delete. Storage failures are
injected only at this isolated process's external OSS boundary. Real OSS calls
remain enabled for every non-injected operation.

The process records its exact created Sandbox IDs and Workspace prefixes, then
terminates those Sessions and instances and deletes only those prefixes in
`finally`. This application run is independent from the 65-minute credential
soak, so it can run while that proof is waiting.

Live acceptance also caught OSS rejecting signed GET requests containing a
`response-content-type` override. Alibaba documents this restriction in
[error 0017-00000902](https://help.aliyun.com/en/oss/user-guide/0017-00000902).
Signed reads now use the object's actual metadata; the Host proxy still infers
MIME for generic ossfs metadata. The observed ossfs-generated PNG and MP4 returned
`image/png` and `video/mp4` respectively through the public signed URL, with
bytes matching the Host read. This observation does not guarantee MIME metadata
for every file extension or producer.
