import { describe, expect, it, vi } from "vitest";
import type { ServerType } from "@hono/node-server";
import type { SessionRouter } from "@oma-server/session-router";
import type { LoopStore } from "@oma-server/store";
import { createGracefulShutdown } from "../src/lib/graceful-shutdown.js";
import { LoopScheduler } from "../src/lib/loop-scheduler.js";

function fakeServer(calls: string[]): ServerType {
  let closeCallback: (() => void) | undefined;
  return {
    close(callback?: () => void) {
      calls.push("http.close");
      closeCallback = callback;
      return this;
    },
    closeAllConnections() {
      calls.push("http.closeAllConnections");
      closeCallback?.();
    },
  } as unknown as ServerType;
}

describe("createGracefulShutdown", () => {
  it("stops HTTP first, hands Turns over before stopping background work, then closes resources exactly once", async () => {
    const calls: string[] = [];
    let finishHandoff!: (value: boolean) => void;
    const handOff = vi.fn((timeoutMs: number) => {
      calls.push(`router.handOff:${timeoutMs}`);
      return new Promise<boolean>((resolve) => {
        finishHandoff = resolve;
      });
    });
    const closeResources = vi.fn(async () => {
      calls.push("resources.close");
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const shutdown = createGracefulShutdown({
      server: fakeServer(calls),
      stopBackgroundWork: async () => {
        calls.push("loops.stop");
      },
      handOff,
      closeResources,
      logger,
    });

    const sigterm = shutdown("SIGTERM");
    const sigint = shutdown("SIGINT");
    expect(sigint).toBe(sigterm);
    await vi.waitFor(() => {
      expect(calls).toEqual(expect.arrayContaining([
        "http.close",
        "loops.stop",
        expect.stringMatching(/^router\.handOff:\d+$/),
      ]));
    });

    finishHandoff(true);
    await sigterm;

    // The handoff starts first: claiming stops at once, and running Turns are
    // asked to stop before a slow background sweep settles.
    expect(calls).toEqual([
      "http.close",
      expect.stringMatching(/^router\.handOff:\d+$/),
      "loops.stop",
      "http.closeAllConnections",
      "resources.close",
    ]);
    // The whole grace period goes to the handoff.
    expect(Number(calls[1].split(":")[1])).toBeGreaterThan(19_000);
    expect(handOff).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("waits for the claims of Turns detached at the deadline to be released before closing resources", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const shutdown = createGracefulShutdown({
      server: fakeServer(calls),
      // Turns still ran at the deadline; releasing their claims takes a moment more.
      handOff: (timeoutMs) => new Promise<boolean>((resolve) => setTimeout(() => {
        calls.push("router.released");
        resolve(false);
      }, timeoutMs + 100)),
      closeResources: async () => { calls.push("resources.close"); },
      timeoutMs: 25,
      logger,
    });

    try {
      const result = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(125);
      await result;

      expect(logger.warn).toHaveBeenCalledWith("Graceful shutdown detached the Turns still running after 25ms");
      expect(calls).toEqual(["http.close", "router.released", "http.closeAllConnections", "resources.close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stuck handoff and still closes HTTP connections and resources", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const shutdown = createGracefulShutdown({
      server: fakeServer(calls),
      handOff: async () => new Promise<boolean>(() => {}),
      closeResources: async () => {
        calls.push("resources.close");
      },
      timeoutMs: 25,
      logger,
    });

    try {
      const result = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(5025);
      await result;

      expect(logger.warn).toHaveBeenCalledWith(
        "Graceful shutdown timed out handing active Turns over after 25ms",
      );
      expect(calls).toEqual([
        "http.close",
        "http.closeAllConnections",
        "resources.close",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a scheduler poll that never settles and still closes resources", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const scheduler = new LoopScheduler({
      loopStore: {
        dispatchDue: async () => new Promise(() => {}),
      } as unknown as LoopStore,
      sessionRouter: {} as SessionRouter,
    });
    void scheduler.runDue();
    const shutdown = createGracefulShutdown({
      server: fakeServer(calls),
      stopBackgroundWork: () => scheduler.stop(),
      handOff: async (timeoutMs) => {
        calls.push(`router.handOff:${timeoutMs}`);
        return true;
      },
      closeResources: async () => {
        calls.push("resources.close");
      },
      timeoutMs: 25,
      logger,
    });

    try {
      const result = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(25);
      await result;

      expect(logger.warn).toHaveBeenCalledWith(
        "Graceful shutdown timed out stopping background work after 25ms",
      );
      expect(calls).toEqual([
        "http.close",
        "router.handOff:25",
        "http.closeAllConnections",
        "resources.close",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
