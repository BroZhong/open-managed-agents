import { describe, it, expect } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { eventLogToAgentMessages } from "../src/event-log-to-messages.js";

/**
 * Equivalence check for ADR-0003: prove that the history the Pi Adapter feeds
 * the model — rebuilt from the canonical event log by `eventLogToAgentMessages`
 * — is equivalent to the history the Pi SDK produces on its own "load a session
 * and resolve it for the LLM" path.
 *
 * "Directly loading the JSONL" in this codebase = the Pi SDK's on-disk session
 * path: entries are appended to a `SessionManager` (`appendMessage`, the same
 * call the adapter makes at `pi-agent-adapter.ts`) and then resolved for the
 * model via `SessionManager.buildSessionContext().messages`. That resolver is
 * identical whether the SessionManager was hydrated from a `.jsonl` file
 * (`SessionManager.open`) or seeded in memory — so seeding in memory and
 * reading `buildSessionContext()` back exercises the exact same normalization
 * the disk path would.
 *
 * So the two paths under test are:
 *   A. eventLog → `eventLogToAgentMessages` → Message[]                (our translator)
 *   B. those messages → `appendMessage` → `buildSessionContext()`      (SDK resolver = disk path)
 *
 * If A === B after normalization, the adapter's rebuilt history is byte-for-byte
 * what the SDK itself would resolve for the model. We compare the message
 * sequence, content (text/toolCall/toolResult), tool-id pairing, and the
 * assistant origin provider/api/model — and ignore only SDK-owned, non-semantic
 * metadata (entry id/parentId, timestamps, token usage, stopReason).
 */

// ─── Fixtures: history reaches the adapter shaped as `{ type, ...data }` ──────

function userMessage(text: string): SessionEvent {
  return {
    id: "sevt_u",
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "user.message",
    data: { content: [{ type: "text", text }] },
  } as unknown as SessionEvent;
}

function agentMessage(
  text: string,
  origin?: { provider?: string; api?: string; model?: string },
): SessionEvent {
  return {
    id: "sevt_a",
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "agent.message",
    content: [{ type: "text", text }],
    ...origin,
  } as unknown as SessionEvent;
}

function toolUse(
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    id: "sevt_tu",
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "agent.tool_use",
    toolUseId,
    name,
    input,
  } as unknown as SessionEvent;
}

function toolResult(
  toolUseId: string,
  text: string,
  isError = false,
): SessionEvent {
  return {
    id: "sevt_tr",
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "agent.tool_result",
    toolUseId,
    content: [{ type: "text", text }],
    isError,
  } as unknown as SessionEvent;
}

function mcpToolUse(
  toolUseId: string,
  serverName: string,
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    id: "sevt_mcp_tu",
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "agent.mcp_tool_use",
    toolUseId,
    serverName,
    name,
    input,
  } as unknown as SessionEvent;
}

function mcpToolResult(
  toolUseId: string,
  serverName: string,
  text: string,
  isError = false,
): SessionEvent {
  return {
    id: "sevt_mcp_tr",
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "agent.mcp_tool_result",
    toolUseId,
    serverName,
    content: [{ type: "text", text }],
    isError,
  } as unknown as SessionEvent;
}

// ─── Path B: run our messages through the SDK's own resolver ──────────────────

/**
 * Seed a `SessionManager.inMemory()` with the given messages via the public
 * `appendMessage` (auto-generating entry ids/parentId — the disk representation)
 * and read them back through `buildSessionContext()` — the SDK's "resolve the
 * session for the LLM" step, shared with the `SessionManager.open(<jsonl>)` path.
 */
function throughSdkResolver(messages: Message[]): Message[] {
  const sm = SessionManager.inMemory();
  for (const m of messages) {
    sm.appendMessage(m as never);
  }
  // buildSessionContext().messages is the SDK's resolved LLM history (the same
  // AgentMessage shape our Message[] carries); treat it as Message[] here.
  return sm.buildSessionContext().messages as unknown as Message[];
}

// ─── Normalization: keep semantics, drop SDK-owned metadata ───────────────────

interface NormalizedMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  provider?: string;
  api?: string;
  model?: string;
}

function normalize(messages: Message[]): NormalizedMessage[] {
  return messages.map((m) => {
    const anyM = m as unknown as Record<string, unknown>;
    const out: NormalizedMessage = {
      role: anyM.role as string,
      // content carries text / toolCall / toolResult blocks — the semantic core.
      content: anyM.content,
    };
    // Tool-result pairing key + error flag are semantic; keep when present.
    if ("toolCallId" in anyM) out.toolCallId = anyM.toolCallId as string;
    if ("toolName" in anyM) out.toolName = anyM.toolName as string;
    if ("isError" in anyM) out.isError = anyM.isError as boolean;
    // Assistant origin — must survive both paths (drives isSameModel).
    if ("provider" in anyM) out.provider = anyM.provider as string;
    if ("api" in anyM) out.api = anyM.api as string;
    if ("model" in anyM) out.model = anyM.model as string;
    // Deliberately ignored (SDK-owned, non-semantic): id, parentId, timestamp,
    // usage, stopReason, diagnostics, responseId.
    return out;
  });
}

function assertEquivalent(events: SessionEvent[]) {
  const rebuilt = eventLogToAgentMessages(events);
  const viaSdk = throughSdkResolver(rebuilt);
  expect(normalize(rebuilt)).toEqual(normalize(viaSdk));
  return rebuilt;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("eventLogToAgentMessages ≡ Pi SDK session resolver (ADR-0003)", () => {
  it("empty history round-trips to empty", () => {
    const rebuilt = assertEquivalent([]);
    expect(rebuilt).toHaveLength(0);
  });

  it("plain text turn (user + assistant) is equivalent", () => {
    assertEquivalent([userMessage("hello"), agentMessage("hi there")]);
  });

  it("a full tool-call turn is equivalent (toolCall id ↔ toolResult pairing survives)", () => {
    const rebuilt = assertEquivalent([
      userMessage("list files"),
      agentMessage("Let me look.", { provider: "anthropic", api: "messages", model: "claude-sonnet-4-6" }),
      toolUse("tc_1", "exec", { command: "ls" }),
      toolResult("tc_1", "a.ts\nb.ts"),
      agentMessage("Found 2 files."),
    ]);
    // The assistant turn interleaves text + toolCall in one message.
    const assistant = rebuilt[1] as unknown as { content: { type: string; id?: string }[] };
    expect(assistant.content.map((b) => b.type)).toEqual(["text", "toolCall"]);
    expect(assistant.content.find((b) => b.type === "toolCall")?.id).toBe("tc_1");
  });

  it("a canonical MCP turn resolves as Pi's generic gateway call", () => {
    const rebuilt = assertEquivalent([
      userMessage("review recent sessions"),
      agentMessage("Querying."),
      mcpToolUse(
        "mcp_tc_1",
        "session-data",
        "query_recent_sessions",
        { days: 7 },
      ),
      mcpToolResult(
        "mcp_tc_1",
        "session-data",
        '{"sessions":[]}',
        true,
      ),
    ]);

    const assistant = rebuilt[1] as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(assistant.content).toContainEqual({
      type: "toolCall",
      id: "mcp_tc_1",
      name: "mcp",
      arguments: {
        tool: "session_data_query_recent_sessions",
        args: '{"days":7}',
        server: "session-data",
      },
    });
    expect(rebuilt[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "mcp_tc_1",
      toolName: "mcp",
      content: [{ type: "text", text: '{"sessions":[]}' }],
      isError: true,
    });
  });

  it("multi-turn conversation with several tool calls is equivalent", () => {
    assertEquivalent([
      userMessage("build the project"),
      agentMessage("Running the build.", { provider: "anthropic", api: "messages", model: "claude-opus-4-8" }),
      toolUse("tc_a", "exec", { command: "pnpm build" }),
      toolResult("tc_a", "build ok"),
      agentMessage("Now the tests."),
      toolUse("tc_b", "exec", { command: "pnpm test" }),
      toolResult("tc_b", "3 failing", true),
      agentMessage("3 tests fail; investigating."),
      userMessage("show me the first failure"),
      agentMessage("Here it is.", { provider: "openai", api: "responses", model: "gpt-5" }),
    ]);
  });

  it("an errored tool result keeps its isError flag through both paths", () => {
    const rebuilt = assertEquivalent([
      userMessage("cat missing.txt"),
      agentMessage("Reading it."),
      toolUse("tc_e", "read_file", { path: "missing.txt" }),
      toolResult("tc_e", "ENOENT: no such file", true),
    ]);
    const result = rebuilt.find(
      (m) => (m as unknown as { role: string }).role === "toolResult",
    ) as unknown as { isError: boolean };
    expect(result.isError).toBe(true);
  });

  it("streaming/lifecycle/thinking noise is filtered identically on both paths", () => {
    assertEquivalent([
      userMessage("hi"),
      { id: "s1", timestamp: "t", type: "session.status_running", data: {} } as unknown as SessionEvent,
      { id: "s2", timestamp: "t", type: "agent.message_stream_start", data: {} } as unknown as SessionEvent,
      { id: "s3", timestamp: "t", type: "agent.message_chunk", data: { text: "par" } } as unknown as SessionEvent,
      { id: "s4", timestamp: "t", type: "agent.thinking", data: { text: "hmm" } } as unknown as SessionEvent,
      agentMessage("done"),
      { id: "s5", timestamp: "t", type: "span.model_request_end", data: {} } as unknown as SessionEvent,
    ]);
  });
});
