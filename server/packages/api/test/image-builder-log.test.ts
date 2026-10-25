import { describe, expect, it } from "vitest";
import { InMemoryEnvironmentBuildLogStore } from "@oma-server/store-memory";
import type { EnvironmentBuildLog, EnvironmentBuildLogStore } from "@oma-server/store";
import { BuildLog } from "../src/image-builder/build-log.js";

const KEY = "__oma/environment-builds/t1/envb_1.log";
const NOW = () => Date.parse("2026-10-26T01:02:03Z");

describe("BuildLog: the kept tail of a build's log", () => {
  it("keeps whole lines only, in any chunking, and writes only when it changed", async () => {
    const store = new InMemoryEnvironmentBuildLogStore();
    let writes = 0;
    const counting: EnvironmentBuildLogStore = { write: async (key, log) => { writes++; await store.write(key, log); }, read: (key) => store.read(key) };
    const log = new BuildLog(counting, KEY, NOW);
    log.append("==> Pul");
    log.append("ling\nBuil");
    await log.flush();
    expect(await store.read(KEY)).toEqual({ text: "==> Pulling\n", start: 0 });
    await log.flush();
    expect(writes).toBe(1);
    log.note("Attempt 1");
    await log.flush();
    expect((await store.read(KEY))!.text).toBe("==> Pulling\nBuil\n[oma-builder 2026-10-26T01:02:03.000Z] Attempt 1\n");
    log.append("tail without newline");
    await log.flush(true);
    expect((await store.read(KEY))!.text.endsWith("tail without newline\n")).toBe(true);
  });

  it("drops the head at a line boundary past the limit and counts the dropped bytes", async () => {
    const store = new InMemoryEnvironmentBuildLogStore();
    const log = new BuildLog(store, KEY, NOW, 64);
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i} ${"界".repeat(3)}\n`);
    for (const line of lines) log.append(line);
    await log.flush();
    const kept = (await store.read(KEY))!;
    const whole = lines.join("");
    expect(Buffer.byteLength(kept.text)).toBeLessThanOrEqual(64);
    expect(kept.text.startsWith("line ")).toBe(true);
    expect(Buffer.from(whole).subarray(kept.start).toString()).toBe(kept.text);
    expect(kept.start).toBe(Buffer.byteLength(whole) - Buffer.byteLength(kept.text));
  });

  it("cuts a single overlong line on a character boundary", () => {
    const log = new BuildLog(new InMemoryEnvironmentBuildLogStore(), KEY, NOW, 10);
    log.append(`${"界".repeat(20)}\n`);
    const { text, start } = log.snapshot();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(10);
    expect(text).toMatch(/^界+\n$/);
    expect(start + Buffer.byteLength(text)).toBe(61);
  });

  it("continues the log an earlier attempt kept", async () => {
    const store = new InMemoryEnvironmentBuildLogStore();
    await store.write(KEY, { text: "attempt 1\n", start: 500 });
    const log = await BuildLog.open(store, KEY, NOW);
    log.append("attempt 2\n");
    await log.flush();
    expect(await store.read(KEY)).toEqual({ text: "attempt 1\nattempt 2\n", start: 500 });
  });

  it("serializes writes, and retries a failed one on the next flush", async () => {
    const written: EnvironmentBuildLog[] = [];
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store: EnvironmentBuildLogStore = {
      write: async (_key, log) => {
        await gate;
        if (fail) { fail = false; throw new Error("OSS unavailable"); }
        written.push({ ...log });
      },
      read: async () => null,
    };
    const log = new BuildLog(store, KEY, NOW);
    log.append("one\n");
    const first = log.flush();
    log.append("two\n");
    const second = log.flush();
    release();
    await expect(first).rejects.toThrow("OSS unavailable");
    await second;
    expect(written).toEqual([{ text: "one\ntwo\n", start: 0 }]);
  });
});
