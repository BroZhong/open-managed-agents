import { describe, expect, it } from "vitest";
import type { SessionSignal, SessionSignalScope, SessionSignals } from "@oma-server/redis";
import { RedisEventStreamHub } from "../src/redis-event-stream-hub.js";

class RecordingSignals implements SessionSignals {
  readonly published: SessionSignal[] = [];
  readonly scopes: SessionSignalScope[] = [];
  private listener?: (signal: SessionSignal) => void;
  publish(signal: SessionSignal): void { this.published.push(signal); }
  subscribe(scope: SessionSignalScope, listener: (signal: SessionSignal) => void): () => void {
    this.scopes.push(scope);
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  deliver(signal: SessionSignal): void { this.listener?.(signal); }
}

describe("RedisEventStreamHub", () => {
  it("relays output signals to this process's live streams", async () => {
    const signals = new RecordingSignals();
    const hub = new RedisEventStreamHub(signals);
    const reader = hub.subscribe("sess_1", { includeChunks: true }).stream.getReader();

    signals.deliver({ sessionId: "sess_1", kind: "chunk", chunk: { type: "agent.message_chunk", data: { text: "hi" }, deltaId: "1-0" } });

    expect(signals.scopes).toEqual(["output"]);
    expect((await reader.read()).value).toContain(`"text":"hi"`);
  });

  it("only publishes without relay, as a Runner does", () => {
    const signals = new RecordingSignals();
    const hub = new RedisEventStreamHub(signals, { relay: false });

    hub.publish("sess_1", { type: "agent.message", seq: 3, data: {} });
    hub.publishChunk("sess_1", { type: "agent.message_chunk", data: { text: "hi" }, turnId: "turn_1", blockIndex: 0, attempt: 1, deltaId: "1-0" });

    expect(signals.scopes).toEqual([]);
    expect(signals.published).toEqual([
      { sessionId: "sess_1", kind: "durable" },
      { sessionId: "sess_1", kind: "chunk", chunk: { type: "agent.message_chunk", data: { text: "hi" }, turnId: "turn_1", blockIndex: 0, attempt: 1, deltaId: "1-0" } },
    ]);
  });
});
