# Deployment

The production deployment runs on the Alibaba Cloud `agent-platform` ACS
cluster in `cn-shanghai`. This document and the manifests in this directory are
the current deployment reference. Dated E2E reports under `docs/` describe their
original runs and must not be used as current runbooks.

Native finite Sandbox lifetime follows [ADR-0019](../docs/adr/0019-native-sandbox-lifecycle.md)
and its [deployment procedure](../docs/sandbox-lifecycle-deployment.md).
Migration 0020 replaces the historical activity table/idle scanner with binding
coordination. Current production uses split `oma-api` / `oma-runner`; the legacy
combined `oma-server` Deployment is scaled to zero. Release the actual split
Deployment image fields; the legacy `deploy-app.sh` does not target them.
See [the 2026-10-11 native lifecycle release](../docs/verification/native-sandbox-production-2026-10-11.md).

## Topology

| Scope | Namespace | Resources |
| --- | --- | --- |
| OMA application | `oma-infra` | `oma-api`, `oma-runner`, `oma-web`, their Services, and the `oma-console` ALB Ingress |
| Application dependencies | `oma-infra` | Redis and sing-box; provisioned separately from `deploy/k8s.yaml` |
| Agent sandboxes | `sandbox-system` | ACK sandbox manager/gateway; sole maintained `auto-story-v2` SandboxSet |
| Test environment | `oma-test` | Its own `oma-api`, `oma-runner`, `oma-web`, Redis and `oma-console` Ingress; see [Environments](#environments) |

The public console and API share `https://agentry.welltop.tech`. The ALB sends
`/api/*` to the API Service and all other paths to `oma-web`. The Server therefore
runs with `API_BASE_PATH=/api`, and its readiness endpoint is `/api/health`.
Use `https://agentry.welltop.tech/api` as the API base URL; `/v1/*` examples are
relative to it. The deployed OpenAPI document is available at
`https://agentry.welltop.tech/api/openapi.json`.

Check the health response body as well as the HTTP status:

```bash
curl -fsS https://agentry.welltop.tech/api/health | jq -e 'select(.status == "ok")'
```

Without `/api`, `/health` and `/openapi.json` are served by the console and may
return `200` HTML. That response does not confirm API health or contain an API
schema.

The application images are stored in the Shanghai `welltop` ACR. Pods pull
through the VPC endpoint with the `ali-shanghai` image-pull Secret. The active
sandbox default is `auto-story-v2`, whose immutable image digest is declared in
[`sandbox/auto-story-v2/sandboxset.yaml`](../sandbox/auto-story-v2/sandboxset.yaml). It includes VFS CLI, FFmpeg, Gemini's
Python SDK, MediaKit and native `rg`/`fd` search, without OpenMontage or Whisper.
This is the only pool maintained or shipped by this repository.

## Environments

Production and test share the cluster, the RDS instance, the Supabase instance,
the Sandbox pool and the Workspace OSS bucket. They are separated at the
application layer:

| Resource | Production | Test |
| --- | --- | --- |
| Namespace | `oma-infra` | `oma-test` |
| Public URL | `https://agentry.welltop.tech` | `https://agentry-test.welltop.tech` |
| PostgreSQL schema / role | `oma` / `oma_app` | `oma_test` / `oma_test_app` |
| Redis | existing `oma-infra/redis` | `oma-test/redis` from the overlay |
| Skill Storage bucket | `workspace` | `workspace-test` |
| Workspace OSS | `agentry` bucket | same bucket; Tenant IDs are random UUIDs, so prefixes never overlap |
| Runner PG pool | 30 | 10 |
| Secrets | `oma-infra/*` | copies of the production Secrets, except `PG_PASSWORD` |

Neither role can use the other schema. The test schema is owned by the admin
role, and `oma_test_app` has only `USAGE` plus the table, sequence and function
privileges that `oma_app` has in production. Anything that works in test
therefore cannot depend on extra production privileges. Because `AUTH_JWT_SECRET`
is shared, a console token from one environment is also accepted by the other
API. It resolves to a Tenant with no data there.

Manifests are Kustomize overlays on one base:

| Path | Contents |
| --- | --- |
| `app/` | API, Runner, Web and Ingress without a namespace; production configuration values |
| `environments/production/` | `oma-infra`; keeps the live `/api` route to the legacy `oma-server` Service |
| `environments/test/` | `oma-test`, test configuration patches, ServiceAccount and Redis |
| `environments/test/sandbox-rbac.yaml` | Read grant on `sandbox-system/base-secret`; applied separately because the overlay rewrites namespaces |

`scripts/render.mjs` renders an overlay and substitutes the three image
placeholders. Each version is an immutable tag or a `sha256:` digest:

```bash
node deploy/scripts/render.mjs production API_VERSION RUNNER_VERSION WEB_VERSION
```

The production overlay matches the live Deployments, ConfigMaps, Services and
Ingress (verified with `kubectl diff` on 2026-10-14). Production releases still
patch only image fields. Use the rendered production manifest for `kubectl diff`
before a configuration change.

### Test releases

Release the same image to test before production:

```bash
export KUBECONFIG=~/.kube/agent-platform-config
node deploy/scripts/render.mjs test API_VERSION RUNNER_VERSION WEB_VERSION > /tmp/oma-test.yaml
kubectl diff -f /tmp/oma-test.yaml
kubectl apply -f /tmp/oma-test.yaml
for d in redis oma-api oma-runner oma-web; do kubectl -n oma-test rollout status deploy/$d; done
curl -fsS https://agentry-test.welltop.tech/api/health | jq -e 'select(.status == "ok")'
```

Unlike production, test applies the complete rendered manifest. Do not put
manual changes on test resources; add them to the overlay.

### Test migrations

Apply every new migration to test first. `scripts/migration-for-env.mjs`
rewrites `oma.` and `oma_app` to the test schema and role; review its output and
apply it with the privileged migration operator, as for production:

```bash
node deploy/scripts/migration-for-env.mjs test deploy/migrations/0021_example.sql
```

The test schema was created on 2026-10-14 from `schemaDdl("oma_test")` and
migrations 0001–0020 rewritten this way. Its columns, indexes, constraints,
triggers, functions and application privileges were compared with `oma` and
have no differences.

### Test secrets

The test Secrets are copies. After rotating a production Secret, copy it again
and restart the test Deployments. Keep the test `PG_PASSWORD`:

```bash
export KUBECONFIG=~/.kube/agent-platform-config
for s in ali-shanghai certwelltoptech2026 oma-pi-gateway oma-auto-story-env; do
  kubectl -n oma-infra get secret "$s" -o json \
    | jq '.metadata = {name: .metadata.name, namespace: "oma-test"}' \
    | kubectl apply -f -
done
kubectl -n oma-infra get secret oma-secrets -o json \
  | jq --arg pg "$(kubectl -n oma-test get secret oma-secrets -o jsonpath='{.data.PG_PASSWORD}')" \
      '.metadata = {name: "oma-secrets", namespace: "oma-test"} | .data.PG_PASSWORD = $pg' \
  | kubectl apply -f -
```

## Image pipeline

Build and publish images on `vfs-dev`. The application Dockerfiles start from
these pinned bases in the Shanghai ACR:

| Consumer | Base image |
| --- | --- |
| Server and Web build stage | `welltop/node-base:22-slim-pnpm-10.12.4` |
| Web runtime | `welltop/nginx-base:1.27-alpine` |
| Default `auto-story-v2` sandbox | Clean Shanghai ACS `code-interpreter` image, pinned in `sandbox/auto-story-v2/versions.json` |

Prepare or refresh the bases from the `vfs-dev` checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && deploy/scripts/build-base-images.sh --push'
```

Existing tags are skipped. Add `--force` only when intentionally rebuilding a
base tag. The script accepts `node` or `nginx` to process a subset.

A normal application release starts from a clean, committed checkout:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && bash build.sh --push server web'
```

The default image tag is the current 12-character Git SHA. Local caches under
`.buildx-cache/` keep dependency layers warm across builds. BuildKit also keeps
architecture-specific pnpm stores and npm download caches on the selected
builder. Reuse that builder between releases; deleting it or pruning its cache
requires downloading dependencies again. Cache mounts survive failed installs,
but are not included in the published runtime image or the local layer export.

Web source edits reuse the manifest-only install layer. Server dependencies,
adapter dependencies, and Pi extensions are separate stages, so a Server-only
dependency change does not reinstall Pi extensions. Extensions install in
separate cached steps and prefer already downloaded packages. Check the build
output for `CACHED`; a second unchanged build should perform no installations.
ACR builds disable provenance attestations because this registry rejects the
BuildKit attestation manifest format.

The Web image uses
the same-origin `/api` endpoint by default; override it with `WEB_API_URL` only
when building for a different ingress layout.

Build the default sandbox with the same release entrypoint. Its recipe fetches
checksum-verified upstream releases, builds FFmpeg, and runs offline image
acceptance before pushing:

```bash
ssh vfs-dev \
  'cd ~/workspace/yuzhong/open-managed-agents && \
   deploy/scripts/build-images.sh --push --tag <tag> sandbox'
```

This produces `oma-sandbox:auto-story-v2-<tag>`. The standalone recipe defaults to
its versioned release tag; see [the sandbox recipe](../sandbox/auto-story-v2/README.md)
for preparation, version pins and image checks. `AUTO_STORY_BASE_IMAGE` can
override the clean base for this wrapper; it must satisfy the recipe's checks.

Both build scripts support `--dry-run`. A dirty checkout is rejected unless
`--allow-dirty` is explicit; auto-tagged dirty builds include a UTC timestamp so
they cannot be mistaken for the commit image.

## Deployment scripts

Validate a newly published application release against `agent-platform`:

```bash
deploy/scripts/deploy-app.sh --tag <tag>
```

This performs a server-side dry-run by default. Production mutation requires
both flags deliberately:

```bash
deploy/scripts/deploy-app.sh --tag <tag> --apply --confirm-production
```

The script always renders the image placeholders into a temporary manifest and
validates the complete resource set. Its apply path then patches only the two
Deployment image fields, waits for both rollouts, prints the running images,
and checks `/api/health`. Routine releases therefore cannot accidentally
rewrite the ConfigMap, Services, or Ingress. The rendered manifest is deleted
on exit and is never committed.

SandboxSet validation and deployment use the same safety gate:

```bash
# Default auto-story-v2 pool: dry-run only
deploy/scripts/deploy-sandbox.sh
deploy/scripts/deploy-sandbox.sh --image <immutable-image> --apply --confirm-production

```

Pool deployment does not change the Server's `SANDBOX_TEMPLATE` setting.
The ConfigMap and the SDK fallback default to `auto-story-v2`; explicit Agent
template selection still takes precedence. Existing Session sandboxes need a
rebuild or a new Session to pick up a changed image or template.

## What the repository owns

`app/` and `environments/` declare the running split API/Runner, Web and
Ingress for both environments (see [Environments](#environments)); only the test
overlay also creates Redis. `k8s.yaml` is the legacy combined-Server manifest.
Neither creates production Redis,
sing-box, RDS, Workspace OSS, Skill Supabase Storage, the ALB controller, or the
ACK sandbox-manager installation.

`OMA_SERVER_IMAGE` and `OMA_WEB_IMAGE` in the manifest are release-time
placeholders rendered by `deploy/scripts/deploy-app.sh`. Do not apply the raw
manifest or commit credentials or rendered manifests.

Production uses `PG_ENSURE_SCHEMA=false`; apply the idempotent SQL files in
`migrations/` with a privileged database operator before rolling out code that
depends on a new migration.

## Cluster access and verification

### Durable delegation release (#133–#141)

See [the production verification report](../docs/verification/durable-delegation-release-2026-09-16.md) and `scripts/verify-durable-delegations.mjs` for the real Pi/Sandbox release checks.

Apply `migrations/0012_durable_delegations.sql` before the Host image. Verify
the application role can read all six `delegation_*` tables and the new
Session/pending-input columns. Update the `server` container image. Production
loads settings and extensions from `/opt/pi-agent-seed` in that image; the
`oma-pi-gateway` Secret mounts `auth.json` and `models.json` there read-only.
There is no seed init container or writable Pi configuration volume.

For the first cutover, stop ingress to the old Host and stop its scheduler;
wait for its active Turns to drain before starting the new image. The release
must not mix the plugin and Host-owned tools. The old implementation's in-memory
child identifiers cannot be migrated. Existing tool summaries remain readable;
queries using those expired identifiers explicitly fail.

New deployments register only `Agent`, `get_subagent_result`, and
`steer_subagent`. `run_in_background` defaults to false for both creation and
resume. `SUBAGENT_MAX_CONCURRENT` defaults to 4 per parent Session and
`SUBAGENT_MAX_MODEL_STEPS` defaults to 500 (maximum 1000). These count concurrent
child Turns and model steps respectively; waiting parents consume no child slot.
The Host assigns its configured budget to each new or resumed execution; the
Agent tool accepts no budget override. Exhaustion returns `budget_exhausted`;
only an explicit resume starts a fresh budget. The live verification script’s
`budget` phase requires a dedicated verification Host configured with
`SUBAGENT_MAX_MODEL_STEPS=1`, also set in the script environment.

Monitor `delegation_executions.record` for `status`, `notificationStatus`,
`pendingEventId`, and the effective model configuration. `queued` inputs use the
ordinary pending-input recovery scan; `running` records are fenced by that
input's owner and generation. An expired child lease becomes
`recovery_required`, never successful partial commentary. Inspect its complete
tool history and external task identifiers before an explicit resume. Saved
Workspace files remain available independently of that status.

`delegation_waits` identifies the original parent Turn and tool call and
records that Turn's model and thinking. With the complete event log, this lets a
replacement Host continue that same Turn; a non-wait tool with an uncertain
outcome is reported and not replayed.
`subagent.result` is a visible result notification. Only
`subagent.result_claimed` enters the model's history. An accepted Interrupt is
reported as `requested`; the canonical aborted Turn confirms actual stopping.

After release, validate health and authenticated API reads, then exercise a
synchronous child, an asynchronous child that finishes after its parent,
result wakeup, cross-Host resume, steer, Interrupt, full execution traces and
usage. Check failure and budget-exhaustion results separately from file saves.

### Sandbox binding reconciliation on oma-test (#292)

Live acceptance of [ADR-0023](../docs/adr/0023-sandbox-binding-reconciliation.md) on the
test environment only. `scripts/verify-sandbox-reconcile.mjs` runs in the oma-test API
Pod: it refuses any schema but `oma_test` and any base URL but
`https://agentry-test.welltop.tech/api`, creates its own tenant with a temporary API key
per phase, reads only its own Sessions (plus aggregate counts in `migration`), only
SELECTs inside READ ONLY transactions, and never kills, scales or restarts anything. It
prints `DISRUPT_NOW ...` where the operator acts. `scripts/run-sandbox-reconcile-acceptance.sh`
is the operator side: it copies the script into a fresh `/tmp` directory of the API Pod,
runs one phase without `kubectl exec -i` (output written after stdin's EOF is lost on
these ACS Pods), checks the script's end marker and copies the evidence back (mode 0600)
after every phase. It also finds the Runner Pod that holds a Turn (`owner`), `kill -9`s a
Runner's node process (`kill-runner`) and summarizes `sandbox_sweep` log lines
(`sweep-logs`). The script header lists every assumption about event and API shapes that
must be re-checked once #284–#291 land; they are collected in its `SHAPES` object.

The test Agent uses the separate SandboxSet `sandbox-system/oma-scale-test-20261021` and
blanks business credentials and URLs in `sandbox.env`, as the 2026-10-21 burst did, so the
burst does not drain the shared `auto-story-v2` pool. With 5 warm replicas, about 195 of 200
creates are cold starts; check cluster capacity first. Run phases one at a time and do not
interrupt them.

```bash
export KUBECONFIG=~/.kube/agent-platform-config
export OMA_RECONCILE_EVIDENCE=~/oma-292/evidence.json; mkdir -p ~/oma-292
R=deploy/scripts/run-sandbox-reconcile-acceptance.sh

# 1. Read-only sweep report before the release.
deploy/scripts/run-sandbox-sweep-report.sh test > ~/oma-292/report-before.md
# 2. Rollback images, then no Runner: no create may be in flight during the migration.
kubectl -n oma-test get deploy oma-api oma-runner oma-web \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}' | tee ~/oma-292/rollback-images.txt
kubectl -n oma-test scale deploy/oma-runner --replicas=0
kubectl -n oma-test wait --for=delete pod -l app=oma-runner --timeout=180s
$R migration pre                       # no live claim; records the pending rows
# 3. Migration 0024 (#284; confirm the file name), reviewed, applied by the privileged
#    migration operator as in "Test migrations". Prepare its rollback SQL the same way.
node deploy/scripts/migration-for-env.mjs test deploy/migrations/0024_<name>.sql > ~/oma-292/0024-test.sql
# 4. The new image, built on vfs-dev from the release commit (see "Image pipeline"), then
#    "Test releases": the full manifest also returns oma-runner to 2 replicas. deploy-app.sh
#    targets production only.
node deploy/scripts/render.mjs test API_VERSION RUNNER_VERSION WEB_VERSION > /tmp/oma-test.yaml
kubectl diff -f /tmp/oma-test.yaml; kubectl apply -f /tmp/oma-test.yaml
for d in redis oma-api oma-runner oma-web; do kubectl -n oma-test rollout status deploy/$d; done
curl -fsS https://agentry-test.welltop.tech/api/health | jq -e 'select(.status == "ok")'
$R migration post                      # creation_pending gone, every pending row Creating(epoch)
# 5. Burst with a rolling restart during creation.
kubectl -n sandbox-system get sandboxset oma-scale-test-20261021
$R init
$R burst 200                           # on DISRUPT_NOW, in another terminal:
#   date -u +%FT%TZ; kubectl -n oma-test rollout restart deploy/oma-runner && kubectl -n oma-test rollout status deploy/oma-runner
$R mark rollout-restart <time printed by date>
$R check                               # up to 25 min; exit 1 names every failed acceptance check
# 6. kill -9 during creation. A warm claim ends Creating within seconds; emptying the test
#    pool first makes the create a cold start (~110 s). Restore it right after the kill, so a
#    re-create after reconciliation can take a warm Sandbox again.
kubectl -n sandbox-system get sandboxset oma-scale-test-20261021 -o jsonpath='{.spec.replicas}'   # note it
kubectl -n sandbox-system patch sandboxset oma-scale-test-20261021 --type merge -p '{"spec":{"replicas":0}}'
$R kill-start                          # on CLAIMED: $R owner <session>  → OWNER_POD
                                       # on DISRUPT_NOW: $R kill-runner <OWNER_POD>  → KILLED_AT
$R mark kill <KILLED_AT>               # fails if the binding was no longer Creating
kubectl -n sandbox-system patch sandboxset oma-scale-test-20261021 --type merge -p '{"spec":{"replicas":<noted>}}'
$R kill-finish
# 7. After one sweeper period (10 min with jitter) since kill-finish:
deploy/scripts/run-sandbox-sweep-report.sh test > ~/oma-292/report-after.md
node deploy/scripts/verify-sandbox-reconcile.mjs report-rows "$OMA_RECONCILE_EVIDENCE" ~/oma-292/report-after.md
#    then wait for the next round of either Runner and compare it with that report:
$R sweep-logs 90m ~/oma-292/report-after.md
$R migration after-sweep
# 8. Termination reclaims by binding; the report shows what is left on the gateway.
$R cleanup
deploy/scripts/run-sandbox-sweep-report.sh test > ~/oma-292/report-cleanup.md
node deploy/scripts/verify-sandbox-reconcile.mjs report-rows "$OMA_RECONCILE_EVIDENCE" ~/oma-292/report-cleanup.md
$R finish                              # deletes the run directory from the API Pod
```

| #292 acceptance | Evidence |
| --- | --- |
| Old column dropped; pending rows reconciled | `migration post`; `migration after-sweep`; `unresolved` 0 in the report after a period (Creating(epoch) rows without a Sandbox reconcile on first use) |
| 200 + rolling restart: no binding Creating past its deadline, no Turn ending with `sandbox_unavailable` | `check` (also: every Turn completed and used its Sandbox; prepare p50/p95/max, tool error codes, takeovers, `environment.state`) |
| No orphan after one sweep | `report-rows` on the report after one period: no `kill` or `adopt` row of this run |
| kill -9 during create: tools again within 180 s of the takeover | `kill-start`, `mark kill`, `kill-finish` (also within 180 s + 60 s of the intent) |
| `sandbox_sweep` periodic and equal to the read-only report | `sweep-logs`: consecutive rounds 5–15 min apart, the first round after the report equals its planned counters |

`sweep-logs` reads the current and previous container of each Runner Pod that exists; Pods
replaced by the rolling restart have taken their logs with them, and a restart resets a
Runner's schedule. Write the result to `docs/verification/sandbox-reconcile-oma-test-<date>.md`
with the evidence JSON. Rollback: Runners to 0, the rollback SQL through
`migration-for-env.mjs test`, then the images in `rollback-images.txt` through `render.mjs test`.

### Shared native sandbox credentials

The Host reads `sandbox-system/base-secret` at startup and supplies its valid
environment-variable keys to E2B `Sandbox.create({ envs })` for every Agent,
including newly created Agents. A SandboxSet's Kubernetes `env` alone does not
populate the E2B command environment. No shell profile or `ACS_SYNC_ENVS` bridge
is used by this integration.

The existing Secret is the source; no cross-namespace copy is maintained.
`source.env` and other file-like keys are excluded. Values remain in Host memory
and E2B's runtime environment, never in Agent records or Host `process.env`.
The dedicated Host ServiceAccount can only `get` this one Secret:

```bash
kubectl --kubeconfig ~/.kube/agent-platform-config apply -f deploy/sandbox-base-secret-rbac.yaml
```

The application manifest sets `serviceAccountName: oma-server` and the complete
`SANDBOX_BASE_SECRET_NAMESPACE` / `SANDBOX_BASE_SECRET_NAME` pair. A configured
but unavailable Secret prevents startup; omission of both settings disables the
integration for local development. HTTPS requests use the ServiceAccount CA and
bypass the outbound LLM proxy.

For an existing deployment, patch these two ConfigMap keys and the Deployment's
ServiceAccount together with the updated Server image; routine image-only
releases do not update those fields. Do not apply the full application manifest
just to enable credentials, because unrelated live configuration may differ.

Precedence remains explicit: legacy deployment defaults < base Secret < Agent
`sandbox.env` < explicitly scoped WW values < fixed Workspace environment. The
existing `oma-auto-story-env` only supplements keys absent from the base Secret,
so old preset copies cannot override a rotated shared credential. Without a
base Secret, the legacy preset retains its original behavior. Values explicitly
configured on an Agent still override shared defaults.

After Secret rotation, roll the Host. Its next Turn creates a new sandbox for an
existing Session using the fresh values; Workspace files stay in OSS. Updating
the Secret does not mutate environments of already running processes. Verify
with E2B `commands.run()` and only emit presence/equality booleans, never values.

Use the dedicated kubeconfig instead of whichever context happens to be the
local default:

```bash
KUBECONFIG=~/.kube/agent-platform-config kubectl get nodes
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra get deploy,svc,ingress
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset
```

After applying a release, verify both application rollouts and the sandbox warm
pool:

```bash
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra rollout status deploy/oma-server
KUBECONFIG=~/.kube/agent-platform-config kubectl -n oma-infra rollout status deploy/oma-web
KUBECONFIG=~/.kube/agent-platform-config kubectl -n sandbox-system get sandboxset auto-story-v2
```

Only `auto-story-v2` is maintained. Its recipe and SandboxSet manifest live in
[`sandbox/`](../sandbox/README.md). Shared Workspace infrastructure lives in
[`deploy/oss-workspace/`](oss-workspace/README.md). Retired templates and business
Agent presets are not shipped here; supply business Skills through the platform.

The manifest was aligned with the Shanghai deployment on 2026-09-16, including
its direct Pi gateway mounts, internal E2B endpoints, proxy overrides and Host
4 CPU / 8 GiB limits. Secrets are referenced by name only. The existing
`oma-auto-story-env` compatibility injection is still used by three Agents and
is retained until those settings are migrated. Removing repository presets
must not silently remove their deployed credentials.
