import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import type { SdkMessage } from "../src/sdk-types.js";
import { ClaudeCodeAdapter } from "../src/claude-code-adapter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<AdapterInput>): AdapterInput {
  return {
    sessionId: "sess_test_001",
    turnId: "turn_test_001",
    message: {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
    agent: {
      model: "claude-sonnet-4-20250514",
      system: "You are a helpful assistant.",
    },
    history: [],
    ...overrides,
  };
}

/**
 * Create a fake query function that yields the provided SDK messages.
 */
function fakeQueryFn(messages: SdkMessage[]): (options: any) => AsyncIterable<any> {
  return async function* (_options: any) {
    for (const msg of messages) {
      yield msg;
    }
  };
}

/**
 * Create a fake query function that delays then yields messages.
 */
function fakeQueryFnWithDelay(
  messages: SdkMessage[],
  delayMs: number
): (options: any) => AsyncIterable<any> {
  return async function* (options: any) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    // Check if aborted after delay
    if (options.abortSignal?.aborted) {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    }
    for (const msg of messages) {
      yield msg;
    }
  };
}

/**
 * Create a fake query function that throws an error.
 */
function fakeQueryFnThrows(error: Error): (options: any) => AsyncIterable<any> {
  return async function* (_options: any) {
    throw error;
  };
}

/**
 * Collect all events from an async iterable.
 */
async function collectEvents(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Simple text turn SDK messages */
const TEXT_TURN_MESSAGES: SdkMessage[] = [
  { type: "message_start", message: { id: "msg_001", model: "claude-sonnet-4-20250514" } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
  { type: "message_stop" },
];

/** Tool-use turn SDK messages (two model steps) */
const TOOL_USE_MESSAGES: SdkMessage[] = [
  // First model step: tool use
  { type: "message_start", message: { id: "msg_002", model: "claude-sonnet-4-20250514" } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_001", name: "read_file" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"/foo.ts"}' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } },
  { type: "message_stop" },
  // Tool result
  { type: "tool_result", tool_use_id: "toolu_001", content: "file contents here" },
  // Second model step: text response
  { type: "message_start", message: { id: "msg_003", model: "claude-sonnet-4-20250514" } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I found the file" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } },
  { type: "message_stop" },
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ClaudeCodeAdapter", () => {
  async function createTmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "adapter-test-"));
  }

  async function createFakeClaudeCommand(
    dir: string,
    argsPath: string,
  ): Promise<string> {
    const commandPath = join(dir, "fake-claude.js");
    await writeFile(
      commandPath,
      [
        "#!/usr/bin/env node",
        "const { writeFileSync } = require('node:fs');",
        `writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
        "console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_fake', model: 'claude-test', content: [{ type: 'text', text: 'ok' }], usage: { output_tokens: 1 }, stop_reason: 'end_turn' } }));",
      ].join("\n"),
    );
    await chmod(commandPath, 0o755);
    return commandPath;
  }

  function sessionIdToUuidForTest(sessionId: string): string {
    const hash = createHash("md5").update(sessionId).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  describe("simple text turn", () => {
    it("emits NO session lifecycle events — the Host router owns them (issue #83)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TEXT_TURN_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
    });

    it("contains span pair (start and end)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TEXT_TURN_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      expect(types).toContain("span.model_request_start");
      expect(types).toContain("span.model_request_end");
    });

    it("contains streaming events", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TEXT_TURN_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      expect(types).toContain("agent.message_stream_start");
      expect(types).toContain("agent.message_chunk");
      expect(types).toContain("agent.message_stream_end");
    });

    it("contains canonical agent.message event", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TEXT_TURN_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const messageEvent = events.find((e) => e.type === "agent.message") as any;

      expect(messageEvent).toBeDefined();
      expect(messageEvent.content).toEqual([{ type: "text", text: "Hello world" }]);
    });
  });

  describe("tool-use turn", () => {
    it("contains agent.tool_use and agent.tool_result events", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TOOL_USE_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      expect(types).toContain("agent.tool_use");
      expect(types).toContain("agent.tool_result");
    });

    it("agent.tool_use appears before agent.tool_result", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TOOL_USE_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      const toolUseIdx = types.indexOf("agent.tool_use");
      const toolResultIdx = types.indexOf("agent.tool_result");
      expect(toolUseIdx).toBeLessThan(toolResultIdx);
    });

    it("emits two span pairs (one per model step)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TOOL_USE_MESSAGES),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const starts = events.filter((e) => e.type === "span.model_request_start");
      const ends = events.filter((e) => e.type === "span.model_request_end");

      expect(starts).toHaveLength(2);
      expect(ends).toHaveLength(2);
    });
  });

  describe("timeout", () => {
    it("emits session.error with timeout info when query exceeds timeout", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFnWithDelay(TEXT_TURN_MESSAGES, 500),
      });

      const input = makeInput({
        constraints: { timeoutSeconds: 0.05 },
      });

      const events = await collectEvents(adapter.run(input));
      const lastEvent = events[events.length - 1]!;

      expect(lastEvent.type).toBe("session.error");
      expect((lastEvent as any).error.code).toBe("timeout");
    });

    it("emits no lifecycle events even on timeout — router owns them (issue #83)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFnWithDelay(TEXT_TURN_MESSAGES, 500),
      });

      const input = makeInput({
        constraints: { timeoutSeconds: 0.05 },
      });

      const events = await collectEvents(adapter.run(input));
      const types = events.map((e) => e.type);
      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
    });
  });

  describe("SDK error", () => {
    it("last event is session.error and no lifecycle events are emitted (issue #83)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFnThrows(new Error("SDK connection failed")),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const types = events.map((e) => e.type);

      expect(types).not.toContain("session.status_running");
      expect(types).not.toContain("session.status_idle");
      expect(events[events.length - 1]!.type).toBe("session.error");
    });

    it("error event contains the error message", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFnThrows(new Error("SDK connection failed")),
      });

      const events = await collectEvents(adapter.run(makeInput()));
      const errorEvent = events.find((e) => e.type === "session.error") as any;

      expect(errorEvent).toBeDefined();
      expect(errorEvent.error.message).toBe("SDK connection failed");
      expect(errorEvent.error.code).toBe("sdk_error");
    });

    it("iterable completes (does not reject)", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFnThrows(new Error("Something went wrong")),
      });

      // This should NOT throw
      const events = await collectEvents(adapter.run(makeInput()));
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe("session file written", () => {
    it("creates session file in workDir", async () => {
      const workDir = await createTmpDir();
      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: fakeQueryFn(TEXT_TURN_MESSAGES),
      });

      const input = makeInput({ sessionId: "sess_file_test" });
      await collectEvents(adapter.run(input));

      // Session file should be written at workDir/sessionId/session.json
      const sessionDir = join(workDir, "sess_file_test");
      const files = await readdir(sessionDir);
      expect(files).toContain("session.json");
    });
  });

  describe("skills appended to system prompt", () => {
    it("concatenates agent.skills into the system prompt", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      const input = makeInput({
        agent: {
          model: "claude-sonnet-4-20250514",
          system: "You are a helpful assistant.",
          skills: ["Skill A instructions", "Skill B instructions"],
        },
      });

      await collectEvents(adapter.run(input));

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions.systemPrompt).toContain("You are a helpful assistant.");
      expect(capturedOptions.systemPrompt).toContain("Skill A instructions");
      expect(capturedOptions.systemPrompt).toContain("Skill B instructions");
    });
  });

  describe("MCP servers passed through", () => {
    it("passes mcpServers to query options", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      const input = makeInput({
        agent: {
          model: "claude-sonnet-4-20250514",
          system: "You are a helpful assistant.",
          mcpServers: [
            { name: "github", url: "https://mcp.github.com", transport: "sse" },
            { name: "jira", url: "https://mcp.jira.com" },
          ],
        },
      });

      await collectEvents(adapter.run(input));

      expect(capturedOptions).not.toBeNull();
      expect(capturedOptions.mcpServers).toEqual([
        { name: "github", url: "https://mcp.github.com", transport: "sse" },
        { name: "jira", url: "https://mcp.jira.com" },
      ]);
    });
  });

  describe("query options", () => {
    it("passes prompt from input.message text", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      const input = makeInput({
        message: {
          role: "user",
          content: [{ type: "text", text: "What is TypeScript?" }],
        },
      });

      await collectEvents(adapter.run(input));

      expect(capturedOptions.prompt).toBe("What is TypeScript?");
    });

    it("passes model from input.agent.model", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      await collectEvents(adapter.run(makeInput()));

      expect(capturedOptions.model).toBe("claude-sonnet-4-20250514");
    });

    it("passes sessionId as resume", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      const input = makeInput({ sessionId: "sess_resume_123" });
      await collectEvents(adapter.run(input));

      expect(capturedOptions.resume).toBe("sess_resume_123");
    });

    it("uses Claude CLI --resume when the project session file exists", async () => {
      const tmp = await createTmpDir();
      const homeDir = join(tmp, "home");
      const workDir = join(tmp, "workspace");
      const argsPath = join(tmp, "args.json");
      const sessionId = "sess_resume_123";
      const sessionUuid = sessionIdToUuidForTest(sessionId);
      const projectKey = workDir.replace(/\//g, "-");
      await mkdir(join(homeDir, ".claude", "projects", projectKey), {
        recursive: true,
      });
      await mkdir(workDir, { recursive: true });
      await writeFile(
        join(homeDir, ".claude", "projects", projectKey, `${sessionUuid}.jsonl`),
        "",
      );
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;

      try {
        const adapter = new ClaudeCodeAdapter({
          apiKey: "",
          workDir,
          command: await createFakeClaudeCommand(tmp, argsPath),
        });

        await collectEvents(adapter.run(makeInput({ sessionId })));

        const args = JSON.parse(await readFile(argsPath, "utf-8")) as string[];
        expect(args).toContain("--resume");
        expect(args).toContain(sessionUuid);
        expect(args).not.toContain("--session-id");
      } finally {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }
    });

    it("sets permissionMode to acceptEdits by default", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      await collectEvents(adapter.run(makeInput()));

      expect(capturedOptions.permissionMode).toBe("acceptEdits");
    });

    it("allows permissionMode override", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        permissionMode: "bypassPermissions",
        _queryFn: queryFn,
      });

      await collectEvents(adapter.run(makeInput()));

      expect(capturedOptions.permissionMode).toBe("bypassPermissions");
    });

    it("sets includePartialMessages to true", async () => {
      const workDir = await createTmpDir();
      let capturedOptions: any = null;

      const queryFn = async function* (options: any) {
        capturedOptions = options;
        for (const msg of TEXT_TURN_MESSAGES) {
          yield msg;
        }
      };

      const adapter = new ClaudeCodeAdapter({
        apiKey: "test-key",
        workDir,
        _queryFn: queryFn,
      });

      const input = makeInput();
      await collectEvents(adapter.run(input));

      expect(capturedOptions.includePartialMessages).toBe(true);
    });
  });
});
