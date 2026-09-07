import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { buildCustomTools } from "../src/custom-tools.js";

const execFileAsync = promisify(execFile);
let root: string;
let executor: LocalToolExecutor;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oma-grep-"));
  executor = new LocalToolExecutor({ root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function grepTool(): ToolDefinition {
  const tool = buildCustomTools(executor).find(({ name }) => name === "grep");
  if (!tool) throw new Error("grep tool missing");
  return tool;
}

async function runGrep(args: Record<string, unknown>): Promise<string> {
  const result = await grepTool().execute(
    "grep-call",
    args as never,
    undefined,
    undefined,
    {} as never,
  );
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map(({ text }) => text)
    .join("\n");
}

async function seed(path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

describe("sandbox grep program", () => {
  it("skips NUL-containing binary files, including compiled Python bytecode", async () => {
    const source = 'AudioContentMimeType = "audio/wav"';
    await seed("types/audiocontent.py", source);
    const bytecodePath = join(root, "types/audiocontent.pyc");
    await execFileAsync("python3", [
      "-I", "-c",
      "import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)",
      join(root, "types/audiocontent.py"), bytecodePath,
    ]);
    const bytecode = await readFile(bytecodePath);
    expect(bytecode.includes(0)).toBe(true);
    expect(bytecode.includes(Buffer.from("audio/wav"))).toBe(true);
    // The bytes, not the extension, determine whether a file is binary.
    await writeFile(join(root, "types/binary.txt"), bytecode);

    const output = await runGrep({
      pattern: "AudioContentMimeType|audio/x-wav|audio/wav",
      path: "types",
    });

    expect(output).toBe(`audiocontent.py:1: ${source}`);
    expect(await runGrep({
      pattern: "audio/wav", path: "types/audiocontent.pyc",
    })).toBe("No matches found");
  });

  it("preserves normal UTF-8 text, emoji, and literal Unicode escapes", async () => {
    const source = '音频 😀 audio/wav literal \\u0000';
    await seed("文本.pyc", source);

    expect(await runGrep({ pattern: "音频", path: "." }))
      .toBe(`文本.pyc:1: ${source}`);
  });

  it("searches regex matches and applies recursive globs", async () => {
    await seed("src/a.ts", "first\nconst Needle = 1;\nlast");
    await seed("src/nested/b.ts", "Needless");
    await seed("src/readme.md", "Needle");

    const output = await runGrep({
      pattern: "Need(le|less)",
      path: "src",
      glob: "**/*.ts",
    });

    expect(output).toBe([
      "a.ts:2: const Needle = 1;",
      "nested/b.ts:1: Needless",
    ].join("\n"));
  });

  it("supports literal case-insensitive matching and context", async () => {
    await seed(
      "scene.txt",
      "before\nneed.le is literal\nNeedXle is regex-only\nafter",
    );

    const output = await runGrep({
      pattern: "Need.le",
      path: "scene.txt",
      literal: true,
      ignoreCase: true,
      context: 1,
    });

    expect(output).toBe([
      "scene.txt-1- before",
      "scene.txt:2: need.le is literal",
      "scene.txt-3- NeedXle is regex-only",
    ].join("\n"));
  });

  it("stops at the global match limit", async () => {
    await seed("logs/a.txt", "hit one\nhit two");
    await seed("logs/b.txt", "hit three");

    const output = await runGrep({ pattern: "hit", path: "logs", limit: 2 });

    expect(output).toContain("a.txt:1: hit one");
    expect(output).toContain("a.txt:2: hit two");
    expect(output).not.toContain("hit three");
    expect(output).toContain("2 matches limit reached");
  });

  it("reports missing paths without reading Host files", async () => {
    await expect(
      runGrep({ pattern: "x", path: "missing" }),
    ).rejects.toThrow("Path not found");
  });
});
