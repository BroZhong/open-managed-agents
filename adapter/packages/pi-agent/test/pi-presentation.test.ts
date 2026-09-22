import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiPresentation } from "../src/pi-presentation.js";

it("retains MCP identity as selectors without copying gateway arguments or result content", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "assistant", provider: "test", api: "openai-completions", model: "test", timestamp: 1, stopReason: "toolUse",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "toolCall", id: "call1", name: "mcp", arguments: { tool: "my_server_search", args: '{"query":"original input"}' } }] });
  manager.appendMessage({ role: "toolResult", toolCallId: "call1", toolName: "mcp", content: [{ type: "text", text: "original result" }], isError: false, timestamp: 2 });
  const presenter = new PiPresentation(["my-server"]);
  const entries = manager.getEntries();
  expect(presenter.describe(entries[0])).toEqual({ version: 1, blocks: [{ type: "agent.mcp_tool_use", index: 0, name: "search", serverName: "my-server" }] });
  expect(presenter.describe(entries[1])).toEqual({ version: 1, blocks: [{ type: "agent.mcp_tool_result", serverName: "my-server" }] });
});

it("derives a failure for an unexecuted call from an aborted native assistant", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "assistant", provider: "test", api: "openai-completions", model: "test", timestamp: 1, stopReason: "aborted",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "toolCall", id: "partial", name: "read", arguments: {} }] });
  expect(new PiPresentation([]).describe(manager.getEntries()[0])).toEqual({ version: 1, blocks: [{ type: "agent.tool_use", index: 0 }, { type: "agent.tool_result", index: 0, unexecuted: "aborted" }] });
});
