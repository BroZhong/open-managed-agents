import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import type { SessionRouter } from "@oma-server/session-router";
import type { LoopStore } from "@oma-server/store";
import { LoopScheduler } from "../src/lib/loop-scheduler.js";

describe("LoopScheduler", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("creates exactly one new Session at each five-minute boundary", async () => {
    const stores = createMemoryStores();
    const agent = await stores.agentStore.create({
      tenantId: "dev",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Find concrete improvements.",
      runtime: "pi-agent",
      mcpServers: [{
        catalogId: "aliyun-rds-supabase",
        name: "session-data",
        description: "Read recent Sessions",
      }],
    });
    const loop = await stores.loopStore.create({
      tenantId: "dev",
      agentId: agent.id,
      name: "Weekly Session Review",
      prompt: "Read the last seven days of Sessions and propose Agent improvements.",
      intervalMinutes: 5,
      enabled: true,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });
    const recoverPendingEvents = vi.fn(async () => ({
      recovered: [],
      discarded: [],
      failed: [],
    }));
    const scheduler = new LoopScheduler({
      loopStore: stores.loopStore,
      sessionRouter: { recoverPendingEvents } as unknown as SessionRouter,
    });

    expect(await scheduler.runDue(new Date("2026-07-14T00:04:59.999Z"))).toBe(0);
    expect(await scheduler.runDue(new Date("2026-07-14T00:05:00.000Z"))).toBe(1);
    expect(await scheduler.runDue(new Date("2026-07-14T00:05:00.000Z"))).toBe(0);
    expect(await scheduler.runDue(new Date("2026-07-14T00:10:00.000Z"))).toBe(1);

    const sessions = await stores.sessionStore.list("dev", { loopId: loop.id });
    expect(sessions.data).toHaveLength(2);
    expect(new Set(sessions.data.map((session) => session.id)).size).toBe(2);
    expect(sessions.data.every((session) => session.loopId === loop.id)).toBe(true);
    expect(recoverPendingEvents).toHaveBeenCalledTimes(4);
  });

  it("clears a failed tick so the next poll can retry", async () => {
    const dispatchDue = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([]);
    const scheduler = new LoopScheduler({
      loopStore: { dispatchDue } as unknown as LoopStore,
      sessionRouter: {
        recoverPendingEvents: async () => ({
          recovered: [],
          discarded: [],
          failed: [],
        }),
      } as unknown as SessionRouter,
    });

    await expect(scheduler.runDue()).rejects.toThrow("database unavailable");
    await expect(scheduler.runDue()).resolves.toBe(0);
    expect(dispatchDue).toHaveBeenCalledTimes(2);
  });

  it("rescans retained pending input after an ambiguous dispatch commit and on the next poll", async () => {
    const dispatchDue = vi.fn()
      .mockRejectedValueOnce(new Error("commit outcome unknown"))
      .mockResolvedValueOnce([]);
    const recoverPendingEvents = vi.fn(async (
      onBackgroundError?: (failure: { sessionId: string; error: unknown }) => void,
    ) => {
      if (recoverPendingEvents.mock.calls.length === 1) {
        onBackgroundError?.({
          sessionId: "sess_committed",
          error: new Error("initial route failed"),
        });
      }
      return {
        recovered: ["sess_committed"],
        discarded: [],
        failed: [],
      };
    });
    const handleNewEvent = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };
    const scheduler = new LoopScheduler({
      loopStore: { dispatchDue } as unknown as LoopStore,
      sessionRouter: {
        recoverPendingEvents,
        handleNewEvent,
      } as unknown as SessionRouter,
      logger,
    });

    await expect(scheduler.runDue()).rejects.toThrow("commit outcome unknown");
    await expect(scheduler.runDue()).resolves.toBe(0);

    expect(recoverPendingEvents).toHaveBeenCalledTimes(2);
    expect(handleNewEvent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "SessionRouter failed while recovering retained Session sess_committed:",
      expect.any(Error),
    );
  });
});
