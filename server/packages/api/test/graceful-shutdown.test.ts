import { describe, expect, it, vi } from "vitest";
import type { ServerType } from "@hono/node-server";
import { createGracefulShutdown } from "../src/lib/graceful-shutdown.js";

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
  it("stops HTTP first, drains Turns, then closes resources exactly once", async () => {
    const calls: string[] = [];
    let finishDrain!: (value: boolean) => void;
    const waitForIdle = vi.fn((timeoutMs: number) => {
      calls.push(`router.waitForIdle:${timeoutMs}`);
      return new Promise<boolean>((resolve) => {
        finishDrain = resolve;
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
      waitForIdle,
      closeResources,
      logger,
    });

    const sigterm = shutdown("SIGTERM");
    const sigint = shutdown("SIGINT");
    expect(sigint).toBe(sigterm);
    expect(calls).toEqual(["http.close", "router.waitForIdle:20000"]);

    finishDrain(true);
    await sigterm;

    expect(calls).toEqual([
      "http.close",
      "router.waitForIdle:20000",
      "http.closeAllConnections",
      "resources.close",
    ]);
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(closeResources).toHaveBeenCalledOnce();
  });

  it("bounds a stuck drain and still closes HTTP connections and resources", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const shutdown = createGracefulShutdown({
      server: fakeServer(calls),
      waitForIdle: async () => new Promise<boolean>(() => {}),
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
        "Graceful shutdown timed out waiting for active Turns after 25ms",
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
});
