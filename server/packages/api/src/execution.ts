import { SessionRouter } from "@oma-server/session-router";
import { DefaultSandboxManager, E2BSandboxClient, S3ProvisionSource, type SandboxManager, type WorkspaceMountSpec } from "@oma-server/sandbox";
import type { Adapter } from "@open-managed-agents/adapter-core";
import { PgSessionCleanupStore, PgSandboxLifecycleStore, type PgStores, type Pool, type ArtifactStore, type SkillArtifactStore, type OSSArtifactStore } from "@oma-server/store";
import type { EventStreamHub } from "@oma-server/event-log";
import type { SessionSignals, TurnStreamStore } from "@oma-server/redis";
import { resolveAdapter } from "./lib/runtime-adapters.js";
import { workspaceConfigFromEnv } from "./lib/workspace-config.js";
import { sandboxBaseEnvFromKubernetes } from "./lib/sandbox-base-secret.js";
import { sandboxEnvPolicyFromHost } from "./lib/sandbox-env.js";
import { sandboxLifecycle, startSandboxSweeper } from "./lib/sandbox-lifecycle.js";
import { LoopScheduler } from "./lib/loop-scheduler.js";
import { RunnerDispatch } from "./lib/runner-dispatch.js";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { ModelProviderService } from "./lib/model-providers.js";

export async function startExecution(deps: PgStores & {
  pool: Pool; local: boolean; signals: SessionSignals; artifactStore: ArtifactStore;
  skillArtifactStore: SkillArtifactStore; eventStreamHub: EventStreamHub; turnStreamStore: TurnStreamStore;
}, execution?: { resolveAdapter(runtime: string): Adapter; sandboxManager: SandboxManager; workspaceMount: Omit<WorkspaceMountSpec, "prefix"> }) {
  const proxyUrl = process.env.OMA_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl && !deps.local) {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  }
  const workspaceConfig = deps.local ? undefined : workspaceConfigFromEnv(process.env);
  const sandboxEnvPolicy = deps.local ? {} : sandboxEnvPolicyFromHost(process.env, await sandboxBaseEnvFromKubernetes(process.env));
  const activities = new PgSandboxLifecycleStore(deps.pool);
  const modelProviders = new ModelProviderService(deps.modelProviderStore, process.env.OMA_PROVIDER_ENCRYPTION_KEY);
  const piAgentAdapter = new PiAgentAdapter({ configureModelRuntime: modelProviders.configureRuntime(deps.sessionStore) });
  const sandboxManager = execution?.sandboxManager ?? (workspaceConfig ? new DefaultSandboxManager({
    executionActivities: { begin: activity => activities.begin(activity), finish: activity => activities.finish(activity) },
    sandboxClient: new E2BSandboxClient({
      ...workspaceConfig.sandbox,
      verifyWorkspaceProbe: async (target, name, content) => {
        if (target.bucket !== workspaceConfig.oss.bucket) throw new Error("Workspace bucket mismatch");
        await (deps.artifactStore as OSSArtifactStore).verifyWorkspaceProbe(target.prefix, name, content);
      },
    }),
    lifecycle: await sandboxLifecycle(deps.pool),
    provisionSources: { s3: new S3ProvisionSource(deps.skillArtifactStore) },
  }) : undefined);
  const router = new SessionRouter({
    ...deps, sandboxManager, workspaceMount: execution?.workspaceMount ?? workspaceConfig?.mount, ...sandboxEnvPolicy,
    resolveAdapter: execution?.resolveAdapter ?? (runtime => {
      if (deps.local && runtime !== "mock") throw new Error("Local infrastructure profile executes only mock Agents");
      return runtime === "pi-agent" ? piAgentAdapter : resolveAdapter(runtime);
    }),
    wakeSession: sessionId => deps.signals.publish({ sessionId, kind: "wake" }),
    maxConcurrentSubagents: Number(process.env.SUBAGENT_MAX_CONCURRENT ?? 4),
    maxSubagentModelSteps: Number(process.env.SUBAGENT_MAX_MODEL_STEPS ?? 500),
    onDrainError: failure => console.error("Runner drain failed:", failure),
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
  const stopSweep = sandboxManager
    ? startSandboxSweeper(async () => { await sandboxManager.sweepIdle?.(); }, error => console.error("Sandbox sweep failed:", error)) : () => {};
  return { router, ready: () => dispatch.ready, stop: async () => { stopSweep(); await Promise.all([dispatch.stop(), loops.stop()]); } };
}
