import { describe, expect, it } from "vitest";
import type {
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createManagedSubagentToolsExtension,
  createManagedSubagentUsageExtension,
  MANAGED_SUBAGENT_USAGE_EVENT,
} from "../src/subagent-tool-bridge.js";

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
  factory: ExtensionFactory,
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
      ]),
    ).toThrow(/missing managed Sandbox tools.*bash.*write/i);
  });

  it("isolates concurrent parent sessions and removes each capability on shutdown", () => {
    const toolsA = completeTools("a");
    const toolsB = completeTools("b");
    const eventsA = new FakeEventBus();
    const eventsB = new FakeEventBus();
    const handlersA = bind(createManagedSubagentToolsExtension(toolsA), eventsA);
    bind(createManagedSubagentToolsExtension(toolsB), eventsB);

    expect(requestTools(eventsA, "a")).toBe(toolsA);
    expect(requestTools(eventsB, "b")).toBe(toolsB);

    handlersA.get("session_shutdown")!({ type: "session_shutdown" });
    expect(requestTools(eventsA, "after-shutdown")).toBeUndefined();
    expect(requestTools(eventsB, "still-live")).toBe(toolsB);
  });

  it("forwards complete child usage and removes the listener on shutdown", () => {
    const events = new FakeEventBus();
    const reported: unknown[] = [];
    const handlers = bind(
      createManagedSubagentUsageExtension((usage) => {
        reported.push(usage);
      }),
      events,
    );

    events.emit(MANAGED_SUBAGENT_USAGE_EVENT, {
      subagentId: "child-1",
      input: 60,
      output: 5,
      cacheRead: 30,
      cacheWrite: 10,
    });
    events.emit(MANAGED_SUBAGENT_USAGE_EVENT, {
      subagentId: "malformed",
      input: 1,
      output: 2,
      cacheRead: 3,
    });
    events.emit(MANAGED_SUBAGENT_USAGE_EVENT, {
      subagentId: "fractional",
      input: 1.5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });
    events.emit(MANAGED_SUBAGENT_USAGE_EVENT, {
      subagentId: "negative",
      input: -1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
    });

    expect(reported).toEqual([
      {
        subagentId: "child-1",
        input: 60,
        output: 5,
        cacheRead: 30,
        cacheWrite: 10,
      },
    ]);

    handlers.get("session_shutdown")!({ type: "session_shutdown" });
    events.emit(MANAGED_SUBAGENT_USAGE_EVENT, {
      subagentId: "after-shutdown",
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
    });
    expect(reported).toHaveLength(1);
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
