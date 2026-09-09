import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ExecAbortedBeforeStartError, type ExecOptions, type ExecOutputChunk, type FileListEntry } from "@open-managed-agents/adapter-core";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildCustomTools } from "../src/custom-tools.js";

const execFileAsync = promisify(execFile);
type SearchTool = "grep" | "find";
type SearchResult = Awaited<ReturnType<ToolDefinition["execute"]>>;

// Use Pi's installed binaries for both sides. In particular, a system rg and
// Pi's cached rg can have different versions. Provision a missing binary using
// Pi's own bootstrap (also used by the native reference), never skip parity.
let binaries: Record<"rg" | "fd", string>;

beforeAll(async () => {
  const toolManagerUrl = new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js",
    import.meta.url,
  );
  const { ensureTool } = await import(toolManagerUrl.href) as {
    ensureTool(name: "rg" | "fd", silent: boolean): Promise<string | null>;
  };
  const [rg, fd] = await Promise.all([ensureTool("rg", true), ensureTool("fd", true)]);
  if (!rg || !fd) {
    throw new Error("Native search parity tests require ripgrep and fd (or fdfind) installed in PATH or Pi's bin directory");
  }
  binaries = { rg, fd };
}, 120_000);

class SearchExecutor extends LocalToolExecutor {
  readonly commands: string[][] = [];

  override async *exec(command: string[], options?: ExecOptions): AsyncIterable<ExecOutputChunk> {
    this.commands.push(command);
    const executable = basename(command[0]);
    // The sandbox chooses its own executable path. Only the test backend maps
    // it to the exact binary also used by the unadapted native reference.
    const resolved = executable === "rg" || executable === "fd"
      ? [binaries[executable], ...command.slice(1)]
      : command;
    yield* super.exec(resolved, options);
  }

  override async list(): Promise<FileListEntry[]> {
    throw new Error("Native search must traverse through rg/fd, not ToolExecutor.list");
  }
}

let fixture: string;
let workspace: string;
let projection: string;
let executor: SearchExecutor;

async function seed(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "oma-search-native-parity-"));
  workspace = join(fixture, "workspace");
  projection = join(fixture, "skills", "story");
  await mkdir(workspace);
  await execFileAsync("git", ["init", "--quiet", workspace]);
  await Promise.all([
    seed(join(workspace, ".gitignore"), "ignored/\n"),
    seed(join(workspace, "root.ts"), "const needle = '中文';\n"),
    seed(join(workspace, "src", "child.ts"), "const needle = 'nested';\n"),
    seed(join(workspace, "src", "other.js"), "const needle = 'javascript';\n"),
    seed(join(workspace, "src", "readme.md"), "needle documentation\n"),
    seed(join(workspace, ".hidden", "secret.ts"), "const needle = 'hidden';\n"),
    seed(join(workspace, "ignored", "secret.ts"), "const needle = 'ignored';\n"),
    seed(join(workspace, "unicode.txt"), "中文 😀\nété\n123\n"),
    seed(join(workspace, "context.txt"), "before\r\nNeed.le literal\r\nNeedXle regex-only\r\nafter\r\n"),
    seed(join(workspace, "binary.bin"), Buffer.from("needle before\0needle after\n")),
    seed(join(workspace, "text.pyc"), "needle is plain text despite the extension\n"),
    seed(join(projection, "SKILL.md"), "# Story\nneedle projection\n"),
    seed(join(projection, "scripts", "render.py"), "# needle renderer\n"),
  ]);
  executor = new SearchExecutor({ root: fixture });
});

afterEach(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

function nativeTool(name: SearchTool): ToolDefinition {
  return name === "grep"
    ? defineTool(createGrepToolDefinition(workspace))
    : defineTool(createFindToolDefinition(workspace));
}

function sandboxTool(name: SearchTool): ToolDefinition {
  const tool = buildCustomTools(executor).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

async function execute(tool: ToolDefinition, args: Record<string, unknown>, signal?: AbortSignal): Promise<SearchResult> {
  return tool.execute("native-search-parity", args as never, signal, undefined, {} as never);
}

function text(result: SearchResult): string {
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

function canonical(result: SearchResult, unordered: boolean): SearchResult {
  if (!unordered) return result;
  // rg/fd use parallel directory walkers. Their cross-file order is not a
  // stable contract; retain exact rows and metadata while comparing the set.
  return {
    ...result,
    content: result.content.map((part) => part.type === "text"
      ? { ...part, text: part.text.split("\n").sort().join("\n") }
      : part),
  };
}

async function compare(name: SearchTool, args: Record<string, unknown>, unordered = false): Promise<SearchResult> {
  // An absolute path lets both tools search the exact same bytes while the
  // adapter still performs every operation through its injected executor.
  // The sibling Skill directory also exercises paths outside the Workspace.
  const params = { path: workspace, ...args };
  const expected = await execute(nativeTool(name), params);
  const actual = await execute(sandboxTool(name), params);
  expect(canonical(actual, unordered)).toEqual(canonical(expected, unordered));
  expect(executor.commands.some((command) => basename(command[0]) === (name === "grep" ? "rg" : "fd"))).toBe(true);
  return actual;
}

async function compareError(name: SearchTool, args: Record<string, unknown>): Promise<string> {
  const params = { path: workspace, ...args };
  const failure = async (tool: ToolDefinition) => {
    try {
      await execute(tool, params);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("Expected native search to reject");
  };
  const expected = await failure(nativeTool(name));
  expect(await failure(sandboxTool(name))).toBe(expected);
  return expected;
}

describe("native grep through the sandbox process seam", () => {
  it("preserves ripgrep's Unicode regex syntax", async () => {
    const result = await compare("grep", { pattern: "\\p{L}+", path: join(workspace, "unicode.txt") });
    expect(text(result)).toContain("unicode.txt:1: 中文 😀");
    expect(text(result)).toContain("unicode.txt:2: été");
  });

  it("preserves brace globs, hidden files, and gitignore rules", async () => {
    const result = await compare("grep", { pattern: "needle", glob: "*.{ts,js}" }, true);
    expect(text(result)).toContain("src/child.ts:");
    expect(text(result)).toContain("src/other.js:");
    expect(text(result)).toContain(".hidden/secret.ts:");
    expect(text(result)).not.toContain("ignored/secret.ts");
  });

  it("matches native binary detection, including explicit binary file searches", async () => {
    const source = join(workspace, "types", "audiocontent.py");
    const compiled = join(workspace, "types", "audiocontent.pyc");
    await seed(source, 'AudioContentMimeType = "audio/wav"\nneedle = "needle"\n');
    await execFileAsync("python3", [
      "-I", "-c",
      "import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)",
      source, compiled,
    ]);
    const bytecode = await readFile(compiled);
    expect(bytecode.includes(0)).toBe(true);
    expect(bytecode.includes(Buffer.from("audio/wav"))).toBe(true);
    await seed(join(workspace, "types", "binary.txt"), bytecode);

    await compare("grep", { pattern: "needle" }, true);
    await compare("grep", { pattern: "needle", path: join(workspace, "binary.bin") });
    await compare("grep", { pattern: "AudioContentMimeType|audio/x-wav|audio/wav", path: join(workspace, "types") }, true);
    await compare("grep", { pattern: "audio/wav", path: compiled });
    const plainText = await compare("grep", { pattern: "needle", path: join(workspace, "text.pyc") });
    expect(text(plainText)).toContain("plain text despite the extension");
  });

  it("preserves literal case-insensitive matching and context from sandbox reads", async () => {
    const result = await compare("grep", {
      pattern: "need.le", path: join(workspace, "context.txt"), literal: true, ignoreCase: true, context: 1,
    });
    expect(text(result)).toContain("context.txt-1- before\ncontext.txt:2: Need.le literal\ncontext.txt-3- NeedXle regex-only");
  });

  it("preserves BOM and invalid-UTF8 replacement decoding when reading context", async () => {
    const path = join(workspace, "context-encoding.txt");
    await seed(path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("before\nneedle\nafter "),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]));
    const result = await compare("grep", { pattern: "needle", path, context: 1 });
    expect(text(result)).toContain("context-encoding.txt-1- \uFEFFbefore");
    expect(text(result)).toContain("context-encoding.txt-3- after �");
  });

  it("preserves match-limit text and structured details", async () => {
    const path = join(workspace, "matches.txt");
    await seed(path, "needle one\nneedle two\nneedle three\n");
    const result = await compare("grep", { pattern: "needle", path, limit: 2 });
    expect(result.details).toMatchObject({ matchLimitReached: 2 });
    expect(text(result)).toContain("Use limit=4 for more, or refine pattern");
  });

  it("preserves long-line and byte-truncation metadata", async () => {
    const path = join(workspace, "large.txt");
    await seed(path, Array.from({ length: 200 }, (_, index) => `needle ${index} ${"中".repeat(600)}`).join("\n"));
    const result = await compare("grep", { pattern: "needle", path, limit: 1000 });
    expect(result.details).toMatchObject({ linesTruncated: true, truncation: { truncated: true, truncatedBy: "bytes" } });
    expect(text(result)).toContain("50.0KB limit reached");
  });

  it("preserves no-match output and regex errors", async () => {
    const result = await compare("grep", { pattern: "not-present-anywhere" });
    expect(text(result)).toBe("No matches found");
    expect(await compareError("grep", { pattern: "[" })).toContain("regex parse error");
  });

  it("preserves missing-path errors", async () => {
    expect(await compareError("grep", { pattern: "needle", path: join(workspace, "missing") })).toContain("Path not found:");
  });

  it("searches an absolute Skill projection with native context formatting", async () => {
    const result = await compare("grep", { pattern: "needle", path: projection, context: 1 }, true);
    expect(text(result)).toContain("SKILL.md:2: needle projection");
    expect(text(result)).toContain("scripts/render.py:1: # needle renderer");
  });
});

describe("native find through the sandbox process seam", () => {
  it.each(["*.ts", "**/*.ts", "src/?hild.ts", "*.{ts,js}"])("preserves fd glob semantics for %s", async (pattern) => {
    const result = await compare("find", { pattern }, true);
    expect(text(result)).toContain("src/child.ts");
    expect(text(result)).not.toContain("ignored/secret.ts");
  });

  it("includes hidden files and directory results exactly as native fd does", async () => {
    await mkdir(join(workspace, "empty"));
    const result = await compare("find", { pattern: "*" }, true);
    expect(text(result)).toContain(".hidden/secret.ts");
    expect(text(result)).toContain("empty/");
  });

  it("preserves result-limit instructions and structured details", async () => {
    const result = await compare("find", { pattern: "?hild.ts", limit: 1 });
    expect(result.details).toMatchObject({ resultLimitReached: 1 });
    expect(text(result)).toContain("Use limit=2 for more, or refine pattern");
  });

  it("preserves no-match output and invalid-glob errors", async () => {
    const result = await compare("find", { pattern: "*.not-present-anywhere" });
    expect(text(result)).toBe("No files found matching pattern");
    expect(await compareError("find", { pattern: "[" })).toContain("glob");
  });

  it("preserves fd errors for missing paths", async () => {
    expect(await compareError("find", { pattern: "*", path: join(workspace, "missing") })).toContain("missing");
  });

  it("searches an absolute Skill projection without rewriting its path", async () => {
    const result = await compare("find", { pattern: "*.py", path: projection });
    expect(text(result)).toBe("scripts/render.py");
  });

  it("preserves gitignore behavior outside a Git repository", async () => {
    await seed(join(projection, ".gitignore"), "ignored.py\n");
    await seed(join(projection, "ignored.py"), "ignored\n");
    const result = await compare("find", { pattern: "*.py", path: projection });
    expect(text(result)).toBe("scripts/render.py");
  });

  it("preserves nested Git repository ignore boundaries", async () => {
    await seed(join(workspace, ".gitignore"), "ignored/\nsecret.ts\n");
    const nested = join(workspace, "nested-repo");
    await mkdir(nested);
    await execFileAsync("git", ["init", "--quiet", nested]);
    await seed(join(nested, "secret.ts"), "nested repository\n");
    const result = await compare("find", { pattern: "*.ts", path: nested });
    expect(text(result)).toBe("secret.ts");
  });

  it("supports a symlink search directory", async () => {
    const link = join(fixture, "projected-story");
    await symlink(projection, link);
    const result = await compare("find", { pattern: "*.py", path: link });
    expect(text(result)).toBe("scripts/render.py");
  });
});

describe("native search cancellation", () => {
  it.each<SearchTool>(["grep", "find"])("rejects an already-aborted %s without starting sandbox work", async (name) => {
    const controller = new AbortController();
    controller.abort();
    const args = { pattern: "needle", path: workspace };
    await expect(execute(nativeTool(name), args, controller.signal)).rejects.toThrow("Operation aborted");
    await expect(execute(sandboxTool(name), args, controller.signal)).rejects.toThrow("Operation aborted");
    expect(executor.commands).toEqual([]);
  });

  it.each([
    { name: "a confirmed cancellation before process creation", beforeStart: true, expected: /^Operation aborted$/ },
    { name: "an unconfirmed stream loss during cancellation", beforeStart: false, expected: /^Failed to run ripgrep: RPC disconnected$/ },
  ])("preserves the distinction between cancellation and failure for $name", async ({ beforeStart, expected }) => {
    let started!: () => void;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    const baseExec = executor.exec.bind(executor);
    executor.exec = async function* (command, options) {
      if (command[0] !== "rg") {
        yield* baseExec(command, options);
        return;
      }
      // A pending process allocation and a disconnected running process can
      // both lack an exit result. Only an explicit backend guarantee that no
      // process was created makes this a normal cancellation.
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        started();
      });
      throw beforeStart
        ? new ExecAbortedBeforeStartError()
        : new DOMException("RPC disconnected", "AbortError");
    };
    const controller = new AbortController();
    const result = execute(sandboxTool("grep"), { pattern: "needle", path: workspace }, controller.signal);
    const rejected = expect(result).rejects.toThrow(expected);
    await starting;
    controller.abort();
    await rejected;
  });
});
