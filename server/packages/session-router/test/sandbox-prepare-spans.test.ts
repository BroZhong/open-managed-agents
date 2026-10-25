import { describe, expect, it } from "vitest";
import { SandboxUnavailable } from "@oma-server/sandbox";
import type { StoredEvent } from "@oma-server/store";
import type { JournalEvent } from "../src/turn-journal.js";
import { SandboxVerdict, PREPARE_TURN_ENDED, SandboxPrepareSpans, unendedSandboxPrepares } from "../src/sandbox-prepare-spans.js";

const stored = (seq: number, type: string, data: object): StoredEvent =>
  ({ sessionId: "s", seq, type, data, ts: new Date(), sessionThreadId: "sthr_primary" }) as unknown as StoredEvent;
const start = (seq: number, prepareId: string) => stored(seq, "span.sandbox_prepare_start", { turnId: "t", prepareId });
const end = (seq: number, prepareId: string, outcome: string) => stored(seq, "span.sandbox_prepare_end", { turnId: "t", prepareId, outcome });
/** A tool call's native result as Pi records it, a Sandbox unavailability's carrying its code. */
const result = (seq: number, details?: Record<string, string>, isError = details !== undefined) => stored(seq, "agent.context_entry",
  { turnId: "t", entry: { type: "message", id: `e${seq}`, message: { role: "toolResult", toolCallId: `call_${seq}`, isError, details } } });
const unavailability = { code: "sandbox_unavailable", reason: "unreachable" };
const unavailable = (events: StoredEvent[]) => SandboxVerdict.of(events).unavailable;

function spans(events: StoredEvent[] = []) {
  const written: Array<{ event: JournalEvent; key: string }> = [];
  const prepares = new SandboxPrepareSpans({ turnId: "t", generation: 3, events, write: (event, key) => written.push({ event, key }) });
  return { prepares, written };
}

describe("a Turn attempt's Sandbox preparation spans (ADR-0023)", () => {
  it("writes a start and an end per preparation, named and keyed by the attempt", () => {
    const { prepares, written } = spans();
    prepares.started();
    prepares.ended({ outcome: "failed", error: new SandboxUnavailable("unreachable") });
    prepares.started();
    prepares.ended({ outcome: "ready", sandboxId: "sbx-1" });
    expect(written.map(({ event, key }) => [key, event.type, event.data])).toEqual([
      ["sandbox_prepare:3.1:start", "span.sandbox_prepare_start", { turnId: "t", prepareId: "3.1" }],
      ["sandbox_prepare:3.1:end", "span.sandbox_prepare_end", { turnId: "t", prepareId: "3.1", outcome: "failed",
        code: "sandbox_unavailable", reason: "unreachable", durationMs: expect.any(Number) }],
      ["sandbox_prepare:3.2:start", "span.sandbox_prepare_start", { turnId: "t", prepareId: "3.2" }],
      ["sandbox_prepare:3.2:end", "span.sandbox_prepare_end", { turnId: "t", prepareId: "3.2", outcome: "ready", sandboxId: "sbx-1", durationMs: expect.any(Number) }],
    ]);
  });

  it("judges the Sandbox unavailable once a tool call met a failure, until a preparation is ready, deferred and aborted ones changing nothing", () => {
    const { prepares } = spans();
    expect(prepares.unavailable()).toBe(false);
    prepares.started();
    prepares.ended({ outcome: "failed", error: new SandboxUnavailable("rejected", 403) });
    // No tool call waited for it: a pure-chat Turn's failed connect.
    expect(prepares.unavailable()).toBe(false);
    prepares.toolFailed();
    expect(prepares.unavailable()).toBe(true);
    prepares.started();
    prepares.ended({ outcome: "aborted", reason: new DOMException("Session interrupted", "AbortError") });
    prepares.started();
    prepares.ended({ outcome: "deferred" });
    expect(prepares.unavailable()).toBe(true);
    prepares.started();
    prepares.ended({ outcome: "ready", sandboxId: "sbx-1" });
    expect(prepares.unavailable()).toBe(false);
    // A failure no failed preparation stands behind is one the ready one repaired.
    prepares.toolFailed();
    expect(prepares.unavailable()).toBe(false);
  });

  it("starts from what earlier attempts of the Turn left: their spans and their tool results", () => {
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed")])).toBe(false);
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), result(3, unavailability)])).toBe(true);
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), result(3, unavailability), start(4, "1.2"), end(5, "1.2", "ready")])).toBe(false);
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), result(3, unavailability), start(4, "2.1"), end(5, "2.1", "aborted")])).toBe(true);
    // A takeover's failed connect no tool call waited for leaves a repaired Sandbox available.
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), result(3, unavailability), start(4, "1.2"), end(5, "1.2", "ready"),
      start(6, "2.1"), end(7, "2.1", "failed")])).toBe(false);
    // Pi records a step's results after the step: a later call's preparation repaired this failure.
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), start(3, "1.2"), end(4, "1.2", "ready"), result(5, unavailability), result(6)])).toBe(false);
    // A tool's own failure, or another code, is no Sandbox unavailability.
    expect(unavailable([start(1, "1.1"), end(2, "1.1", "failed"), result(3, { code: "ENOENT" }), result(4, undefined, true)])).toBe(false);
    expect(spans([start(1, "1.1"), end(2, "1.1", "failed"), result(3, unavailability)]).prepares.unavailable()).toBe(true);
    expect(unendedSandboxPrepares([start(1, "1.1"), end(2, "1.1", "failed"), start(3, "1.2")])).toEqual([{ turnId: "t", prepareId: "1.2" }]);
  });

  it("ends a preparation still running at the Turn's end as aborted, then records nothing more", () => {
    const { prepares, written } = spans();
    prepares.started();
    prepares.endTurn();
    prepares.ended({ outcome: "ready", sandboxId: "sbx-1" });
    prepares.started();
    expect(written.map(({ event }) => event.data)).toEqual([
      { turnId: "t", prepareId: "3.1" },
      { turnId: "t", prepareId: "3.1", outcome: "aborted", reason: PREPARE_TURN_ENDED, durationMs: expect.any(Number) },
    ]);
  });

  it("records nothing more once its attempt stopped: the takeover ends what it started", () => {
    const { prepares, written } = spans();
    prepares.started();
    prepares.close();
    prepares.ended({ outcome: "ready", sandboxId: "sbx-1" });
    expect(written.map(({ event }) => event.type)).toEqual(["span.sandbox_prepare_start"]);
  });
});
