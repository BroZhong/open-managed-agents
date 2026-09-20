import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { restorePiSession } from "../src/pi-context.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;
const assistant = (text: string, timestamp: number) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }],
  api: model.api, provider: model.provider, model: model.id,
  usage: { input: 32, output: 8, cacheRead: 12, cacheWrite: 4, totalTokens: 56,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } },
  stopReason: "stop" as const, timestamp,
});
const record = (entry: unknown): SessionEvent => ({ id: `event-${(entry as {id: string}).id}`, timestamp: "2026-09-20T00:00:00Z", type: "agent.context_entry", sdk: "pi@0.83.0", turnId: "t1", entry } as SessionEvent);

describe("Pi event-log reconstruction through the native SessionManager", () => {
  it("preserves adjacent assistant boundaries, usage, timestamps and signed thinking", () => {
    const original = SessionManager.inMemory();
    original.appendMessage({ role: "user", content: "hello", timestamp: 11 });
    original.appendMessage({ ...assistant("one", 12), content: [{ type: "thinking", thinking: "reason", thinkingSignature: "signature" }, { type: "text", text: "one" }] });
    original.appendMessage(assistant("two", 13));
    const restored = restorePiSession(JSON.parse(JSON.stringify(original.getEntries().map(record))));
    expect(restored.buildSessionContext()).toEqual(original.buildSessionContext());
    expect(restored.getEntries().map(e => e.id)).toEqual(original.getEntries().map(e => e.id));
  });
  it("restores native messages once alongside legacy history and rendered duplicates", () => {
    const legacy = [{ id: "legacy-user", type: "user.message", content: [{ type: "text", text: "old" }] }] as unknown as SessionEvent[];
    const live = restorePiSession(legacy);
    const prefixLength = live.getEntries().length;
    live.appendMessage({ role: "user", content: "new", timestamp: 10 });
    live.appendMessage(assistant("answer", 20));
    const native = live.getEntries().slice(prefixLength).map(entry => ({ ...record(entry), inputEventId: "input-new" }));
    const history = [...legacy,
      { id: "input-new", type: "user.message", content: [{ type: "text", text: "new" }] },
      { id: "display", type: "agent.message", turnId: "t1", content: [{ type: "text", text: "answer" }] },
      ...native];
    expect(restorePiSession(history as SessionEvent[]).buildSessionContext()).toEqual(live.buildSessionContext());
  });

  it("keeps only the latest native summary after two compactions and duplicate checkpoint replay", () => {
    const live = SessionManager.inMemory();
    live.appendMessage({ role: "user", content: "old prefix", timestamp: 1 });
    live.appendMessage(assistant("old answer", 2));
    const kept = live.appendMessage({ role: "user", content: "retained", timestamp: 3 });
    live.appendCompaction("S1", kept, 500);
    live.appendMessage(assistant("after S1", 4));
    const newest = live.appendMessage({ role: "user", content: "latest", timestamp: 5 });
    live.appendCompaction("S2", newest, 600);
    const entries = live.getEntries().map(record);
    const restored = restorePiSession([...entries, ...entries]);
    expect(restored.buildSessionContext()).toEqual(live.buildSessionContext());
    expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain("old prefix");
    expect(JSON.stringify(restored.buildSessionContext().messages)).not.toContain("S1");
    expect(restored.getEntries().filter(e => e.type === "compaction")).toHaveLength(2);
  });

});
