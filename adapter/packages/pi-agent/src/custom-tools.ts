import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ToolExecutor } from "@open-managed-agents/adapter-core";

/**
 * Build the set of Pi `ToolDefinition`s that proxy into an injected
 * {@link ToolExecutor} (ADR-0002 §2 "Sandbox-as-Tool").
 *
 * These are passed to `createAgentSession({ customTools, noTools: "builtin" })`
 * so that Pi's own read/bash/edit/write tools are disabled and every tool the
 * model calls is executed through the per-run() executor instead. The set is
 * intentionally minimal — a shell/exec tool plus the file read/write/list
 * primitives that map 1:1 onto the ToolExecutor surface.
 *
 * Errors are never thrown from `execute()`; they are encoded as an error
 * `AgentToolResult` (isError-style content + `details.isError`) so a failing
 * tool flows back to the model as a tool result instead of aborting the run.
 */
export function buildCustomTools(executor: ToolExecutor): ToolDefinition[] {
  return [execTool(executor), readTool(executor), writeTool(executor), listTool(executor)];
}

/** Detail payload attached to each tool result (surfaced for logs / UI). */
interface ProxyDetails {
  isError: boolean;
}

function ok(text: string): AgentToolResult<ProxyDetails> {
  return { content: [{ type: "text", text }], details: { isError: false } };
}

function err(message: string): AgentToolResult<ProxyDetails> {
  return { content: [{ type: "text", text: message }], details: { isError: true } };
}

const ExecParams = Type.Object({
  command: Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Command to run. A string is executed via /bin/sh -c; an array is run as argv.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory, relative to the executor root." }),
  ),
  timeoutSeconds: Type.Optional(Type.Number()),
});

function argvFrom(command: string | string[]): string[] {
  return Array.isArray(command) ? command.map(String) : ["/bin/sh", "-c", command];
}

function execTool(executor: ToolExecutor): ToolDefinition {
  return defineTool({
    name: "exec",
    label: "Exec",
    description:
      "Run a shell command in the sandbox and return its combined output.",
    parameters: ExecParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ExecParams>,
    ): Promise<AgentToolResult<ProxyDetails>> {
      try {
        let out = "";
        for await (const chunk of executor.exec(argvFrom(params.command), {
          cwd: params.cwd,
          timeoutSeconds: params.timeoutSeconds,
        })) {
          out += chunk.text;
        }
        return ok(out);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

const ReadParams = Type.Object({
  path: Type.String({ description: "File path relative to the executor root." }),
});

function readTool(executor: ToolExecutor): ToolDefinition {
  return defineTool({
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the sandbox.",
    parameters: ReadParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ReadParams>,
    ): Promise<AgentToolResult<ProxyDetails>> {
      try {
        return ok(await executor.readFile(params.path));
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

const WriteParams = Type.Object({
  path: Type.String({ description: "File path relative to the executor root." }),
  content: Type.String({ description: "UTF-8 content to write." }),
});

function writeTool(executor: ToolExecutor): ToolDefinition {
  return defineTool({
    name: "write_file",
    label: "Write file",
    description: "Write a UTF-8 text file to the sandbox, creating parents as needed.",
    parameters: WriteParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof WriteParams>,
    ): Promise<AgentToolResult<ProxyDetails>> {
      try {
        await executor.writeFile(params.path, params.content);
        return ok(`Wrote ${params.content.length} bytes to ${params.path}`);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

const ListParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description: "Directory or glob to list, relative to the executor root. Omit for the full tree.",
    }),
  ),
});

function listTool(executor: ToolExecutor): ToolDefinition {
  return defineTool({
    name: "list_files",
    label: "List files",
    description: "List files in the sandbox. With no path, lists the full tree.",
    parameters: ListParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ListParams>,
    ): Promise<AgentToolResult<ProxyDetails>> {
      try {
        const entries = await executor.list(params.path);
        return ok(entries.map((e) => e.path).join("\n"));
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}
