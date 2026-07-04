import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStores, type MemoryStores } from "../src/index.js";

describe("createMemoryStores", () => {
  let stores: MemoryStores;

  beforeEach(() => {
    stores = createMemoryStores();
  });

  describe("AgentStore", () => {
    it("creates and retrieves an agent", async () => {
      const agent = await stores.agentStore.create({
        tenantId: "t1",
        name: "Test Agent",
        model: "gpt-4",
        system: "You are helpful.",
        runtime: "claude-code",
      });
      expect(agent.id).toBeDefined();
      expect(agent.name).toBe("Test Agent");

      const found = await stores.agentStore.getById(agent.id);
      expect(found).toEqual(agent);
    });

    it("lists agents by tenant", async () => {
      await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      await stores.agentStore.create({ tenantId: "t2", name: "B", model: "m", system: "s", runtime: "codex" });

      const result = await stores.agentStore.list("t1");
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe("A");
    });

    it("updates an agent", async () => {
      const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      const updated = await stores.agentStore.update(agent.id, { name: "B" });
      expect(updated?.name).toBe("B");
    });

    it("deletes an agent", async () => {
      const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      const deleted = await stores.agentStore.delete(agent.id);
      expect(deleted).toBe(true);
      expect(await stores.agentStore.getById(agent.id)).toBeNull();
    });
  });

  describe("SessionStore", () => {
    it("creates and retrieves a session bound to a workspace", async () => {
      const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      const ws = await stores.workspaceStore.create({ tenantId: "t1" });
      const session = await stores.sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: ws.id });
      expect(session.status).toBe("idle");
      expect(session.workspaceId).toBe(ws.id);

      const found = await stores.sessionStore.getById(session.id);
      expect(found).toEqual(session);
    });

    it("updates status without touching the workspace binding", async () => {
      const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      const ws = await stores.workspaceStore.create({ tenantId: "t1", id: "bound" });
      const session = await stores.sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: ws.id });

      const updated = await stores.sessionStore.updateStatus(session.id, "running");
      expect(updated?.status).toBe("running");
      expect(updated?.workspaceId).toBe("bound");
    });

    it("terminates a session", async () => {
      const agent = await stores.agentStore.create({ tenantId: "t1", name: "A", model: "m", system: "s", runtime: "claude-code" });
      const ws = await stores.workspaceStore.create({ tenantId: "t1" });
      const session = await stores.sessionStore.create({ tenantId: "t1", agentId: agent.id, agent, workspaceId: ws.id });

      const terminated = await stores.sessionStore.terminate(session.id);
      expect(terminated?.status).toBe("terminated");
      expect(terminated?.terminatedAt).toBeDefined();
      expect(terminated?.workspaceId).toBe(ws.id);
    });
  });

  describe("WorkspaceStore", () => {
    it("auto-creates a workspace when no id is supplied", async () => {
      const ws = await stores.workspaceStore.create({ tenantId: "t1" });
      expect(ws.id).toMatch(/^ws_/);
      expect(ws.tenantId).toBe("t1");
    });

    it("uses a user-supplied id as-is and is idempotent", async () => {
      const first = await stores.workspaceStore.create({ tenantId: "t1", id: "shared" });
      const second = await stores.workspaceStore.create({ tenantId: "t1", id: "shared" });
      expect(first).toEqual(second);
      expect((await stores.workspaceStore.getById("t1", "shared"))?.id).toBe("shared");
    });

    it("isolates workspaces by tenant", async () => {
      await stores.workspaceStore.create({ tenantId: "t1", id: "ws" });
      await stores.workspaceStore.create({ tenantId: "t2", id: "ws" });
      expect(await stores.workspaceStore.getById("t1", "ws")).not.toBeNull();
      expect(await stores.workspaceStore.getById("t2", "ws")).not.toBeNull();
      expect(await stores.workspaceStore.getById("t3", "ws")).toBeNull();
    });
  });

  describe("EventLogStore", () => {
    it("appends and retrieves events with sequence numbers", async () => {
      const e1 = await stores.eventLogStore.append("s1", { type: "agent.message", data: { text: "hi" }, sessionThreadId: "th1" });
      const e2 = await stores.eventLogStore.append("s1", { type: "agent.message", data: { text: "bye" }, sessionThreadId: "th1" });

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);

      const result = await stores.eventLogStore.getEvents("s1");
      expect(result.data).toHaveLength(2);
    });

    it("supports afterSeq pagination", async () => {
      await stores.eventLogStore.append("s1", { type: "a", data: {}, sessionThreadId: "th1" });
      await stores.eventLogStore.append("s1", { type: "b", data: {}, sessionThreadId: "th1" });
      await stores.eventLogStore.append("s1", { type: "c", data: {}, sessionThreadId: "th1" });

      const result = await stores.eventLogStore.getEvents("s1", { afterSeq: 1 });
      expect(result.data).toHaveLength(2);
      expect(result.data[0].type).toBe("b");
    });
  });

  describe("PendingEventStore", () => {
    it("enqueues and dequeues in FIFO order", async () => {
      await stores.pendingEventStore.enqueue("s1", { type: "user.message", data: { text: "first" }, sessionThreadId: "th1" });
      await stores.pendingEventStore.enqueue("s1", { type: "user.message", data: { text: "second" }, sessionThreadId: "th1" });

      const first = await stores.pendingEventStore.dequeue("s1");
      expect(first?.data).toEqual({ text: "first" });

      const second = await stores.pendingEventStore.dequeue("s1");
      expect(second?.data).toEqual({ text: "second" });

      const empty = await stores.pendingEventStore.dequeue("s1");
      expect(empty).toBeNull();
    });

    it("counts pending events", async () => {
      await stores.pendingEventStore.enqueue("s1", { type: "a", data: {}, sessionThreadId: "th1" });
      await stores.pendingEventStore.enqueue("s1", { type: "b", data: {}, sessionThreadId: "th1" });

      expect(await stores.pendingEventStore.count("s1")).toBe(2);
    });

    it("peeks without removing", async () => {
      await stores.pendingEventStore.enqueue("s1", { type: "a", data: { x: 1 }, sessionThreadId: "th1" });

      const peeked = await stores.pendingEventStore.peek("s1");
      expect(peeked?.data).toEqual({ x: 1 });
      expect(await stores.pendingEventStore.count("s1")).toBe(1);
    });
  });
});
