import { describe, it, expect, vi } from "vitest";
import { SandboxOrchestratorImpl } from "../src/sandbox-orchestrator.js";
import type { SandboxClient } from "../src/types.js";
import type { AdapterInput } from "@open-managed-agents/adapter-core";

function createMockClient(overrides?: Partial<SandboxClient>): SandboxClient {
  return {
    create: vi.fn(async () => ({
      sandboxId: "sbx_123",
      status: "running" as const,
    })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => ({
      sandboxId: "sbx_123",
      status: "running" as const,
    })),
    kill: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    exec: vi.fn(async function* () {
      yield '{"id":"e1","timestamp":"2024-01-01T00:00:00Z","type":"session.status_running"}\n';
      yield '{"id":"e2","timestamp":"2024-01-01T00:00:01Z","type":"session.status_idle"}\n';
    }),
    ...overrides,
  };
}

function createTestInput(): AdapterInput {
  return {
    sessionId: "ses_1",
    turnId: "turn_1",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
    agent: { model: "mock", system: "test" },
    history: [],
  };
}

describe("SandboxOrchestratorImpl", () => {
  describe("createForSession", () => {
    it("calls client.create and stores mapping", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);

      const ref = await orch.createForSession("ses_1");

      expect(client.create).toHaveBeenCalledWith({});
      expect(ref).toEqual({ sandboxId: "sbx_123", status: "running" });
    });

    it("throws when sandbox already exists for session", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);

      await orch.createForSession("ses_1");

      await expect(orch.createForSession("ses_1")).rejects.toThrow(
        "Sandbox already exists for session ses_1",
      );
    });
  });

  describe("resume", () => {
    it("calls client.resume with correct sandbox ID", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);
      await orch.createForSession("ses_1");

      const ref = await orch.resume("ses_1");

      expect(client.resume).toHaveBeenCalledWith("sbx_123");
      expect(ref.status).toBe("running");
    });

    it("throws when no sandbox found for session", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);

      await expect(orch.resume("ses_missing")).rejects.toThrow(
        "No sandbox found for session ses_missing",
      );
    });
  });

  describe("pause", () => {
    it("calls client.pause with correct sandbox ID", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);
      await orch.createForSession("ses_1");

      await orch.pause("ses_1");

      expect(client.pause).toHaveBeenCalledWith("sbx_123");
    });
  });

  describe("kill", () => {
    it("calls client.kill and removes mapping", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);
      await orch.createForSession("ses_1");

      await orch.kill("ses_1");

      expect(client.kill).toHaveBeenCalledWith("sbx_123");
      // After kill, session is no longer mapped
      await expect(orch.resume("ses_1")).rejects.toThrow(
        "No sandbox found for session ses_1",
      );
    });
  });

  describe("runAdapterTurn", () => {
    it("writes input file, executes command, and yields parsed events", async () => {
      const client = createMockClient();
      const orch = new SandboxOrchestratorImpl(client);
      await orch.createForSession("ses_1");

      const input = createTestInput();
      const events = [];
      for await (const event of orch.runAdapterTurn("ses_1", input)) {
        events.push(event);
      }

      expect(client.writeFile).toHaveBeenCalledWith(
        "sbx_123",
        "/tmp/input.json",
        JSON.stringify(input),
      );
      expect(client.exec).toHaveBeenCalledWith("sbx_123", [
        "node",
        "adapter-runner.js",
        "/tmp/input.json",
      ]);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        id: "e1",
        timestamp: "2024-01-01T00:00:00Z",
        type: "session.status_running",
      });
      expect(events[1]).toEqual({
        id: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session.status_idle",
      });
    });

    it("handles chunked output split across boundaries", async () => {
      const client = createMockClient({
        exec: vi.fn(async function* () {
          // Split a JSON line across two chunks
          yield '{"id":"e1","timestamp":"2024-01-01T00:00:00Z",';
          yield '"type":"session.status_running"}\n{"id":"e2",';
          yield '"timestamp":"2024-01-01T00:00:01Z","type":"session.status_idle"}\n';
        }),
      });
      const orch = new SandboxOrchestratorImpl(client);
      await orch.createForSession("ses_1");

      const input = createTestInput();
      const events = [];
      for await (const event of orch.runAdapterTurn("ses_1", input)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        id: "e1",
        timestamp: "2024-01-01T00:00:00Z",
        type: "session.status_running",
      });
      expect(events[1]).toEqual({
        id: "e2",
        timestamp: "2024-01-01T00:00:01Z",
        type: "session.status_idle",
      });
    });
  });
});
