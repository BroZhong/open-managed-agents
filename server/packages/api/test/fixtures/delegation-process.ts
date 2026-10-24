import { randomUUID } from "node:crypto";
import { createPgPool, pgConfigFromEnv, createPgStores, PgSandboxLifecycleStore } from "@oma-server/store";
import { createRedisClient, RedisSessionSignals, BestEffortTurnStreamStore, RedisTurnStreamStore } from "@oma-server/redis";
import { RedisEventStreamHub } from "@oma-server/event-log";
import { DefaultSandboxManager, DefaultTurnSandboxes, FakeSandboxClient } from "@oma-server/sandbox";
import { SessionRouter } from "@oma-server/session-router";
import type { Adapter, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { startExecution } from "../../src/execution.js";
import { InMemoryArtifactStore, InMemorySkillBundleStore } from "@oma-server/store-memory";

const pool = createPgPool(pgConfigFromEnv());
const stores = await createPgStores(pool, { ensureSchema: false });
const redis = createRedisClient({ url: process.env.REDIS_URL }, { enableOfflineQueue: false, maxRetriesPerRequest: 0, commandTimeout: 250 });
redis.on("error", () => {}); void redis.connect().catch(() => {});
const signals = new RedisSessionSignals(redis, process.env.REDIS_NAMESPACE);
const eventStreamHub = new RedisEventStreamHub(signals, { relay: false });
const turnStreamStore = new BestEffortTurnStreamStore(new RedisTurnStreamStore(redis), () => redis.status === "ready");
const event = (type: string, data: object): SessionEvent => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (value: string) => event("agent.message", { content: [{ type: "text", text: value }] });
const adapter: Adapter = { async run(input) {
  const write = journalWriter(input);
  if (input.execution?.isChild) { await write(text(`child PID ${process.pid}; model ${input.agent.model}; budget ${input.execution.maxModelSteps}`)); return "finished"; }
  if (input.message.source === "subagent_result") { await write(text(`async result handled PID ${process.pid}`)); return "finished"; }
  const call = event("agent.tool_use", { toolUseId: "cross-process", name: "Agent", input: { prompt: "child" } });
  await write(call);
  const output = await input.subagents!.delegate({ prompt: "child", runInBackground: process.env.DELEGATION_MODE === "async" }, { toolUseId: "cross-process" });
  await write(event("agent.tool_result", { toolUseId: "cross-process", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }));
  await write(text(`parent PID ${process.pid}`));
  return "finished";
} };
const activities = new PgSandboxLifecycleStore(pool);
const client = new FakeSandboxClient();
// External cleanup fault injection has a process-independent observer.
if (process.env.TEST_DELETE_URL) {
  const deleted = new Set<string>();
  client.state = async id => deleted.has(id) ? 'missing' : 'running';
  client.reconnect = async () => true;
  client.destroy = async id => {
    const response = await fetch(`${process.env.TEST_DELETE_URL}/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Injected gateway delete failure");
    deleted.add(id);
  };
}
const sandboxManager = new DefaultSandboxManager({ sandboxClient: client, lifecycle: activities, environment: "test" });
const workspaceMount = { bucket: "test", agentName: "test", pvName: "test", credentialProviderName: "test" };
const deps = { ...stores, pool, signals, eventStreamHub, turnStreamStore, local: true,
  artifactStore: new InMemoryArtifactStore(), skillBundleStore: new InMemorySkillBundleStore() };
if (process.env.PARENT_SESSION_ID) {
  // A deterministic existing owner. Only the other OS process scans for children.
  const router = new SessionRouter({ ...deps, resolveAdapter: () => adapter,
    sandboxes: new DefaultTurnSandboxes({ manager: sandboxManager, bindings: stores.delegationStore, sessions: stores.sessionStore, workspaceMount }),
    wakeSession: sessionId => signals.publish({ sessionId, kind: "wake" }),
    checkSession: sessionId => signals.publish({ sessionId, kind: "check" }) });
  // As RunnerDispatch does: the child's Runner hints this owner when the child ends.
  signals.subscribe("control", signal => { if (signal.kind === "check") router.checkNow(signal.sessionId); });
  const session = (await stores.sessionStore.getById(process.env.PARENT_SESSION_ID))!;
  await router.handleNewEvent(session.id, session.agent);
  console.log("parent completed");
} else {
  await startExecution(deps, { sandboxManager, workspaceMount, resolveAdapter: () => adapter });
  console.log("fixture runner ready");
}
