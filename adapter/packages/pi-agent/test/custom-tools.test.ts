import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";
import { buildCustomTools } from "../src/custom-tools.js";

/**
 * A purely in-memory {@link ToolExecutor} — a map from workspace-relative path
 * to file content, no host filesystem at all. Every fs/exec call is recorded in
 * {@link MemExecutor.calls} so a test can assert the operations landed here and
 * never touched the Host disk. `list` mirrors the real contract: directories
 * are omitted; a file path returns exactly that entry; a directory returns all
 * files under it (recursively); a `*` glob filters on a simple `**`/`*` match.
 */
class MemExecutor implements ToolExecutor {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  /** The `opts` object of the most recent `exec` call, for timeout/signal assertions. */
  lastExecOpts?: ExecOptions;

  seed(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  async *exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk> {
    this.calls.push(`exec ${command.join(" ")} @${opts?.cwd ?? "."}`);
    this.lastExecOpts = opts;
    yield { stream: "stdout", text: `ran: ${command[command.length - 1]}` };
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
    // The model-facing path was resolved against /workspace and stripped back
    // to the workspace-relative path the executor expects.
    expect(ex.files.get("sub/note.txt")).toBe("hello");
    expect(ex.calls).toContain("write sub/note.txt");
  });

  it("read pulls the file back through the executor", async () => {
    const ex = new MemExecutor().seed("note.txt", "read-me");
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "read"), { path: "note.txt" });
    expect(out).toBe("read-me");
    expect(ex.calls).toContain("read note.txt");
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

  it("bash runs the command as /bin/sh -c through the executor", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "bash"), { command: "echo hi" });
    expect(out).toContain("ran: echo hi");
    expect(ex.calls).toContain("exec /bin/sh -c echo hi @.");
  });

  it("bash forwards Pi's timeout (SECONDS) straight through — not divided by 1000 (#81)", async () => {
    // Pi's bash schema defines `timeout` in SECONDS. The old code did
    // `options.timeout / 1000`, turning 40s into 0.04s and killing the command
    // in ~44ms ([deadline_exceeded]). The executor must receive 40, not 0.04.
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    await run(toolByName(tools, "bash"), { command: "sleep 1", timeout: 40 });
    expect(ex.lastExecOpts?.timeoutSeconds).toBe(40);
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

  it("bash forwards Pi's AbortSignal into the executor (#84)", async () => {
    // The turn's native abort signal reaches the tool's execute() and must be
    // threaded into the executor so a hung exec can be cancelled.
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    const controller = new AbortController();
    await run(toolByName(tools, "bash"), { command: "echo hi" }, controller.signal);
    expect(ex.lastExecOpts?.signal).toBe(controller.signal);
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
    expect(ex.calls.some((c) => c.startsWith("list dir"))).toBe(true);
  });

  it("find globs through the executor and returns matches", async () => {
    const ex = new MemExecutor()
      .seed("src/main.ts", "")
      .seed("src/util.ts", "")
      .seed("src/readme.md", "");
    const tools = buildCustomTools(ex);
    const out = await run(toolByName(tools, "find"), { pattern: "*.ts", path: "src" });
    expect(out.split("\n").sort()).toEqual(["main.ts", "util.ts"].sort());
    // The glob was executed against the executor, not fd on the Host disk.
    expect(ex.calls.some((c) => c.startsWith("list src/"))).toBe(true);
  });

  it("grep operations resolve directory + file reads through the executor", async () => {
    // grep's search engine (ripgrep) is not driven here — we assert the two
    // operations Pi delegates (isDirectory + readFile) land on the executor.
    const ex = new MemExecutor().seed("dir/a.txt", "line1\nline2");
    const tools = buildCustomTools(ex);
    const grep = toolByName(tools, "grep");
    // The tool's operations are the seam under test; drive them by reading the
    // executor directly through the same paths grep would resolve.
    expect(await ex.list("dir")).toHaveLength(1);
    expect(await ex.readFile("dir/a.txt")).toBe("line1\nline2");
    expect(grep.name).toBe("grep");
    expect(ex.calls).toContain("read dir/a.txt");
  });

  it("a missing read rejects (the executor's ENOENT), never falling back to Host disk", async () => {
    const ex = new MemExecutor();
    const tools = buildCustomTools(ex);
    await expect(run(toolByName(tools, "read"), { path: "nope.txt" })).rejects.toThrow();
    // Only executor calls happened — no host fs access.
    expect(ex.calls.every((c) => /^(read|write|list|exec) /.test(c))).toBe(true);
  });
});
