import { afterEach, describe, expect, it } from "vitest";
import { createRedisClient, RedisSessionSignals, type RedisClient } from "@oma-server/redis";
import { RedisEventStreamHub } from "@oma-server/event-log";
import { createMemoryStores } from "@oma-server/store-memory";
import type { EnvironmentBinding, EnvironmentLockResult } from "@oma-server/store";
import { BINDING_REREAD_MS, DefaultSandboxManager, FakeSandboxClient, type EnvSpec, type SandboxEnvironmentBinding } from "@oma-server/sandbox";
import { environmentSignals } from "../src/lib/environment-signals.js";

// Opt-in: real Pub/Sub on a disposable Redis (REDIS_TEST_URL); never a shared instance.
const url = process.env.REDIS_TEST_URL;
const spec: EnvSpec = { tenantId: "t", workspaceId: "w", workspaceMount: {
  bucket: "agentry", prefix: "t/w/", agentName: "agent", pvName: "pv", credentialProviderName: "credentials",
} };
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
};

describe.skipIf(!url)("a binding's environment hint between Runners over a real Redis (ADR-0023)", () => {
  const clients: RedisClient[] = [];
  const closes: (() => void)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) close();
    for (const client of clients.splice(0)) await client.quit();
  });
  /** One Runner process's signals, as bootstrap wires them: its own connections; output published, never relayed. */
  const runnerSignals = async (namespace: string) => {
    const client = createRedisClient({ url });
    await client.connect();
    clients.push(client);
    const signals = new RedisSessionSignals(client, namespace);
    const output = new RedisEventStreamHub(signals, { relay: false });
    closes.push(() => { output.close(); signals.close(); });
    return signals;
  };

  it("continues a Child Session's waiting Turn as soon as the parent's Runner records the Sandbox, each Runner subscribed to the control channel only", async () => {
    const namespace = `environment-${Date.now()}`;
    const stores = createMemoryStores();
    const gateway = new FakeSandboxClient();
    const runner = async () => new DefaultSandboxManager({
      sandboxClient: gateway, environment: "test", environmentSignals: environmentSignals(await runnerSignals(namespace)),
    });
    const [parentRunner, childRunner] = [await runner(), await runner()];
    /** A Turn's binding over the shared store, counting the Turn's reads of the row. */
    const binding = () => {
      const counted = {
        id: "root", reads: 0,
        withLock<T>(work: (row: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
          counted.reads++;
          return stores.delegationStore.withEnvironmentLock("root", work);
        },
      };
      return counted satisfies SandboxEnvironmentBinding;
    };
    const subscribers = async () => {
      const [, control, , output] = await clients[0].pubsub("NUMSUB", `${namespace}:session-control`, `${namespace}:session-output`) as [string, number, string, number];
      return { control, output };
    };
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let stalled = false;
    gateway.createFault = async (step) => { if (step === "claim" && !stalled) { stalled = true; await released; } };

    const parent = parentRunner.open(spec, binding()).writeFile("parent.txt", "parent");
    await until(() => stalled);
    const child = binding();
    const tool = childRunner.open(spec, child).writeFile("child.txt", "child");
    await until(() => child.reads === 1);
    await until(async () => (await subscribers()).control === 2);

    const releasedAt = Date.now();
    release();
    await tool;
    // The hint, not the re-read after 2 s, ended the wait.
    expect(Date.now() - releasedAt).toBeLessThan(BINDING_REREAD_MS / 2);
    expect(child.reads).toBe(2);
    await parent;
    expect(gateway.created).toHaveLength(1);
    expect(await subscribers()).toEqual({ control: 2, output: 0 });
  });
});
