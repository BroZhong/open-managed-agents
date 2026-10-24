import { describe, expect, it, vi } from "vitest";
import { sessionSignalScope, type SessionSignal, type SessionSignalScope, type SessionSignals } from "@oma-server/redis";
import type { SessionRouter } from "@oma-server/session-router";
import type { SessionStore } from "@oma-server/store";
import { RunnerDispatch } from "../src/lib/runner-dispatch.js";

class Signals implements SessionSignals {
  private readonly listeners = new Set<{ scope: SessionSignalScope; listener: (signal: SessionSignal) => void }>();
  publish(signal: SessionSignal): void {
    for (const { scope, listener } of this.listeners) if (scope === sessionSignalScope(signal.kind)) listener(signal);
  }
  subscribe(scope: SessionSignalScope, listener: (signal: SessionSignal) => void): () => void {
    const entry = { scope, listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }
}

describe("RunnerDispatch", () => {
  it("passes a check hint to the Router at once, even while a wake for the Session is being handled", async () => {
    const signals = new Signals();
    const drain = new Promise<void>(() => {}); // The Session's drain is still running.
    const router = {
      handleNewEvent: vi.fn(() => drain),
      checkNow: vi.fn(),
      recoverPendingEvents: vi.fn(async () => ({ recovered: [], discarded: [], failed: [] })),
    };
    const sessions = { getById: vi.fn(async (id: string) => ({ id, status: "running", agent: {} })) };
    const dispatch = new RunnerDispatch({
      router: router as unknown as SessionRouter, sessions: sessions as unknown as SessionStore, signals, scanIntervalMs: 60_000,
    });
    await dispatch.start();

    signals.publish({ sessionId: "sess_1", kind: "wake" });
    await vi.waitFor(() => expect(router.handleNewEvent).toHaveBeenCalledTimes(1));
    signals.publish({ sessionId: "sess_1", kind: "wake" });
    signals.publish({ sessionId: "sess_1", kind: "check" });

    // Wakes for a Session already being drained are deduplicated; the hint is not.
    expect(router.checkNow).toHaveBeenCalledExactlyOnceWith("sess_1");
    expect(router.handleNewEvent).toHaveBeenCalledTimes(1);
    // A hint costs this Runner no lookup: only the owner's Router acts on it.
    expect(sessions.getById).toHaveBeenCalledTimes(1);
    await dispatch.stop();
  });

  it("F5 once stopped it claims nothing: no pending scan runs and a wake is ignored, while a check hint still reaches the Turns it runs", async () => {
    vi.useFakeTimers();
    try {
      const signals = new Signals();
      const router = {
        handleNewEvent: vi.fn(async () => {}),
        checkNow: vi.fn(),
        recoverPendingEvents: vi.fn(async () => ({ recovered: [], discarded: [], failed: [] })),
      };
      const sessions = { getById: vi.fn(async (id: string) => ({ id, status: "running", agent: {} })) };
      const dispatch = new RunnerDispatch({
        router: router as unknown as SessionRouter, sessions: sessions as unknown as SessionStore, signals, scanIntervalMs: 1000,
      });
      await dispatch.start();
      expect(router.recoverPendingEvents).toHaveBeenCalledTimes(1);

      await dispatch.stop();
      await vi.advanceTimersByTimeAsync(5000);
      signals.publish({ sessionId: "sess_1", kind: "wake" });
      signals.publish({ sessionId: "sess_1", kind: "check" });
      await vi.advanceTimersByTimeAsync(0);

      expect(router.recoverPendingEvents).toHaveBeenCalledTimes(1);
      expect(sessions.getById).not.toHaveBeenCalled();
      expect(router.handleNewEvent).not.toHaveBeenCalled();
      // A Turn still running until the handoff deadline acts on its hints.
      expect(router.checkNow).toHaveBeenCalledExactlyOnceWith("sess_1");
    } finally {
      vi.useRealTimers();
    }
  });
});
