import { describe, it, expect } from "vitest";
import { InMemoryPendingEventStore } from "@oma-server/store-memory";

/**
 * The Queued Input lifecycle end to end (issue #114).
 *
 * The per-operation tests each cover one transition; this walks a whole queue
 * through claim → ack → claim → ack to pin the property the console depends on:
 * an input is either queued or executing, never both, and nothing lingers in the
 * queued view once the Turn that ran it has finished. A regression here surfaces
 * in the UI as a `queued` row that never clears.
 */
describe("Queued Input lifecycle", () => {
  it("reports an entry as queued until a Turn claims it, and never after", async () => {
    const store = new InMemoryPendingEventStore();
    const first = await store.enqueue("s1", {
      type: "user.message",
      data: { n: 1 },
      sessionThreadId: "t",
    });
    const second = await store.enqueue("s1", {
      type: "user.message",
      data: { n: 2 },
      sessionThreadId: "t",
    });

    const queuedIds = async () =>
      (await store.listUnclaimed("s1", 20)).map((event) => event.id);

    // Nothing claimed yet: the user is waiting on both.
    expect(await queuedIds()).toEqual([first.id, second.id]);

    // A drainer claims the head. Claiming promotes it into the event log, so it
    // is executing — history, not queued.
    const claim = await store.claim("s1", "host", 60_000);
    expect(await queuedIds()).toEqual([second.id]);

    // The Turn completes and acknowledges. The tail is untouched: a completed
    // Turn and an Interrupted one both leave queued input to run next.
    expect(await store.ack("s1", first.id, claim!)).toBe(true);
    expect(await queuedIds()).toEqual([second.id]);

    // The tail runs and finishes. Nothing queued, and no residue afterwards.
    const tailClaim = await store.claim("s1", "host", 60_000);
    expect(await queuedIds()).toEqual([]);
    expect(await store.ack("s1", second.id, tailClaim!)).toBe(true);
    expect(await queuedIds()).toEqual([]);
    expect(await store.count("s1")).toBe(0);
  });

  it("counts an entry as waiting again once its lease lapses", async () => {
    // A lapsed lease is not an executing Turn: the holder lost ownership and its
    // Turn is torn down (SessionRouter aborts on a failed renew), so this input
    // really is waiting for whoever claims it next. Reporting it as queued is the
    // honest answer, not a residue.
    const store = new InMemoryPendingEventStore();
    const event = await store.enqueue("s1", {
      type: "user.message",
      data: { n: 1 },
      sessionThreadId: "t",
    });

    const claim = await store.claim("s1", "host_a", 20);
    expect(await store.listUnclaimed("s1", 20)).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await store.listUnclaimed("s1", 20)).map((e) => e.id)).toEqual([event.id]);
    // And the stale owner can no longer renew or acknowledge it.
    expect(await store.renewClaim("s1", event.id, claim!, 1_000)).toBe(false);
    expect(await store.ack("s1", event.id, claim!)).toBe(false);
  });
});
