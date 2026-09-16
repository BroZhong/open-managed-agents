import { describe, expect, it } from "vitest";
import { RedisTurnStreamStore, type TurnStreamStore } from "../src/turn-stream-store.js";
import { InMemoryTurnStreamStore } from "../src/in-memory-turn-stream-store.js";
import { FakeRedis } from "./fake-redis.js";

describe.each([
  ["Redis", () => new RedisTurnStreamStore(new FakeRedis())],
  ["memory", () => new InMemoryTurnStreamStore()],
] as const)("%s Session stream isolation", (_name, createStore) => {
  it("isolates concurrent Sessions with identical Turn and block IDs, including reclaim and resume", async () => {
    const store: TurnStreamStore = createStore();
    const turnId = "turn_1_a1";
    const sessions = ["parent", "child", "other-tenant-session"];
    const firstIds = await Promise.all(sessions.map(async sessionId => {
      await store.setActiveTurn(sessionId, { turnId, status: "running" });
      return store.appendDelta(sessionId, { turnId, blockIndex: 0, type: "agent.tool_use_input_chunk", data: { text: `${sessionId}-private` } });
    }));
    await Promise.all(sessions.map(sessionId => store.appendDelta(sessionId, { turnId, blockIndex: 0, type: "agent.tool_use_input_chunk", data: { text: `${sessionId}-more` } })));
    for (const [index, sessionId] of sessions.entries()) {
      expect(await store.deltaCount(sessionId, turnId)).toBe(2);
      expect((await store.readDeltas(sessionId, turnId)).map(delta => delta.data)).toEqual([{ text: `${sessionId}-private` }, { text: `${sessionId}-more` }]);
      expect((await store.readDeltas(sessionId, turnId, firstIds[index])).map(delta => delta.data)).toEqual([{ text: `${sessionId}-more` }]);
    }
    await store.reclaim("parent", turnId);
    expect(await store.readDeltas("parent", turnId)).toEqual([]);
    expect(await store.deltaCount("child", turnId)).toBe(2);
    expect(await store.deltaCount("other-tenant-session", turnId)).toBe(2);
    expect(await store.getActiveTurn("child")).toEqual({ turnId, status: "running" });
  });
  it("does not allow delimiters in IDs to alias a different Session stream", async () => {
    const store = createStore();
    await store.appendDelta("a:turn:b", { turnId: "c", blockIndex: 0, type: "chunk", data: "private" });
    expect(await store.readDeltas("a", "b:turn:c")).toEqual([]);
  });
});

it("never replays or deletes legacy global streams whose Session ownership is unknown", async () => {
  const redis = new FakeRedis();
  await redis.xadd("stream:turn:turn_1_a1", "*", "turnId", "turn_1_a1", "type", "chunk", "data", '"unowned"');
  const store = new RedisTurnStreamStore(redis);
  expect(await store.readDeltas("child", "turn_1_a1")).toEqual([]);
  await store.reclaim("child", "turn_1_a1");
  expect(redis.hasStream("stream:turn:turn_1_a1")).toBe(true);
});
