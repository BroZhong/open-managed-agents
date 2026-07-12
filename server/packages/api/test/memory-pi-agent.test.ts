import { describe, expect, it } from "vitest";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";
import { memoryPiAgentAdapter } from "../src/lib/memory-pi-agent.js";

describe("default in-memory development Pi adapter", () => {
  it("uses the canonical SDK adapter with managed MCP projection", () => {
    expect(memoryPiAgentAdapter).toBeInstanceOf(PiAgentAdapter);
  });
});
