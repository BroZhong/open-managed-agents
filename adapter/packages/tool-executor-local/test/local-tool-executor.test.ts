import { describe, it, expect, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecOutputChunk } from "@open-managed-agents/adapter-core";
import { ExecAbortedBeforeStartError } from "@open-managed-agents/adapter-core";
import {
  LocalToolExecutor,
  createLocalToolExecutor,
} from "../src/local-tool-executor.js";

async function collectExec(
  it: AsyncIterable<ExecOutputChunk>,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  for await (const c of it) {
    if (c.stream === "stdout") stdout += c.text;
    else stderr += c.text;
  }
  return { stdout, stderr };
}

describe("LocalToolExecutor", () => {
  it("writes and reads a file", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await executor.writeFile("a/b.txt", "hello");
      expect(await executor.readFile("a/b.txt")).toBe("hello");
    } finally {
      await dispose();
    }
  });

  it("lists files recursively relative to root, POSIX paths", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await executor.writeFile("x.txt", "1");
      await executor.writeFile("dir/y.txt", "22");
      const entries = await executor.list();
      const paths = entries.map((e) => e.path);
      expect(paths).toEqual(["dir/y.txt", "x.txt"]);
      const y = entries.find((e) => e.path === "dir/y.txt")!;
      expect(y.size).toBe(2);
      expect(y.mtimeMs).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("filters list by glob", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await executor.writeFile("a.ts", "1");
      await executor.writeFile("b.js", "1");
      await executor.writeFile("nested/c.ts", "1");
      const ts = await executor.list("**/*.ts");
      expect(ts.map((e) => e.path).sort()).toEqual(["a.ts", "nested/c.ts"]);
    } finally {
      await dispose();
    }
  });

  it("runs a command and streams stdout", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const { stdout } = await collectExec(
        executor.exec(["/bin/sh", "-c", "printf hi"]),
      );
      expect(stdout).toBe("hi");
    } finally {
      await dispose();
    }
  });

  it("exec cwd and writes land in the same root", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await collectExec(executor.exec(["/bin/sh", "-c", "echo made > f.txt"]));
      expect((await executor.readFile("f.txt")).trim()).toBe("made");
    } finally {
      await dispose();
    }
  });

  it("captures stderr distinctly", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const { stdout, stderr } = await collectExec(
        executor.exec(["/bin/sh", "-c", "printf out; printf err 1>&2"]),
      );
      expect(stdout).toBe("out");
      expect(stderr).toBe("err");
    } finally {
      await dispose();
    }
  });

  it("reports a nonzero exit once after streaming output", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const events: unknown[] = [];
      for await (const chunk of executor.exec([process.execPath, "-e", "process.stdout.write('match'); process.exitCode = 2"], {
        onExit: (result) => events.push(result),
      })) events.push(chunk);
      expect(events).toEqual([{ stream: "stdout", text: "match" }, { exitCode: 2 }]);
    } finally {
      await dispose();
    }
  });

  it("preserves Unicode characters split across stdout and stderr writes", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      const result = await collectExec(executor.exec([process.execPath, "-e", `
        const stdout = Buffer.from("中文😀");
        const stderr = Buffer.from("错误🎬");
        process.stdout.write(stdout.subarray(0, 1));
        process.stderr.write(stderr.subarray(0, 2));
        setTimeout(() => {
          process.stdout.write(stdout.subarray(1, 8));
          process.stderr.write(stderr.subarray(2, 9));
          setTimeout(() => {
            process.stdout.write(stdout.subarray(8));
            process.stderr.write(stderr.subarray(9));
          }, 50);
        }, 50);
      `]));
      expect(result).toEqual({ stdout: "中文😀", stderr: "错误🎬" });
    } finally {
      await dispose();
    }
  });

  it("aborting kills the process group before a descendant can write a marker", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    const controller = new AbortController();
    const onExit = vi.fn();
    try {
      const running = (async () => {
        for await (const chunk of executor.exec([
          "/bin/sh", "-c", "(sleep 0.2; printf leaked > marker) & printf started; wait",
        ], { signal: controller.signal, onExit })) {
          if (chunk.text.includes("started")) controller.abort();
        }
      })();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
      expect(onExit).toHaveBeenCalledExactlyOnceWith({ exitCode: null, signal: "SIGKILL" });
      await delay(300);
      await expect(executor.readFile("marker")).rejects.toThrow(/ENOENT/);
    } finally {
      await dispose();
    }
  });

  it("does not launch a command when its signal is already aborted", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await expect(collectExec(executor.exec(["/bin/sh", "-c", "echo leaked > marker"], {
        signal: AbortSignal.abort(),
      }))).rejects.toBeInstanceOf(ExecAbortedBeforeStartError);
      await expect(executor.readFile("marker")).rejects.toThrow(/ENOENT/);
    } finally {
      await dispose();
    }
  });

  it("rejects path traversal on read/write/exec", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    try {
      await expect(executor.readFile("../escape.txt")).rejects.toThrow(
        /escapes executor root/,
      );
      await expect(executor.writeFile("../../x", "y")).rejects.toThrow(
        /escapes executor root/,
      );
      await expect(async () => {
        for await (const _ of executor.exec(["true"], { cwd: "../.." })) {
          // drain
        }
      }).rejects.toThrow(/escapes executor root/);
    } finally {
      await dispose();
    }
  });

  it("gives each createLocalToolExecutor a distinct isolated root", async () => {
    const a = await createLocalToolExecutor();
    const b = await createLocalToolExecutor();
    try {
      expect(a.executor.root).not.toBe(b.executor.root);
      await a.executor.writeFile("only-a.txt", "a");
      expect(await b.executor.list()).toEqual([]);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it("dispose removes the root", async () => {
    const { executor, dispose } = await createLocalToolExecutor();
    await executor.writeFile("f.txt", "x");
    await dispose();
    await expect(executor.readFile("f.txt")).rejects.toThrow();
  });
});
