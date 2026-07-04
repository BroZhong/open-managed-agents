import type { ToolExecutor } from "@open-managed-agents/adapter-core";

/**
 * Result of routing a single tool call through a {@link ToolExecutor}.
 */
export interface RoutedToolResult {
  text: string;
  isError: boolean;
}

/**
 * Decide whether a given tool call is one this adapter knows how to execute
 * through the injected {@link ToolExecutor}. The set is intentionally small:
 * a shell/exec tool plus the file read/write/list primitives that map 1:1
 * onto the {@link ToolExecutor} surface. Anything else is left to Pi's own
 * runtime (returns `false`).
 */
export function isRoutableTool(name: string): boolean {
  return ROUTABLE.has(name.toLowerCase());
}

const ROUTABLE = new Set([
  "shell",
  "exec",
  "bash",
  "run",
  "read_file",
  "readfile",
  "read",
  "write_file",
  "writefile",
  "write",
  "list_files",
  "listfiles",
  "list",
  "ls",
]);

function asRecord(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null
    ? (args as Record<string, unknown>)
    : {};
}

function argvFromCommand(args: Record<string, unknown>): string[] {
  // Accept either an argv array (`command: string[]`) or a single string that
  // we run via a shell so operators/pipes still work.
  const cmd = args.command ?? args.cmd ?? args.script;
  if (Array.isArray(cmd)) return cmd.map((c) => String(c));
  if (typeof cmd === "string") return ["/bin/sh", "-c", cmd];
  throw new Error("shell tool call missing 'command'");
}

/**
 * Execute one intercepted tool call against the injected executor and collect
 * its output into a single {@link RoutedToolResult}. Errors are captured as
 * `isError: true` results rather than thrown, so a failing tool never aborts
 * the run — it flows back to the agent as a tool result, exactly as a real
 * runtime would surface it.
 */
export async function routeToolCall(
  executor: ToolExecutor,
  name: string,
  rawArgs: unknown,
): Promise<RoutedToolResult> {
  const args = asRecord(rawArgs);
  const lower = name.toLowerCase();
  try {
    switch (lower) {
      case "shell":
      case "exec":
      case "bash":
      case "run": {
        const argv = argvFromCommand(args);
        let out = "";
        for await (const chunk of executor.exec(argv, {
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          timeoutSeconds:
            typeof args.timeoutSeconds === "number"
              ? args.timeoutSeconds
              : undefined,
        })) {
          out += chunk.text;
        }
        return { text: out, isError: false };
      }

      case "read_file":
      case "readfile":
      case "read": {
        const path = String(args.path ?? args.file ?? "");
        if (!path) throw new Error("read tool call missing 'path'");
        const text = await executor.readFile(path);
        return { text, isError: false };
      }

      case "write_file":
      case "writefile":
      case "write": {
        const path = String(args.path ?? args.file ?? "");
        if (!path) throw new Error("write tool call missing 'path'");
        const content = String(args.content ?? args.text ?? "");
        await executor.writeFile(path, content);
        return { text: `Wrote ${content.length} bytes to ${path}`, isError: false };
      }

      case "list_files":
      case "listfiles":
      case "list":
      case "ls": {
        const target =
          typeof args.path === "string"
            ? args.path
            : typeof args.glob === "string"
              ? args.glob
              : undefined;
        const entries = await executor.list(target);
        return {
          text: entries.map((e) => e.path).join("\n"),
          isError: false,
        };
      }

      default:
        throw new Error(`tool '${name}' is not routable`);
    }
  } catch (err: unknown) {
    return {
      text: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}
