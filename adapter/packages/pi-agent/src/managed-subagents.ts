import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostSubagentCapability, SessionEvent } from "@open-managed-agents/adapter-core";

/** These tools carry no Session/Tenant arguments: the Host supplies authority. */
export function buildSubagentTools(host: HostSubagentCapability, checkpoint: () => SessionEvent[]): ToolDefinition[] {
  const child = Type.String({ minLength: 1 });
  const optionalExecution = Type.Optional(Type.String({ minLength: 1 }));
  const tools: ToolDefinition[] = [
    defineTool({
      name: "Agent", label: "Delegate task",
      description: "Delegate a general-purpose task in a durable child Session sharing this Workspace and Sandbox. No subtype is required. Defaults to synchronous waiting in this Turn; run_in_background=true lets this Turn finish and delivers a later result. resume continues the same child in a new child Turn. Children cannot delegate or use Web/MCP, default to 30 model steps, and may leave partial files on failure. Interrupt of a synchronous caller stops its own synchronous delegation; background children continue independently.",
      parameters: Type.Object({ prompt: Type.String({ minLength: 1 }), resume: Type.Optional(child), subagent_type: Type.Optional(Type.Literal("general-purpose")), run_in_background: Type.Optional(Type.Boolean({ default: false })), model: Type.Optional(Type.String({ minLength: 1 })), thinking: Type.Optional(Type.String()), max_steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }, { additionalProperties: false }),
      async execute(toolUseId, args, signal) {
        validateArguments(args, ["prompt", "resume", "subagent_type", "run_in_background", "model", "thinking", "max_steps"]);
        if (args.subagent_type !== undefined && args.subagent_type !== "general-purpose") throw new Error("Only general-purpose delegation is supported; no subtype is required");
        requiredText(args.prompt, "prompt");
        optionalBoolean(args.run_in_background, "run_in_background");
        optionalText(args.resume, "resume"); optionalText(args.model, "model"); optionalText(args.thinking, "thinking");
        if (args.max_steps !== undefined && (!Number.isInteger(args.max_steps) || args.max_steps < 1 || args.max_steps > 1000)) throw new Error("max_steps must be an integer between 1 and 1000");
        return result(await host.delegate({ prompt: args.prompt, runInBackground: args.run_in_background ?? false, ...(args.resume !== undefined ? { resume: args.resume } : {}), ...(args.model !== undefined ? { model: args.model } : {}), ...(args.thinking !== undefined ? { thinking: args.thinking } : {}), ...(args.max_steps !== undefined ? { maxSteps: args.max_steps } : {}) }, { toolUseId, signal, checkpoint: checkpoint() }));
      },
    }),
    defineTool({
      name: "get_subagent_result", label: "Get child result",
      description: "Read durable child status and the selected execution's output and trace. wait=false returns queued/running immediately; wait=true holds this same Turn until that execution reaches a real terminal state. executionId fixes the execution when a child has multiple resumes. Results describe execution status, not artifact acceptance.",
      parameters: Type.Object({ childId: child, executionId: optionalExecution, wait: Type.Optional(Type.Boolean({ default: false })) }, { additionalProperties: false }),
      async execute(toolUseId, args, signal) {
        validateArguments(args, ["childId", "executionId", "wait"]); requiredText(args.childId, "childId"); optionalText(args.executionId, "executionId"); optionalBoolean(args.wait, "wait");
        return result(await host.getResult({ childId: args.childId, ...(args.executionId ? { executionId: args.executionId } : {}), wait: args.wait ?? false }, { toolUseId, signal, checkpoint: checkpoint() }));
      },
    }),
    defineTool({
      name: "steer_subagent", label: "Steer child",
      description: "Persist an instruction for a selected queued or running child execution. accepted means queued for a safe model boundary; applied means injected. A terminal execution requires Agent(resume=childId,prompt=...). Instructions never transfer to a later resume.",
      parameters: Type.Object({ childId: child, executionId: optionalExecution, message: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      async execute(toolUseId, args, signal) {
        validateArguments(args, ["childId", "executionId", "message"]); requiredText(args.childId, "childId"); requiredText(args.message, "message"); optionalText(args.executionId, "executionId");
        return result(await host.steer({ childId: args.childId, message: args.message, ...(args.executionId ? { executionId: args.executionId } : {}) }, { toolUseId, signal, checkpoint: checkpoint() }));
      },
    }),
  ];
  return tools;
}
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) ?? "null" }], details: value }; }
function requiredText(value: unknown, name: string): asserts value is string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); }
function optionalText(value: unknown, name: string) { if (value !== undefined) requiredText(value, name); }
function optionalBoolean(value: unknown, name: string) { if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`); }
function validateArguments(args: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`Unsupported delegation parameter: ${key}`);
}
