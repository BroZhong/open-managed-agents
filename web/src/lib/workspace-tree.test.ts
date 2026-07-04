import { describe, it, expect } from "vitest";
import { buildTree, formatSize, encodePath } from "./workspace-tree";
import type { WorkspaceFile } from "./types";

function f(path: string, size = 0): WorkspaceFile {
  return { path, size, updated_at: null };
}

describe("buildTree", () => {
  it("nests files under their directory segments", () => {
    const tree = buildTree([f("src/index.ts", 10), f("src/lib/util.ts", 20), f("readme.md", 5)]);
    const names = tree.children.map((c) => c.name);
    // Directories first, then files, each alphabetical.
    expect(names).toEqual(["src", "readme.md"]);

    const src = tree.children.find((c) => c.name === "src")!;
    expect(src.isDir).toBe(true);
    expect(src.children.map((c) => c.name)).toEqual(["lib", "index.ts"]);

    const lib = src.children.find((c) => c.name === "lib")!;
    expect(lib.isDir).toBe(true);
    expect(lib.children[0].name).toBe("util.ts");
    expect(lib.children[0].path).toBe("src/lib/util.ts");
    expect(lib.children[0].size).toBe(20);
  });

  it("captures a shell-created top-level file (flat listing, S3 source of truth)", () => {
    // A file created via bash appears as a plain path in the S3 listing.
    const tree = buildTree([f("output.log", 42)]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].isDir).toBe(false);
    expect(tree.children[0].path).toBe("output.log");
    expect(tree.children[0].size).toBe(42);
  });

  it("keeps distinct paths that share a directory prefix", () => {
    const tree = buildTree([f("a/x.txt"), f("a/y.txt")]);
    const a = tree.children.find((c) => c.name === "a")!;
    expect(a.children.map((c) => c.name).sort()).toEqual(["x.txt", "y.txt"]);
  });

  it("handles an empty listing", () => {
    const tree = buildTree([]);
    expect(tree.children).toEqual([]);
  });
});

describe("formatSize", () => {
  it("formats bytes, KB, and MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("encodePath", () => {
  it("encodes each segment but preserves slashes as separators", () => {
    expect(encodePath("src/a b/c.txt")).toBe("src/a%20b/c.txt");
    expect(encodePath("weird name.txt")).toBe("weird%20name.txt");
  });
});
