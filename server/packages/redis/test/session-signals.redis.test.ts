import { afterEach, describe, expect, it } from "vitest";
import { createRedisClient, type RedisClient } from "../src/index.js";
import { RedisSessionSignals, type SessionSignal } from "../src/session-signals.js";

// Opt-in: real Pub/Sub on a disposable Redis (REDIS_TEST_URL); never a shared instance.
const url = process.env.REDIS_TEST_URL;
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("condition not reached");
};

describe.skipIf(!url)("RedisSessionSignals on a real Redis", () => {
  const clients: RedisClient[] = [];
  const signals: RedisSessionSignals[] = [];
  /** One process's signals: its own command connection plus the subscriber it duplicates. */
  const host = async (namespace: string) => {
    const client = createRedisClient({ url });
    await client.connect();
    clients.push(client);
    const created = new RedisSessionSignals(client, namespace);
    signals.push(created);
    return created;
  };
  const subscribers = async (namespace: string) => {
    const [, control, , output] = await clients[0].pubsub("NUMSUB", `${namespace}:session-control`, `${namespace}:session-output`) as [string, number, string, number];
    return { control, output };
  };
  afterEach(async () => {
    for (const created of signals.splice(0)) created.close();
    for (const client of clients.splice(0)) await client.quit();
  });

  it("delivers control signals only to control subscribers and output signals only to output subscribers", async () => {
    const ns = `signals-${Date.now()}-a`;
    const runner = await host(ns), api = await host(ns);
    const controls: SessionSignal[] = [], outputs: SessionSignal[] = [];
    runner.subscribe("control", signal => controls.push(signal));
    api.subscribe("output", signal => outputs.push(signal));
    await until(async () => (await subscribers(ns)).control === 1 && (await subscribers(ns)).output === 1);

    api.publish({ sessionId: "s", kind: "wake" });
    runner.publish({ sessionId: "s", kind: "chunk", chunk: { type: "agent.message_chunk", data: { text: "a" }, deltaId: "1-0" } });
    api.publish({ sessionId: "s", kind: "check" });
    runner.publish({ sessionId: "s", kind: "durable" });
    await until(() => controls.length === 2 && outputs.length === 2);
    await new Promise(r => setTimeout(r, 50)); // and nothing else arrives

    expect(controls.map(s => s.kind)).toEqual(["wake", "check"]);
    expect(outputs).toEqual([
      { sessionId: "s", kind: "chunk", chunk: { type: "agent.message_chunk", data: { text: "a" }, deltaId: "1-0" } },
      { sessionId: "s", kind: "durable" },
    ]);
  });

  it("subscribes a scope's channel only once a listener for it arrives", async () => {
    const ns = `signals-${Date.now()}-b`;
    const runner = await host(ns);
    await new Promise(r => setTimeout(r, 100)); // the subscriber connection is ready
    expect(await subscribers(ns)).toEqual({ control: 0, output: 0 });

    runner.subscribe("control", () => {});
    await until(async () => (await subscribers(ns)).control === 1);
    expect(await subscribers(ns)).toEqual({ control: 1, output: 0 });
  });
});
