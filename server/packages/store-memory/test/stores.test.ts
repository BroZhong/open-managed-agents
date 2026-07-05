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

    it("stores a name and does not clobber it on idempotent re-create", async () => {
      const ws = await stores.workspaceStore.create({ tenantId: "t1", id: "named", name: "Files" });
      expect(ws.name).toBe("Files");
      const again = await stores.workspaceStore.create({ tenantId: "t1", id: "named", name: "Renamed" });
      expect(again.name).toBe("Files");
    });

    it("lists a tenant's workspaces ordered by created_at", async () => {
      await stores.workspaceStore.create({ tenantId: "t1", id: "a", name: "A" });
      await stores.workspaceStore.create({ tenantId: "t1", id: "b", name: "B" });
      await stores.workspaceStore.create({ tenantId: "t2", id: "c" });

      const list = await stores.workspaceStore.list("t1");
      expect(list.map((w) => w.id)).toEqual(["a", "b"]);
      expect(await stores.workspaceStore.list("t3")).toEqual([]);
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

  describe("AgentFileStore", () => {
    it("upserts and reads back identical content", async () => {
      await stores.agentFileStore.upsert("t1", "a1", "SOUL", "be warm");
      const f = await stores.agentFileStore.get("t1", "a1", "SOUL");
      expect(f?.content).toBe("be warm");
    });

    it("list omits content", async () => {
      await stores.agentFileStore.upsert("t1", "a1", "SOUL", "x");
      const list = await stores.agentFileStore.list("t1", "a1");
      expect(list).toEqual([{ filename: "SOUL", updatedAt: expect.any(Date) }]);
    });

    it("isolates by tenant and agent", async () => {
      await stores.agentFileStore.upsert("t1", "a1", "SOUL", "x");
      expect(await stores.agentFileStore.get("t2", "a1", "SOUL")).toBeNull();
      expect(await stores.agentFileStore.get("t1", "a2", "SOUL")).toBeNull();
      expect(await stores.agentFileStore.list("t2", "a1")).toEqual([]);
    });

    it("deletes a file", async () => {
      await stores.agentFileStore.upsert("t1", "a1", "USER", "x");
      expect(await stores.agentFileStore.delete("t1", "a1", "USER")).toBe(true);
      expect(await stores.agentFileStore.get("t1", "a1", "USER")).toBeNull();
      expect(await stores.agentFileStore.delete("t1", "a1", "USER")).toBe(false);
    });
  });

  describe("SkillStore + SkillArtifactStore", () => {
    it("creates a Skill and isolates by tenant", async () => {
      const s = await stores.skillStore.create({ tenantId: "t1", name: "greeter", description: "d" });
      expect(await stores.skillStore.getById(s.id)).toEqual(s);
      const t1 = await stores.skillStore.list("t1");
      const t2 = await stores.skillStore.list("t2");
      expect(t1.data).toHaveLength(1);
      expect(t2.data).toHaveLength(0);
    });

    it("stores + reads + deletes Skill file bodies under an isolated namespace", async () => {
      await stores.skillArtifactStore.put("t1", "sk1", "SKILL.md", "hi");
      await stores.skillArtifactStore.put("t1", "sk1", "notes/x.md", "n");
      expect((await stores.skillArtifactStore.list("t1", "sk1")).sort()).toEqual(
        ["SKILL.md", "notes/x.md"].sort(),
      );
      // A different tenant cannot see another tenant's Skill files.
      expect(await stores.skillArtifactStore.list("t2", "sk1")).toEqual([]);

      const all = await stores.skillArtifactStore.getAll("t1", "sk1");
      expect(all).toHaveLength(2);

      await stores.skillArtifactStore.deleteTree("t1", "sk1");
      expect(await stores.skillArtifactStore.list("t1", "sk1")).toEqual([]);
    });
  });
});
