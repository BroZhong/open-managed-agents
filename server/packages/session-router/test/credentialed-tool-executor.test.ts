import { describe, expect, it } from "vitest";
import type {
  ExecOptions,
  ExecOutputChunk,
  FileListEntry,
  ToolExecutor,
} from "@open-managed-agents/adapter-core";
import { withVfsCredential } from "../src/credentialed-tool-executor.js";

class RecordingExecutor implements ToolExecutor {
  calls: Array<{ command: string[]; opts?: ExecOptions }> = [];

  async *exec(command: string[], opts?: ExecOptions): AsyncIterable<ExecOutputChunk> {
    this.calls.push({ command, opts });
  }

  async readFile(): Promise<string> {
    return "";
  }

  async writeFile(): Promise<void> {}

  async list(): Promise<FileListEntry[]> {
    return [];
  }
}

async function drain(iterable: AsyncIterable<ExecOutputChunk>): Promise<void> {
  for await (const _ of iterable) {
    // consume
  }
}

describe("withVfsCredential", () => {
  it("does not expose VFS_TOKEN to arbitrary shell commands", async () => {
    const inner = new RecordingExecutor();
    const executor = withVfsCredential(inner, "secret-token");

    await drain(executor.exec(["/bin/sh", "-c", "env"]));

    expect(inner.calls[0]?.opts?.env).toBeUndefined();
  });

  it("injects the current turn token only into a direct vfs-cli process", async () => {
    const inner = new RecordingExecutor();
    const firstTurn = withVfsCredential(inner, "token-1");
    const secondTurn = withVfsCredential(inner, "token-2");

    await drain(firstTurn.exec(["/bin/sh", "-c", "vfs-cli doctor --json"]));
    await drain(secondTurn.exec(["/usr/local/bin/vfs-cli", "doctor", "--json"]));

    expect(inner.calls.map((call) => call.opts?.env?.VFS_TOKEN)).toEqual([
      "token-1",
      "token-2",
    ]);
  });

  it("allows shell punctuation when it is a literal single-quoted argument", async () => {
    const inner = new RecordingExecutor();
    const executor = withVfsCredential(inner, "secret-token");

    await drain(
      executor.exec([
        "/bin/sh",
        "-c",
        "vfs-cli asset create --name 'clock; $5 > old price'",
      ]),
    );

    expect(inner.calls[0]?.opts?.env?.VFS_TOKEN).toBe("secret-token");
  });

  it("rejects compound shell commands before exposing the token", async () => {
    const inner = new RecordingExecutor();
    const executor = withVfsCredential(inner, "secret-token");

    await expect(async () => {
      await drain(executor.exec(["/bin/sh", "-c", "vfs-cli doctor; env"]));
    }).rejects.toThrow(/single direct command/);
    expect(inner.calls).toHaveLength(0);
  });
});
