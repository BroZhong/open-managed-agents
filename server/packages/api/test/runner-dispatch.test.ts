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
  it("logs one runner_capacity line a minute with the Turns the Router executes and its free places (ADR-0026)", async () => {
    vi.useFakeTimers();
    try {
      const router = {
        handleNewEvent: vi.fn(async () => {}), checkNow: vi.fn(),
        recoverPendingEvents: vi.fn(async () => ({ recovered: [], discarded: [], failed: [] })),
        capacityReport: vi.fn(() => ({ capacity: 50, executing: 12, syncWaiting: 3, free: 38 })),
      };
      const lines: string[] = [];
      const dispatch = new RunnerDispatch({
        router: router as unknown as SessionRouter, sessions: { getById: vi.fn() } as unknown as SessionStore, signals: new Signals(),
        scanIntervalMs: 60_000, owner: "oma-runner-1_a1b2c3d4", logger: { info: (line: string) => lines.push(line) },
      });
      await dispatch.start();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { msg: "runner_capacity", owner: "oma-runner-1_a1b2c3d4", capacity: 50, executing: 12, syncWaiting: 3, free: 38 },
      ]);
      await dispatch.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the Router the Session it read for a wake, so a full Runner knows a Child Session's without reading it again (#328)", async () => {
    const signals = new Signals();
    const router = {
      handleNewEvent: vi.fn(async () => {}), checkNow: vi.fn(),
      recoverPendingEvents: vi.fn(async () => ({ recovered: [], discarded: [], failed: [] })),
    };
    const session = { id: "sess_child", status: "idle", agent: { id: "agent" }, delegation: { parentSessionId: "sess_parent" } };
    const dispatch = new RunnerDispatch({
      router: router as unknown as SessionRouter, sessions: { getById: vi.fn(async () => session) } as unknown as SessionStore, signals, scanIntervalMs: 60_000,
    });
    await dispatch.start();
    signals.publish({ sessionId: "sess_child", kind: "wake" });
    await vi.waitFor(() => expect(router.handleNewEvent).toHaveBeenCalledExactlyOnceWith("sess_child", session.agent, session));
    await dispatch.stop();
  });

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

  it("hands the Router one more wake once a drain it started ends, for the wakes that arrived meanwhile: one of them may be input the drain's last claim missed", async () => {
    const signals = new Signals();
    let finish!: () => void;
    const drains: Promise<void>[] = [new Promise<void>((resolve) => { finish = resolve; })];
    const router = {
      handleNewEvent: vi.fn(() => drains.shift() ?? Promise.resolve()),
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
    signals.publish({ sessionId: "sess_1", kind: "wake" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.handleNewEvent).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(router.handleNewEvent).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Coalesced: the two wakes it held back become one.
    expect(router.handleNewEvent).toHaveBeenCalledTimes(2);
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
