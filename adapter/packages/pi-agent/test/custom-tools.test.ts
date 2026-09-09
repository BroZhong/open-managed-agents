import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";
import { MemoryFileSystem } from "./memory-file-system.js";
import { buildCustomTools } from "../src/custom-tools.js";

/**
 * A purely in-memory {@link ToolExecutor} — a map from workspace-relative path
 * to file content plus a faithful byte/metadata filesystem fixture, no Host
 * filesystem at all. Every fs/exec call is recorded in
 * {@link MemExecutor.calls} so a test can assert the operations landed here and
 * never touched the Host disk. `list` mirrors the real contract: directories
 * are omitted; a file path returns exactly that entry; a directory returns all
 * files under it (recursively); a `*` glob filters on a simple `**`/`*` match.
 */
class MemExecutor implements ToolExecutor {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  readonly fileSystem = new MemoryFileSystem(this.files, this.calls);
  /** The `opts` object of the most recent `exec` call, for timeout/signal assertions. */
  lastExecOpts?: ExecOptions;
  duringExec?: () => void;

  seed(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  async *exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk> {
    this.calls.push(`exec ${command.join(" ")} @${opts?.cwd ?? "."}`);
    this.lastExecOpts = opts;
    this.duringExec?.();
    yield { stream: "stdout", text: `ran: ${command[command.length - 1]}` };
    opts?.onExit?.({ exitCode: 0 });
  }

  async readFile(path: string): Promise<string> {
    this.calls.push(`read ${path}`);
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push(`write ${path}`);
    this.files.set(path, content);
  }

  async list(globOrDir?: string): Promise<FileListEntry[]> {
    this.calls.push(`list ${globOrDir ?? "."}`);
    const all = [...this.files.keys()];
    const entry = (p: string): FileListEntry => ({ path: p, size: 0, mtimeMs: 0 });
    if (!globOrDir || globOrDir === ".") return all.map(entry);
    if (globOrDir.includes("*")) {
      const re = new RegExp(
        "^" +
          globOrDir
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*\//g, "(?:.*/)?")
            .replace(/\*/g, "[^/]*") +
          "$",
      );
      return all.filter((p) => re.test(p)).map(entry);
    }
    // Exact file, or a directory prefix.
    if (this.files.has(globOrDir)) return [entry(globOrDir)];
    const prefix = `${globOrDir}/`;
    return all.filter((p) => p.startsWith(prefix)).map(entry);
  }
}

function toolByName(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool named ${name}; have ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

async function run(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const result = await tool.execute(
    "tc",
    args as never,
    signal as never,
    undefined,
    {} as never,
  );
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("buildCustomTools — Pi native factories redirected into the executor", () => {
  it("rejects a legacy text-only executor instead of falling back to Host filesystem", () => {
    const inner = new MemExecutor();
    const legacy: ToolExecutor = {
      exec: inner.exec.bind(inner), readFile: inner.readFile.bind(inner),
      writeFile: inner.writeFile.bind(inner), list: inner.list.bind(inner),
    };
    expect(() => buildCustomTools(legacy)).toThrow("native fileSystem operations");
    expect(inner.calls).toEqual([]);
  });
  it("exposes the Pi-native tool set with native names", () => {
    const tools = buildCustomTools(new MemExecutor());
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"].sort(),
    );
  });

  it("write lands on the executor with a workspace-relative path", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    await run(toolByName(tools, "write"), { path: "sub/note.txt", content: "hello" });
    // The model-facing path was resolved against /home/user and stripped back
    // to the workspace-relative path the executor expects.
    expect(ex.files.get("sub/note.txt")).toBe("hello");
    expect(ex.calls).toContain("write sub/note.txt");
  });

  it("treats /home/user as the canonical model-visible workspace root", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);

    await run(toolByName(tools, "write"), {
      path: "/home/user/sub/note.txt",
      content: "canonical-root",
    });

    expect(ex.files.get("sub/note.txt")).toBe("canonical-root");
    expect(ex.files.has("/home/user/sub/note.txt")).toBe(false);
    expect(ex.calls).toContain("write sub/note.txt");
  });

  it("read pulls the file back through the executor", async () => {
    const ex = new MemExecutor().seed("note.txt", "read-me");
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "read"), { path: "note.txt" });
    expect(out).toBe("read-me");
    expect(ex.calls).toContain("read note.txt");
    expect(ex.calls.some((call) => call.startsWith("exec "))).toBe(false);
  });

  it("keeps /skills absolute and outside the /home/user Workspace mapping", async () => {
    const skillPath = "/skills/skill_abc/SKILL.md";
    const ex = new MemExecutor().seed(skillPath, "# Projected Skill");
    const tools = buildCustomTools(ex);

    const out = await run(toolByName(tools, "read"), { path: skillPath });

    expect(out).toBe("# Projected Skill");
    expect(ex.calls).toContain(`read ${skillPath}`);
    expect(ex.calls).not.toContain("read skills/skill_abc/SKILL.md");
    expect(ex.calls).not.toContain("read /home/user/skills/skill_abc/SKILL.md");
  });

  it("edit reads, applies the patch, and writes back through the executor", async () => {
    const ex = new MemExecutor().seed("code.ts", "const a = 1;\nconst b = 2;\n");
    const tools = buildCustomTools(ex);
    await run(toolByName(tools, "edit"), {
      path: "code.ts",
      edits: [{ oldText: "const b = 2;", newText: "const b = 3;" }],
    });
    expect(ex.files.get("code.ts")).toBe("const a = 1;\nconst b = 3;\n");
    expect(ex.calls).toContain("write code.ts");
  });

  it("bash runs the command as bash through the executor", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "bash"), { command: "echo hi" });
    expect(out).toContain("ran: echo hi");
    expect(ex.calls.some((call) => /^exec (?:\/bin\/)?bash -c echo hi @\.$/.test(call))).toBe(true);
  });

  it("keeps the backend deadline disabled when Pi owns a timeout", async () => {
    // Native Pi validates and renders seconds. The bridge owns its timer so
    // deadline output and cancellation remain distinguishable; a second
    // backend deadline would race it and lose the native error context.
    const ex = new MemExecutor();
    await run(toolByName(buildCustomTools(ex), "bash"), { command: "sleep 1", timeout: 40 });
    expect(ex.lastExecOpts?.timeoutSeconds).toBe(0);
  });

  it("bash with no model timeout disables the timeout via timeoutSeconds: 0 (#81)", async () => {
    // Pi's bash schema documents "no default timeout" when omitted. We encode
    // that as `timeoutSeconds: 0` (= disabled, mirroring e2b `timeoutMs: 0`),
    // NOT `undefined` (which would fall through to a backend default).
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    await run(toolByName(tools, "bash"), { command: "echo hi" });
    expect(ex.lastExecOpts?.timeoutSeconds).toBe(0);
  });

  it("forwards Pi cancellation into the executor's process signal (#84)", async () => {
    const ex = new MemExecutor();
    const controller = new AbortController();
    ex.duringExec = () => controller.abort();
    await expect(run(toolByName(buildCustomTools(ex), "bash"), { command: "echo hi" }, controller.signal))
      .rejects.toThrow("Command aborted");
    expect(ex.lastExecOpts?.signal?.aborted).toBe(true);
  });

  it("ls lists a directory's immediate children via the executor", async () => {
    const ex = new MemExecutor()
      .seed("dir/a.txt", "a")
      .seed("dir/b.txt", "b")
      .seed("dir/nested/c.txt", "c");
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "ls"), { path: "dir" });
    // Immediate children only: two files plus the nested directory (with a
    // trailing slash from Pi's directory indicator).
    expect(out.split("\n").sort()).toEqual(["a.txt", "b.txt", "nested/"].sort());
    expect(ex.calls).toContain("readdir dir");
  });

  it("a missing read rejects (the executor's ENOENT), never falling back to Host disk", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    await expect(run(toolByName(tools, "read"), { path: "nope.txt" })).rejects.toThrow();
    // Only executor calls happened — no host fs access.
    expect(ex.calls.every((c) => /^(read|write|list|exec|access|stat|realpath|mkdir|readdir) /.test(c))).toBe(true);
  });
});
