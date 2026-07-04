import { describe, it, expect } from "vitest";
import { InProcessEventStreamHub } from "../src/event-stream-hub.js";

async function readNext(reader: ReadableStreamDefaultReader<string>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) throw new Error("Stream ended unexpectedly");
  return value;
}

describe("InProcessEventStreamHub", () => {
  it("publish sends SSE frame to subscriber", async () => {
    const hub = new InProcessEventStreamHub();
    const { stream } = hub.subscribe("sess_1");
    const reader = stream.getReader();

    hub.publish("sess_1", { type: "agent.message", seq: 1, data: { text: "hello" } });

    const frame = await readNext(reader);
    expect(frame).toBe(
      `event: agent.message\nid: 1\ndata: {"text":"hello"}\n\n`,
    );

    reader.releaseLock();
  });

  it("publish without seq omits id field", async () => {
    const hub = new InProcessEventStreamHub();
    const { stream } = hub.subscribe("sess_1");
    const reader = stream.getReader();

    hub.publish("sess_1", { type: "agent.status", data: { status: "running" } });

    const frame = await readNext(reader);
    expect(frame).toBe(
      `event: agent.status\ndata: {"status":"running"}\n\n`,
    );

    reader.releaseLock();
  });

  it("publishChunk merges turnId + blockIndex into the delta frame for alignment", async () => {
    const hub = new InProcessEventStreamHub();
    const { stream } = hub.subscribe("sess_1", { includeChunks: true });
    const reader = stream.getReader();

    hub.publishChunk("sess_1", {
      type: "agent.message_chunk",
      data: { type: "agent.message_chunk", text: "hi" },
      turnId: "turn_1",
      blockIndex: 2,
    });

    const frame = await readNext(reader);
    expect(frame.startsWith("event: agent.message_chunk\n")).toBe(true);
    const dataLine = frame.split("\n").find((l) => l.startsWith("data: "))!.slice("data: ".length);
    expect(JSON.parse(dataLine)).toEqual({
      type: "agent.message_chunk",
      text: "hi",
      turnId: "turn_1",
      blockIndex: 2,
    });

    reader.releaseLock();
  });

  it("publishChunk respects includeChunks option", async () => {
    const hub = new InProcessEventStreamHub();

    const { stream: streamWithChunks } = hub.subscribe("sess_1", { includeChunks: true });
    const { stream: streamWithout } = hub.subscribe("sess_1");

    const readerWith = streamWithChunks.getReader();
    const readerWithout = streamWithout.getReader();

    hub.publishChunk("sess_1", { type: "agent.chunk", data: { delta: "hi" } });

    const frame = await readerWith.read();
    expect(frame.value).toBe(
      `event: agent.chunk\ndata: {"delta":"hi"}\n\n`,
    );

    // The non-chunk subscriber should not receive anything
    // We publish a normal event to verify the other subscriber is still alive
    hub.publish("sess_1", { type: "agent.done", seq: 1, data: {} });

    const normalFrame = await readerWithout.read();
    expect(normalFrame.value).toBe(
      `event: agent.done\nid: 1\ndata: {}\n\n`,
    );

    readerWith.releaseLock();
    readerWithout.releaseLock();
  });

  it("fan-out to multiple subscribers", async () => {
    const hub = new InProcessEventStreamHub();

    const { stream: stream1 } = hub.subscribe("sess_1");
    const { stream: stream2 } = hub.subscribe("sess_1");

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    hub.publish("sess_1", { type: "agent.message", seq: 5, data: { text: "broadcast" } });

    const frame1 = await readNext(reader1);
    const frame2 = await readNext(reader2);

    const expected = `event: agent.message\nid: 5\ndata: {"text":"broadcast"}\n\n`;
    expect(frame1).toBe(expected);
    expect(frame2).toBe(expected);

    reader1.releaseLock();
    reader2.releaseLock();
  });

  it("unsubscribe stops delivery", async () => {
    const hub = new InProcessEventStreamHub();

    const { stream, unsubscribe } = hub.subscribe("sess_1");
    const reader = stream.getReader();

    hub.publish("sess_1", { type: "agent.message", seq: 1, data: { text: "first" } });
    const frame = await readNext(reader);
    expect(frame).toContain("first");

    unsubscribe();

    // After unsubscribe, stream should be closed
    const result = await reader.read();
    expect(result.done).toBe(true);
  });

  it("publish to session with no subscribers is a no-op", () => {
    const hub = new InProcessEventStreamHub();
    // Should not throw
    hub.publish("sess_nonexistent", { type: "agent.message", seq: 1, data: {} });
    hub.publishChunk("sess_nonexistent", { type: "agent.chunk", data: {} });
  });

  it("cleans up session entry when last subscriber unsubscribes", () => {
    const hub = new InProcessEventStreamHub();

    const { unsubscribe: unsub1 } = hub.subscribe("sess_1");
    const { unsubscribe: unsub2 } = hub.subscribe("sess_1");

    unsub1();
    // Session still has one subscriber, internal map should still have entry
    // (We can verify indirectly by publishing and checking no error)
    hub.publish("sess_1", { type: "test", seq: 1, data: {} });

    unsub2();
    // Now session should be cleaned up; publish is still a no-op
    hub.publish("sess_1", { type: "test", seq: 2, data: {} });
  });
});
