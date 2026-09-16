import { describe, expect, it, vi } from "vitest";
import { buildSubagentTools } from "../src/managed-subagents.js";
import type { HostSubagentCapability } from "@open-managed-agents/adapter-core";

const capability = (maxModelSteps = 30): HostSubagentCapability => ({ maxModelSteps, delegate: vi.fn(async () => ({ childId: "child", mode: "sync" })), getResult: vi.fn(async () => ({})), steer: vi.fn(async () => ({})) });

describe("Host delegation tool boundary", () => {
  it("defaults to synchronous generic delegation and passes only Host-bound context", async () => {
    const host = capability();
    const tools = buildSubagentTools(host, () => []);
    expect(tools.map(t => t.name)).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
    await tools[0].execute("tool-id", { prompt: "write a file" }, undefined, undefined, {} as never);
    expect(host.delegate).toHaveBeenCalledWith({ prompt: "write a file", runInBackground: false }, { toolUseId: "tool-id", signal: undefined, checkpoint: [] });
    expect(JSON.stringify(tools[0].parameters)).not.toContain("worktree");
    expect(tools[0].parameters).not.toHaveProperty("properties.model");
    expect(tools[0].description).toContain("same model as the calling parent Turn");
  });
});

describe("delegation validation", () => {
  it.each(["worktree", "isolated", "tenantId", "parentSessionId", "model"])("rejects unsupported %s before calling the Host", async (key) => {
    const host = capability();
    await expect(buildSubagentTools(host, () => [])[0].execute("id", { prompt: "task", [key]: true }, undefined, undefined, {} as never)).rejects.toThrow("Unsupported delegation parameter");
    expect(host.delegate).not.toHaveBeenCalled();
  });
  it.each([undefined, "child"])("rejects a model override for create/resume (%s)", async (resume) => {
    const host = capability();
    await expect(buildSubagentTools(host, () => [])[0].execute("id", { prompt: "task", resume, model: "other-provider/other-model" }, undefined, undefined, {} as never))
      .rejects.toThrow("Unsupported delegation parameter: model");
    expect(host.delegate).not.toHaveBeenCalled();
  });
  it("uses identical explicit background mode for create and resume", async () => {
    const host = capability();
    const tool = buildSubagentTools(host, () => [])[0];
    for (const resume of [undefined, "child"]) for (const mode of [true, false]) {
      await tool.execute("id", { prompt: "task", ...(resume ? { resume } : {}), run_in_background: mode }, undefined, undefined, {} as never);
      expect(host.delegate).toHaveBeenLastCalledWith({ prompt: "task", ...(resume ? { resume } : {}), runInBackground: mode }, expect.anything());
    }
  });
  it.each([7, 30, 250])("advertises and enforces the Host limit of %i model steps", async (maximum) => {
    const host = capability(maximum);
    const tool = buildSubagentTools(host, () => [])[0];
    expect(tool.parameters).toMatchObject({ properties: { max_steps: {
      minimum: 1, maximum, default: Math.min(30, maximum),
    } } });
    expect(tool.description).toContain(`at most ${maximum} model steps`);
    expect(tool.description).toContain(`default to ${Math.min(30, maximum)} model steps`);
    await expect(tool.execute("over-budget", { prompt: "task", max_steps: maximum + 1 }, undefined, undefined, {} as never))
      .rejects.toThrow(`max_steps must be an integer between 1 and ${maximum}`);
    expect(host.delegate).not.toHaveBeenCalled();
    await tool.execute("within-budget", { prompt: "task", max_steps: maximum }, undefined, undefined, {} as never);
    expect(host.delegate).toHaveBeenCalledWith({ prompt: "task", runInBackground: false, maxSteps: maximum }, expect.anything());
  });
  it("does not accept business subtypes or invalid execution budgets", async () => {
    const tool = buildSubagentTools(capability(), () => [])[0];
    for (const args of [{ subagent_type: "storyboard" }, { max_steps: 0 }, { max_steps: 1001 }, { max_steps: 2.5 }]) await expect(tool.execute("id", { prompt: "task", ...args }, undefined, undefined, {} as never)).rejects.toThrow();
  });
});
