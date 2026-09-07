import { describe, expect, it } from "vitest";
import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createManagedSubagentToolsExtension } from "../src/subagent-tool-bridge.js";

type Handler = (event: { type: string }) => void;

class FakeEventBus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void) {
    const listeners = this.handlers.get(channel) ?? new Set();
    listeners.add(handler);
    this.handlers.set(channel, listeners);
    return () => listeners.delete(handler);
  }

  emit(channel: string, data: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

function bind(
  factory: ReturnType<typeof createManagedSubagentToolsExtension>,
  events: FakeEventBus,
) {
  const handlers = new Map<string, Handler>();
  factory({
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as never);
  return handlers;
}

describe("managed subagent Sandbox tool bridge", () => {
  it("fails closed unless every Sandbox-backed Pi tool is present", () => {
    expect(() =>
      createManagedSubagentToolsExtension([
        { name: "read" } as ToolDefinition,
      ], {} as ModelRuntime),
    ).toThrow(/missing managed Sandbox tools.*bash.*write/i);
  });

  it("isolates concurrent parent sessions and removes each capability on shutdown", () => {
    const toolsA = completeTools("a");
    const toolsB = completeTools("b");
    const eventsA = new FakeEventBus();
    const eventsB = new FakeEventBus();
    const runtimeA = { marker: "a" } as unknown as ModelRuntime;
    const runtimeB = { marker: "b" } as unknown as ModelRuntime;
    const handlersA = bind(createManagedSubagentToolsExtension(toolsA, runtimeA), eventsA);
    bind(createManagedSubagentToolsExtension(toolsB, runtimeB), eventsB);

    expect(requestTools(eventsA, "a")).toBe(toolsA);
    expect(requestTools(eventsB, "b")).toBe(toolsB);
    let receivedRuntime: unknown;
    eventsA.on("oma:sandbox-tools:v1:get:reply:runtime", (data) => {
      receivedRuntime = (data as { modelRuntime: unknown }).modelRuntime;
    });
    eventsA.emit("oma:sandbox-tools:v1:get", { requestId: "runtime" });
    expect(receivedRuntime).toBe(runtimeA);

    handlersA.get("session_shutdown")!({ type: "session_shutdown" });
    expect(requestTools(eventsA, "after-shutdown")).toBeUndefined();
    expect(requestTools(eventsB, "still-live")).toBe(toolsB);
  });
});

function completeTools(marker: string): ToolDefinition[] {
  return ["bash", "read", "write", "edit", "ls", "grep", "find"].map(
    (name) => ({ name, marker }) as unknown as ToolDefinition,
  );
}

function requestTools(
  events: FakeEventBus,
  requestId: string,
): ToolDefinition[] | undefined {
  let tools: ToolDefinition[] | undefined;
  events.on(`oma:sandbox-tools:v1:get:reply:${requestId}`, (data) => {
    tools = (data as { tools?: ToolDefinition[] }).tools;
  });
  events.emit("oma:sandbox-tools:v1:get", { requestId });
  return tools;
}
