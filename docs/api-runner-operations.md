# API and Runner operations

The split was deployed on September 24, 2026; see the
[production verification report](verification/api-runner-release-2026-09-24.md).
The commands below remain the runbook for subsequent authorized releases. Keep
paused model-release automations paused. The compatible combined Deployment is
retained at zero replicas for rollback; public traffic targets `oma-api`.

## Commands and configuration

From `server/packages/api` in the same server image:

| Role | Command | Readiness | Credentials |
| --- | --- | --- | --- |
| API | `node --import tsx src/api-server.ts` | `/api/ready` with production base path | PG, Redis, Workspace OSS, Supabase Skills, auth/invite |
| Runner | `node --import tsx src/runner-server.ts` | `/ready`, port 3001 | PG, Redis, storage, model, managed MCP, Sandbox/gateway and Sandbox Secret RBAC |
| Combined bridge | `node --import tsx src/dev-server.ts` | `/api/ready` | Both sets |

API readiness checks PG after startup storage validation. Runner also requires a
recent successful pending-input scan. `/health` is the separate process liveness
probe. Redis does not gate readiness. Configure the same PG schema, Redis and
`REDIS_NAMESPACE` for all roles. Runner alone requires mount/gateway configuration
and loads the shared Sandbox Secret. API alone requires user-login credentials.

`PENDING_SCAN_INTERVAL_MS=5000`, `LOOP_POLL_INTERVAL_MS=15000`, and
`SSE_CATCHUP_INTERVAL_MS=2000` are independent. Healthy wake hints normally allow
claiming without waiting for a scan. A running Turn renews its claim every 10 s
(30 s lease); the renewal also reports an accepted Interrupt. The API's `check`
hint makes the owner renew at once, so an Interrupt takes effect within about a
second while Redis is healthy and within 10 s without it. PostgreSQL is the only
pending queue and history authority. Redis contains disposable Deltas, active-Turn projections and
notifications. Outages lose temporary token animation, never committed answers.
A Turn's Delta stream expires 30 minutes after its last append, so streams left
behind by a lost Runner need no manual cleanup.

Stopping a Runner (rollout, scale-down, `kubectl delete pod`) hands its running
Turns to the other Runners (ADR-0021). On SIGTERM it stops scanning and claiming
and asks each running Turn to stop before its next model request: a tool that is
running finishes and keeps its result. A Turn still in a tool when
`SHUTDOWN_GRACE_MS` (20 s) runs out is detached; its Sandbox process is not
stopped, and the next owner tells the Agent that call's outcome is unknown. Each
claim is released and another Runner takes the Turn over at once on the `wake`
signal, or within one scan without Redis; the trace shows a `session.turn_resumed`
with reason `released`. Releasing the claims may take up to 5 s after the grace
period, so keep the Pod's termination grace period at the Kubernetes default of
30 s or more. A handoff needs another Runner to continue the Turn: with a single
Runner, the Turn continues when the replacement Pod is ready. On the test
cluster's virtual kubelet, `kubectl delete pod --force --grace-period=0` still
delivers SIGTERM, so it tests the handoff; to test a lost Runner (lease expiry,
reason `expired`), kill the process with SIGKILL inside the container.

The first split release uses one API and one Runner. `deploy/app/api-runner.yaml`
provides separate ConfigMaps, Deployments, readiness probes and internal Services;
`deploy/environments/` adds each environment's namespace and configuration.
API Pods have no Pi config mount or Sandbox service account. The legacy
`oma-server` Service is not declared; the production overlay routes `/api` to it
as the live Ingress does.

Tenant model-provider configuration requires migration `0016_model_providers.sql`
and the same `OMA_PROVIDER_ENCRYPTION_KEY` Secret reference in API and Runner.
API lazily loads Pi only for an authenticated provider discovery/test request;
startup still does not load Pi or execution infrastructure. Runner decrypts the
selected Tenant provider for each Turn. The API does not need the managed Pi
catalog or Sandbox credentials for these user-supplied provider probes.

## Local debugging

Install the adapter and server dependencies, then run from the repository root:

```sh
pnpm --dir adapter install --frozen-lockfile
pnpm --dir server install --frozen-lockfile
pnpm dev:split
```

Docker Compose starts dedicated loopback PG (55432) and Redis (56379), then
independent API (3000) and Runner (3001) OS processes. Ctrl-C stops both application
process groups; infrastructure stays available until
`docker compose -f server/compose.local.yaml down`.

The explicit `OMA_LOCAL_INFRA=true` profile requires a loopback `PG_URL` whose
database name starts with `oma_local`; it never inherits a production database.
It uses real PG/Redis, mock model output, and process-local disposable file/Skill
stores. Create an Agent with runtime `mock`, model `mock-model`, a system prompt,
and `sandbox.enabled=false`. This profile is for coordination tests, not persistent
Workspace or real model testing. Local HTTP auth is disabled.

For real model/Sandbox integration, omit `OMA_LOCAL_INFRA`. Supply the existing
Workspace OSS and Supabase Skills configuration to both roles, and provider/Pi,
E2B, mounted Workspace and shared-Secret configuration to Runner only. These
external credentials and services are not required by automated tests.

Run independent-process acceptance against the local containers:

```sh
SPLIT_TEST_PG_URL=postgres://oma_local:oma_local@127.0.0.1:55432/oma_local \
SPLIT_TEST_REDIS_URL=redis://127.0.0.1:56379 \
SPLIT_TEST_REDIS_CONTAINER=oma-split-local-redis-1 \
pnpm test:split
```

Tests reject remote endpoints and non-local database names, use a random schema,
and remove it afterwards. The optional container name enables stop/start fault
injection against that dedicated Redis only. Tests without these variables skip;
normal unit suites do not connect to production. Model and gateway boundaries in
cross-Runner delegation/cleanup cases use scripted fixtures in separate processes.

## Staging and production cutover checklist

Use `kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra`
explicitly. The following commands are for the separately authorized release:

1. Record current Host/Web images, Service selectors, active Session/Turn IDs,
   pending depth, and controlled Sandbox lifecycle configuration. Back up the
   database. The native lifecycle in ADR-0019 requires migration 0020 with old Runners
   stopped. There is no Sandbox sweeper or lifecycle environment switch.
   The split manifest does not own these externally injected values.
2. Apply `deploy/migrations/0015_api_runner_split.sql` using the existing migration
   process. It adds the cleanup outbox and app-role grants, and discovers older
   terminated Sessions. It does not rewrite events or remove columns.
3. Publish a compatible combined bridge image from this implementation before
   splitting production. Verify it with the same local acceptance suite. An upgrade
   from the pre-split Host retains the existing shutdown/recovery limits; do not
   describe it as a seamless restart of an ordinary in-flight Turn.
4. Render reviewed immutable image tags independently, then stage both roles:

   ```sh
   node deploy/scripts/render.mjs production API_VERSION RUNNER_VERSION WEB_VERSION > /tmp/oma-split.yaml
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra diff -f /tmp/oma-split.yaml
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra apply -f /tmp/oma-split.yaml
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra rollout status deployment/oma-api
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra rollout status deployment/oma-runner
   ```

5. On staging (the `oma-test` environment in `deploy/README.md`) first, scale to two APIs and two Runners. Submit to one API while
   streaming from both; reconnect through the other API. Verify one promoted input,
   increasing unique durable sequences, complete final output and idle status.
   Delete one API Pod during a long Turn; its Runner must continue. Stop Redis and
   verify queued acceptance, completed output on open pages and restored Deltas
   after Redis restarts. Test Interrupt and termination from the other API.
6. Verify the supported version matrix: bridge-v1 + API-v1, API-v1 + Runner-v1,
   and previous **compatible protocol-v1** API + candidate Runner and candidate
   API + previous compatible Runner. The repository tests the bridge and split
   commands; every later image pair needs its own staging run. Arbitrary historical
   versions, especially pre-split API readers, are unsupported.
7. Route new requests to API after the bridge/split checks pass:

   ```sh
   kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra patch service oma-server \
     --type merge -p '{"spec":{"selector":{"app":"oma-api"}}}'
   ```

   SSE connections may disconnect and replay from PG. A bridge or Runner of a
   release with the shutdown handoff (ADR-0021) hands its running Turns to the
   other Runners as it stops; wait for the Turns of an older one to settle before
   retiring it. Observe PG claim owners and remaining pending work.
8. Roll API and Runner images independently with the normal deployment process.
   Confirm updating API does not change Runner Pod UIDs or interrupt active Turns.
   Confirm separate image tags in the rendered manifest. Keep Web independent;
   its additive termination-event handling lets open pages reflect remote deletion.
9. Record cleanup retries (`session_cleanup`), unknown activity retention
   (`sandbox_activities`), PG scan failures and the real image-pair evidence.
   Return initial production counts to one API/one Runner after staging scale tests.

## Rollback and recovery

Route the Service back to the **compatible bridge** and scale split roles down only
under the existing Turn shutdown/recovery policy. Leave migration 0015 installed;
it is additive. Do not roll readers back before ADR-0016 native-event support or
mix pre-split processes with split Runners. A Turn whose Runner exits is
continued by the next Runner that claims its input (ADR-0021), at once when the
Runner was stopped gracefully; queued unstarted inputs remain durable. API
rollbacks do not require Runner restarts.

Cleanup errors leave retryable rows. Lease loss is not execution settlement and
does not request idle; native finite deadlines remain in force. Explicit termination
can directly kill the resource after legitimate shared users are gone. Follow
ADR-0019; no permanent activity table or resource sweeper remains. Saved Workspace
files and history survive termination.


## Repeatable release regression

`deploy/scripts/verify-api-runner-release.mjs` runs inside a deployed image with
`node --import tsx`. Copy it into a stable Runner Pod and run `init` once with an
absolute evidence-file path. It creates its own tenant and revokes each temporary
API key. The default target is the public production URL; set `OMA_LIVE_BASE_URL`
for an isolated staging API and `VERIFY_SCHEMA=oma_split_stage` for its database
(`VERIFY_SCHEMA=oma_test` with `https://agentry-test.welltop.tech/api` for the test environment).
Do not point staging Runners at the production schema or Redis for fault injection.

Run phases in order: `basic`, `real-start`, `real-finish`, `interrupt`,
`delegation-sync`, `delegation-async`, `loop`, `terminate`, `active-terminate`, and
`cleanup`. For example, after copying the script into the Pod:

Run `cleanup` even if an earlier verification phase fails. It first disables the
verification Loop, attempts every verification Session (including completed
Children), and reports all cleanup failures. Cleanup success does not turn a
failed verification phase into a pass.

```sh
kubectl --kubeconfig "$HOME/.kube/agent-platform-config" -n oma-infra \
  exec deployment/oma-runner -- env HTTP_PROXY= http_proxy= \
  node --import tsx /tmp/verify-api-runner-release.mjs basic /tmp/split-evidence.json
```

Copy evidence off the Pod before replacing it. Use `OMA_API_TARGETS` with two
comma-separated API Pod URLs for dual-observer checks. The `outage` phase checks
PG-backed completion while **isolated staging Redis** is stopped; rerun `basic`
after recovery to require live deltas again. The script does not stop Redis or
restart workloads itself. Wait for old Runner Pods to disappear before measuring
normal termination cleanup: a task claimed by an exiting owner is an owner-loss
case and preserves legitimate shared users before direct termination cleanup.
