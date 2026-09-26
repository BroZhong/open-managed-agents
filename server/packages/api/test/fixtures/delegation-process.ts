import { randomUUID } from "node:crypto";
import { createPgPool, pgConfigFromEnv, createPgStores, PgSandboxLifecycleStore } from "@oma-server/store";
import { createRedisClient, RedisSessionSignals, BestEffortTurnStreamStore, RedisTurnStreamStore } from "@oma-server/redis";
import { RedisEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, FakeSandboxClient } from "@oma-server/sandbox";
import { SessionRouter } from "@oma-server/session-router";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { startExecution } from "../../src/execution.js";
import { InMemoryArtifactStore, InMemorySkillArtifactStore } from "@oma-server/store-memory";

const pool = createPgPool(pgConfigFromEnv());
const stores = await createPgStores(pool, { ensureSchema: false });
const redis = createRedisClient({ url: process.env.REDIS_URL }, { enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 250 });
redis.on("error", () => {}); void redis.connect().catch(() => {});
const signals = new RedisSessionSignals(redis, process.env.REDIS_NAMESPACE);
const eventStreamHub = new RedisEventStreamHub(signals);
const turnStreamStore = new BestEffortTurnStreamStore(new RedisTurnStreamStore(redis), () => redis.status === "ready");
const event = (type: string, data: object): SessionEvent => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (value: string) => event("agent.message", { content: [{ type: "text", text: value }] });
const adapter: Adapter = { async *run(input) {
  if (input.execution?.isChild) { yield text(`child PID ${process.pid}; model ${input.agent.model}; budget ${input.execution.maxModelSteps}`); return; }
  if (input.message.source === "subagent_result") { yield text(`async result handled PID ${process.pid}`); return; }
  const call = event("agent.tool_use", { toolUseId: "cross-process", name: "Agent", input: { prompt: "child" } });
  yield call;
  const output = await input.subagents!.delegate({ prompt: "child", runInBackground: process.env.DELEGATION_MODE === "async" }, { toolUseId: "cross-process", checkpoint: [call] });
  yield event("agent.tool_result", { toolUseId: "cross-process", content: [{ type: "text", text: JSON.stringify(output) }], isError: false });
  yield text(`parent PID ${process.pid}`);
} };
const activities = new PgSandboxLifecycleStore(pool);
const client = new FakeSandboxClient();
// External cleanup fault injection has a process-independent observer.
if (process.env.TEST_DELETE_URL) {
  client.reconnect = async () => {};
  client.destroy = async id => {
    const response = await fetch(`${process.env.TEST_DELETE_URL}/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Injected gateway delete failure");
  };
}
const sandboxManager = new DefaultSandboxManager({ sandboxClient: client, provisionSources: {}, executionActivities: {
  begin: activity => activities.begin(activity), finish: activity => activities.finish(activity),
} });
const workspaceMount = { bucket: "test", agentName: "test", pvName: "test", credentialProviderName: "test" };
const deps = { ...stores, pool, signals, eventStreamHub, turnStreamStore, local: true,
  artifactStore: new InMemoryArtifactStore(), skillArtifactStore: new InMemorySkillArtifactStore() };
if (process.env.PARENT_SESSION_ID) {
  // A deterministic existing owner. Only the other OS process scans for children.
  const router = new SessionRouter({ ...deps, sandboxManager, workspaceMount, resolveAdapter: () => adapter,
    wakeSession: sessionId => signals.publish({ sessionId, kind: "wake" }) });
  const session = (await stores.sessionStore.getById(process.env.PARENT_SESSION_ID))!;
  await router.handleNewEvent(session.id, session.agent);
  console.log("parent completed");
} else {
  await startExecution(deps, { sandboxManager, workspaceMount, resolveAdapter: () => adapter });
  console.log("fixture runner ready");
}
