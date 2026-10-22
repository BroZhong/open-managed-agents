import { describe, expect, it } from "vitest";
import { createMemoryStores } from "../src/index.js";

/**
 * D7: an Interrupt targets the Session's running Turn, whether or not a
 * Runner holds its claim right now: a Turn whose Runner was lost or handed
 * it over still runs as far as the user can tell. The next claim applies it.
 */
describe("InMemoryPendingEventStore Interrupt acceptance", () => {
  const input = { type: "user.message", data: {}, sessionThreadId: "sthr_primary" };

  it("D7 accepts an Interrupt for a head whose claim lapsed, and reports it to the claim that takes over", async () => {
    const { pendingEventStore: store } = createMemoryStores();
    await store.enqueue("sess", input);
    await store.claim("sess", "lost-runner", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.requestInterrupt("sess")).toBe(true);
    expect(await store.claim("sess", "takeover", 60_000)).toMatchObject({ generation: 2, previous: "expired", priorInterrupt: true });
  });

  it("D7 accepts an Interrupt for a head whose claim was released, and reports it to the next claim", async () => {
    const { pendingEventStore: store } = createMemoryStores();
    await store.enqueue("sess", input);
    const handedOver = (await store.claim("sess", "stopping-runner", 60_000))!;
    await store.releaseClaim("sess", handedOver.event.id, handedOver);
    expect(await store.requestInterrupt("sess")).toBe(true);
    expect(await store.claim("sess", "takeover", 60_000)).toMatchObject({ generation: 2, previous: "released", priorInterrupt: true });
  });

  it("refuses an Interrupt while no Turn has claimed the head", async () => {
    const { pendingEventStore: store } = createMemoryStores();
    expect(await store.requestInterrupt("sess")).toBe(false);
    await store.enqueue("sess", input);
    expect(await store.requestInterrupt("sess")).toBe(false);
    expect(await store.claim("sess", "runner", 60_000)).toMatchObject({ generation: 1, priorInterrupt: false });
  });
});
