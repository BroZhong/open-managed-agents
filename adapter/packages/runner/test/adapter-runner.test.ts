import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runnerDir = new URL("../", import.meta.url).pathname;

describe("adapter-runner", () => {
  it("streams JSONL events from MockAdapter", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adapter-runner-test-"));
    const inputPath = join(tmpDir, "input.json");

    const input = {
      runtime: "mock",
      sessionId: "test-session-1",
      turnId: "test-turn-1",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      agent: {
        model: "mock-model",
        system: "You are a test assistant.",
      },
      history: [],
    };

    await writeFile(inputPath, JSON.stringify(input));

    try {
      const runnerPath = new URL(
        "../src/adapter-runner.ts",
        import.meta.url,
      ).pathname;

      const { stdout } = await execFileAsync("tsx", [runnerPath, inputPath], {
        timeout: 10_000,
        cwd: runnerDir,
      });

      const lines = stdout.trim().split("\n");
      expect(lines.length).toBeGreaterThan(0);

      const events = lines.map((line) => JSON.parse(line));

      // Verify each event has required fields
      for (const event of events) {
        expect(event).toHaveProperty("id");
        expect(event).toHaveProperty("timestamp");
        expect(event).toHaveProperty("type");
        expect(event.id).toMatch(/^sevt_/);
      }

      // Verify expected event type sequence from MockAdapter
      const types = events.map((e: { type: string }) => e.type);
      expect(types[0]).toBe("session.status_running");
      expect(types[1]).toBe("span.model_request_start");
      expect(types).toContain("agent.message_stream_start");
      expect(types).toContain("agent.message_chunk");
      expect(types).toContain("agent.message_stream_end");
      expect(types).toContain("agent.message");
      expect(types).toContain("span.model_request_end");
      expect(types[types.length - 1]).toBe("session.status_idle");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it("emits session.error for missing input file", async () => {
    const runnerPath = new URL(
      "../src/adapter-runner.ts",
      import.meta.url,
    ).pathname;

    try {
      await execFileAsync("tsx", [runnerPath, "/nonexistent/path.json"], {
        timeout: 10_000,
        cwd: runnerDir,
      });
      expect.fail("Should have exited with non-zero");
    } catch (err: unknown) {
      const error = err as { stdout: string; code: number };
      expect(error.code).toBe(1);
      const lines = error.stdout.trim().split("\n");
      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.type).toBe("session.error");
      expect(event.error.code).toBe("runner_error");
    }
  });

  it("emits session.error for unknown runtime", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "adapter-runner-test-"));
    const inputPath = join(tmpDir, "input.json");

    const input = {
      runtime: "unknown-runtime",
      sessionId: "test-session-2",
      turnId: "test-turn-2",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      agent: {
        model: "mock-model",
        system: "You are a test assistant.",
      },
      history: [],
    };

    await writeFile(inputPath, JSON.stringify(input));

    try {
      const runnerPath = new URL(
        "../src/adapter-runner.ts",
        import.meta.url,
      ).pathname;

      await execFileAsync("tsx", [runnerPath, inputPath], {
        timeout: 10_000,
        cwd: runnerDir,
      });
      expect.fail("Should have exited with non-zero");
    } catch (err: unknown) {
      const error = err as { stdout: string; code: number };
      expect(error.code).toBe(1);
      const lines = error.stdout.trim().split("\n");
      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.type).toBe("session.error");
      expect(event.error.message).toContain("Unknown runtime");
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });
});
