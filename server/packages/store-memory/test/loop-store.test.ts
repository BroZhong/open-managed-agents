import { describe, expect, it } from "vitest";
import type { PendingEvent, PendingEventEnqueueInput } from "@oma-server/store";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { InMemoryLoopStore } from "../src/loop-store.js";
import { InMemoryPendingEventStore } from "../src/pending-event-store.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { InMemoryWorkspaceMetadataStore } from "../src/workspace-metadata-store.js";

class GatedAgentStore extends InMemoryAgentStore {
  private markLookupStarted!: () => void;
  private releaseLookup!: () => void;
  readonly lookupStarted = new Promise<void>((resolve) => {
    this.markLookupStarted = resolve;
  });
  private readonly lookupGate = new Promise<void>((resolve) => {
    this.releaseLookup = resolve;
  });

  override async getById(id: string) {
    this.markLookupStarted();
    await this.lookupGate;
    return super.getById(id);
  }

  release(): void {
    this.releaseLookup();
  }
}

class AmbiguousFailurePendingEventStore extends InMemoryPendingEventStore {
  private enqueueCount = 0;

  constructor(private readonly failAt = 1) {
    super();
  }

  override async enqueue(
    sessionId: string,
    event: PendingEventEnqueueInput,
  ): Promise<PendingEvent> {
    const pending = await super.enqueue(sessionId, event);
    this.enqueueCount++;
    if (this.enqueueCount === this.failAt) {
      throw new Error("simulated pending-event commit failure");
    }
    return pending;
  }
}

describe("InMemoryLoopStore", () => {
  it("rolls back a partial dispatch when the pending Turn cannot be committed", async () => {
    const agents = new InMemoryAgentStore();
    const sessions = new InMemorySessionStore();
    const workspaces = new InMemoryWorkspaceMetadataStore();
    const pending = new AmbiguousFailurePendingEventStore();
    const loops = new InMemoryLoopStore(agents, sessions, workspaces, pending);
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Weekly review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    await expect(loops.dispatchNow(
      loop.id,
      "tenant_1",
      new Date("2026-07-14T00:01:00.000Z"),
    )).rejects.toThrow("simulated pending-event commit failure");

    expect((await sessions.list("tenant_1")).data).toEqual([]);
    expect(await workspaces.list("tenant_1")).toEqual([]);
    expect(await pending.listPendingSessionIds()).toEqual([]);
    const unchangedLoop = await loops.getById(loop.id);
    expect(unchangedLoop?.lastRunAt).toBeUndefined();
    expect(unchangedLoop).toMatchObject({
      nextRunAt: new Date("2026-07-14T00:05:00.000Z"),
    });
  });

  it("rolls back earlier occurrences when a later dispatch in the batch fails", async () => {
    const agents = new InMemoryAgentStore();
    const sessions = new InMemorySessionStore();
    const workspaces = new InMemoryWorkspaceMetadataStore();
    const pending = new AmbiguousFailurePendingEventStore(2);
    const loops = new InMemoryLoopStore(agents, sessions, workspaces, pending);
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const start = new Date("2026-07-14T00:00:00.000Z");
    const first = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "First review",
      prompt: "Analyze the first source.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });
    const second = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Second review",
      prompt: "Analyze the second source.",
      intervalMinutes: 5,
      enabled: true,
      now: start,
    });

    await expect(loops.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      10,
    )).rejects.toThrow("simulated pending-event commit failure");

    expect((await sessions.list("tenant_1")).data).toEqual([]);
    expect(await workspaces.list("tenant_1")).toEqual([]);
    expect(await pending.listPendingSessionIds()).toEqual([]);
    for (const loop of [first, second]) {
      expect(loop.lastRunAt).toBeUndefined();
      expect(loop.nextRunAt).toEqual(
        new Date("2026-07-14T00:05:00.000Z"),
      );
      const unchanged = await loops.getById(loop.id);
      expect(unchanged?.lastRunAt).toBeUndefined();
      expect(unchanged?.nextRunAt).toEqual(
        new Date("2026-07-14T00:05:00.000Z"),
      );
    }
  });

  it("serializes a Loop update with an in-progress dispatch", async () => {
    const agents = new GatedAgentStore();
    const sessions = new InMemorySessionStore();
    const workspaces = new InMemoryWorkspaceMetadataStore();
    const pending = new InMemoryPendingEventStore();
    const loops = new InMemoryLoopStore(agents, sessions, workspaces, pending);
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Original review",
      prompt: "Original prompt",
      intervalMinutes: 5,
      enabled: true,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    const dispatch = loops.dispatchNow(
      loop.id,
      "tenant_1",
      new Date("2026-07-14T00:01:00.000Z"),
    );
    await agents.lookupStarted;
    let updateSettled = false;
    const update = loops.update(loop.id, "tenant_1", {
      name: "Updated review",
      prompt: "Updated prompt",
      now: new Date("2026-07-14T00:02:00.000Z"),
    }).then((value) => {
      updateSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(updateSettled).toBe(false);

    agents.release();
    const dispatched = await dispatch;
    expect(dispatched?.session.title).toBe("Original review");
    expect(await pending.peek(dispatched!.session.id)).toMatchObject({
      data: { content: [{ type: "text", text: "Original prompt" }] },
    });
    await expect(update).resolves.toMatchObject({
      name: "Updated review",
      prompt: "Updated prompt",
    });
  });

  it("attributes only run-now dispatches to their authenticating API key", async () => {
    const agents = new InMemoryAgentStore();
    const sessions = new InMemorySessionStore();
    const workspaces = new InMemoryWorkspaceMetadataStore();
    const pending = new InMemoryPendingEventStore();
    const loops = new InMemoryLoopStore(agents, sessions, workspaces, pending);
    const agent = await agents.create({
      tenantId: "tenant_1",
      name: "Session Analyst",
      model: "openai-codex/gpt-5.5",
      system: "Analyze Sessions.",
      runtime: "pi-agent",
    });
    const loop = await loops.create({
      tenantId: "tenant_1",
      agentId: agent.id,
      name: "Weekly review",
      prompt: "Analyze recent Sessions.",
      intervalMinutes: 5,
      enabled: true,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    const manual = await loops.dispatchNow(
      loop.id,
      "tenant_1",
      new Date("2026-07-14T00:01:00.000Z"),
      "key_loop_run",
    );
    expect((await pending.peek(manual!.session.id))?.apiKeyId).toBe("key_loop_run");

    const [scheduled] = await loops.dispatchDue(
      new Date("2026-07-14T00:05:00.000Z"),
      1,
    );
    expect((await pending.peek(scheduled.session.id))?.apiKeyId).toBeUndefined();
  });
});
