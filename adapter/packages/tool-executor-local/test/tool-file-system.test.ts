import { afterEach, describe, expect, it } from "vitest";
import { constants } from "node:fs";
import { access, realpath, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createLocalToolExecutor } from "../src/local-tool-executor.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((dispose) => dispose())); });
async function fixture() {
  const { executor, dispose } = await createLocalToolExecutor();
  disposers.push(dispose);
  return executor;
}

describe("LocalToolExecutor native filesystem", () => {
  it("preserves arbitrary bytes and views without implicitly creating write parents", async () => {
    const executor = await fixture();
    const fs = executor.fileSystem;
    const bytes = new Uint8Array([99, 0xef, 0xbb, 0xbf, 0, 0xff, 0xc3, 98]).subarray(1, 7);
    await expect(fs.writeFile("missing/file", bytes)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(executor.root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir("nested/deeper");
    await fs.writeFile("nested/deeper/file", bytes);
    await fs.appendFile("nested/deeper/file", new Uint8Array([128, 10]));
    expect(await fs.readFile("nested/deeper/file")).toEqual(Buffer.from([...bytes, 128, 10]));
    await expect(fs.appendFile("missing/file", bytes)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile("nested")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("distinguishes stat/lstat, resolves links, and returns immediate directory names", async () => {
    const executor = await fixture();
    const fs = executor.fileSystem;
    await fs.mkdir("directory/empty");
    await fs.writeFile("directory/with\nnewline", new Uint8Array([1, 2]));
    await fs.writeFile("directory/.hidden", new Uint8Array());
    await symlink("with\nnewline", join(executor.root, "directory/link"));
    await symlink("missing", join(executor.root, "directory/dangling"));
    expect(await fs.stat("directory/link")).toMatchObject({ isFile: true, isSymbolicLink: false, size: 2 });
    expect(await fs.lstat("directory/link")).toMatchObject({ isFile: false, isSymbolicLink: true });
    expect(await fs.lstat("directory/dangling")).toMatchObject({ isSymbolicLink: true });
    await expect(fs.stat("directory/dangling")).rejects.toMatchObject({ code: "ENOENT", syscall: "stat" });
    await expect(fs.access("directory/dangling", constants.F_OK)).rejects.toMatchObject({ code: "ENOENT", syscall: "access" });
    expect(await fs.realpath("directory/link")).toBe(await realpath(join(executor.root, "directory/with\nnewline")));
    expect((await fs.readdir("directory")).sort()).toEqual([".hidden", "dangling", "empty", "link", "with\nnewline"]);
    expect(await fs.stat("directory")).toMatchObject({ isDirectory: true });
    await expect(fs.readdir("directory/.hidden")).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("creates distinct empty temporary files usable by the same stable capability", async () => {
    const executor = await fixture();
    const fs = executor.fileSystem;
    const [a, b] = await Promise.all([fs.createTempFile(), fs.createTempFile()]);
    expect(a).not.toBe(b);
    expect(executor.fileSystem).toBe(fs);
    expect(await fs.readFile(a)).toHaveLength(0);
    expect((await stat(a)).mode & 0o777).toBe(0o600);
    await fs.appendFile(a, new Uint8Array([255, 0]));
    expect(await fs.readFile(a)).toEqual(Buffer.from([255, 0]));
    await expect(fs.readFile("../outside")).rejects.toThrow("escapes executor root");
  });

  it("rejects pre-aborted mutations before creating paths", async () => {
    const executor = await fixture();
    const options = { signal: AbortSignal.abort() };
    await expect(executor.fileSystem.mkdir("cancelled", options)).rejects.toMatchObject({ name: "AbortError" });
    await expect(executor.fileSystem.writeFile("cancelled", new Uint8Array(), options)).rejects.toMatchObject({ name: "AbortError" });
    expect(await executor.fileSystem.readdir(".")).toEqual([]);
  });

  it("streams exact bytes while independently decoding stdout and stderr", async () => {
    const executor = await fixture();
    const expected = Buffer.from([0xef, 0xbb, 0xbf, 0xf0, 0x9f, 0x98, 0x80, 0, 255, 0xe4]);
    const received = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const text = { stdout: "", stderr: "" };
    const script = `const data=Buffer.from(${JSON.stringify([...expected])}); (async()=>{for(const byte of data){process.stdout.write(Buffer.from([byte]));process.stderr.write(Buffer.from([byte]));await new Promise(r=>setTimeout(r,2));}})();`;
    for await (const chunk of executor.exec([process.execPath, "-e", script])) {
      received[chunk.stream].push(chunk.bytes!);
      text[chunk.stream] += chunk.text;
    }
    for (const stream of ["stdout", "stderr"] as const) {
      expect(Buffer.concat(received[stream])).toEqual(expected);
      expect(text[stream]).toBe(expected.toString("utf8"));
    }
  });

  it("does not create a missing process working directory", async () => {
    const executor = await fixture();
    const execute = async () => { for await (const _chunk of executor.exec([process.execPath, "-e", ""], { cwd: "missing" })) { /* drain */ } };
    await expect(execute()).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(executor.root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
