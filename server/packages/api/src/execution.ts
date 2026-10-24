import { SessionRouter } from "@oma-server/session-router";
import { DefaultSandboxManager, DefaultTurnSandboxes, E2BSandboxClient, SandboxSweeper, type SandboxManager, type WorkspaceMountSpec } from "@oma-server/sandbox";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { PgSessionCleanupStore, type PgStores, type Pool, type ArtifactStore, type SkillBundleStore, type OSSArtifactStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { SessionSignals, TurnStreamStore } from "@oma-server/redis";
import { runtimeAdapters } from "./lib/runtime-adapters.js";
import { workspaceConfigFromEnv } from "./lib/workspace-config.js";
import { sandboxBaseEnvFromKubernetes } from "./lib/sandbox-base-secret.js";
import { sandboxEnvPolicyFromHost } from "./lib/sandbox-env.js";
import { sandboxLifecycle } from "./lib/sandbox-lifecycle.js";
import { environmentSignals } from "./lib/environment-signals.js";
import { LoopScheduler } from "./lib/loop-scheduler.js";
import { RunnerDispatch } from "./lib/runner-dispatch.js";
import { MockAdapter } from "@open-managed-agents/adapter-mock";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { ModelProviderService } from "./lib/model-providers.js";

export async function startExecution(deps: PgStores & {
  pool: Pool; local: boolean; signals: SessionSignals; artifactStore: ArtifactStore;
  skillBundleStore: SkillBundleStore; eventStreamHub: EventStreamHub; turnStreamStore: TurnStreamStore;
}, execution?: { resolveAdapter(runtime: string): Adapter | undefined; sandboxManager: SandboxManager; workspaceMount: Omit<WorkspaceMountSpec, "prefix"> }) {
  const proxyUrl = process.env.OMA_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl && !deps.local) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  const workspaceConfig = deps.local ? undefined : workspaceConfigFromEnv(process.env);
  const sandboxEnvPolicy = deps.local ? {} : sandboxEnvPolicyFromHost(process.env, await sandboxBaseEnvFromKubernetes(process.env));
  const modelProviders = new ModelProviderService(deps.modelProviderStore, process.env.OMA_PROVIDER_ENCRYPTION_KEY);
  const piAgentAdapter = new PiAgentAdapter({ configureModelRuntime: modelProviders.configureRuntime(deps.sessionStore) });
  // The packaged mock emits model spans and text chunks; lifecycle events stay
  // owned by the SessionRouter. The local infrastructure profile runs only mock.
  const mockAdapter = new MockAdapter({ delayMs: Number(process.env.MOCK_DELAY_MS ?? 75) });
  // The gateway, the native lifecycle and the environment hints the Sandbox
  // Manager and the sweeper share.
  const native = !execution?.sandboxManager && workspaceConfig ? {
    client: new E2BSandboxClient({
      ...workspaceConfig.sandbox,
      verifyWorkspaceProbe: async (target, name, content) => {
        if (target.bucket !== workspaceConfig.oss.bucket) throw new Error("Workspace bucket mismatch");
        await (deps.artifactStore as OSSArtifactStore).verifyWorkspaceProbe(target.prefix, name, content);
      },
    }),
    environment: workspaceConfig.environment,
    lifecycle: await sandboxLifecycle(deps.pool),
    // A Turn waiting for a binding another Runner creates or reclaims continues on its hint.
    hints: environmentSignals(deps.signals),
  } : undefined;
  const sandboxManager = execution?.sandboxManager ?? (native ? new DefaultSandboxManager({
    sandboxClient: native.client, environment: native.environment, lifecycle: native.lifecycle, environmentSignals: native.hints,
    // Signs install URLs for the OSS internal endpoint; Sandboxes download bundles themselves.
    skillBundleStore: deps.skillBundleStore,
  }) : undefined);
  const workspaceMount = execution?.workspaceMount ?? workspaceConfig?.mount;
  const reportDrainFailure = (failure: { sessionId: string; error: unknown }) => console.error("Runner drain failed:", failure);
  // The Turn side of the Sandbox protocol (ADR-0023): the Router only acquires
  // and releases leases; bindings, resource uses and activity live behind it.
  const sandboxes = sandboxManager && workspaceMount ? new DefaultTurnSandboxes({
    manager: sandboxManager, bindings: deps.delegationStore, sessions: deps.sessionStore, workspaceMount, ...sandboxEnvPolicy,
    onError: reportDrainFailure,
  }) : undefined;
  const router = new SessionRouter({
    ...deps, sandboxes,
    resolveAdapter: execution?.resolveAdapter ??
      runtimeAdapters(deps.local ? { mock: mockAdapter } : { "pi-agent": piAgentAdapter, mock: mockAdapter }),
    wakeSession: sessionId => deps.signals.publish({ sessionId, kind: "wake" }),
    checkSession: sessionId => deps.signals.publish({ sessionId, kind: "check" }),
    maxConcurrentSubagents: Number(process.env.SUBAGENT_MAX_CONCURRENT ?? 4),
    maxSubagentModelSteps: Number(process.env.SUBAGENT_MAX_MODEL_STEPS ?? 500),
    onDrainError: reportDrainFailure,
  });
  const cleanup = new PgSessionCleanupStore(deps.pool);
  const dispatch = new RunnerDispatch({
    router, sessions: deps.sessionStore, signals: deps.signals,
    scanIntervalMs: Number(process.env.PENDING_SCAN_INTERVAL_MS ?? 5000),
    cleanup: () => cleanup.sweep(id => router.cleanupTerminatedSession(id)),
  });
  await dispatch.start();
  const loops = new LoopScheduler({ loopStore: deps.loopStore, sessionRouter: router, pollIntervalMs: Number(process.env.LOOP_POLL_INTERVAL_MS ?? 15_000) });
  loops.start();
  // Only Runners sweep their environment's Sandboxes (ADR-0023): a round every
  // 10 minutes ± 2, the first at a random point, each written as one
  // `sandbox_sweep` log line. Shutdown stops it before its next action. It
  // kills a Sandbox a binding records by reclaiming the binding through the
  // Runner's Sandbox Manager, as termination does.
  const sweeper = native && sandboxManager ? new SandboxSweeper({
    client: native.client, facts: native.lifecycle, bindings: deps.delegationStore, manager: sandboxManager,
    environment: native.environment, environmentSignals: native.hints,
  }) : undefined;
  sweeper?.start();
  return { router, ready: () => dispatch.ready, stop: async () => { await Promise.all([dispatch.stop(), loops.stop(), sweeper?.stop()]); } };
}
