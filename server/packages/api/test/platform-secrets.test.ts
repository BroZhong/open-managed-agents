import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformSecrets } from "../src/lib/platform-secrets.js";

afterEach(() => { vi.useRealTimers(); });

describe("PlatformSecrets: the base Secret, refreshed so a rotation applies without a restart (ADR-0024)", () => {
  it("serves the first read, picks up a rotation on the next refresh, and keeps the last good values when a read fails", async () => {
    const warn = vi.fn();
    const reads = [{ VFS_TOKEN: "first" }, { VFS_TOKEN: "rotated", GOOGLE_API_KEY: "g" }];
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error("Sandbox base Secret request failed with HTTP 503");
      return reads.shift() ?? { VFS_TOKEN: "rotated" };
    });
    const secrets = await PlatformSecrets.load(read, { warn });
    expect(secrets.values()).toEqual({ VFS_TOKEN: "first" });
    const first = secrets.generation();
    await secrets.refresh();
    expect(secrets.values()).toEqual({ VFS_TOKEN: "rotated", GOOGLE_API_KEY: "g" });
    expect(secrets.generation()).toBe(first + 1);
    fail = true;
    await secrets.refresh();
    expect(secrets.values()).toEqual({ VFS_TOKEN: "rotated", GOOGLE_API_KEY: "g" });
    expect(secrets.generation()).toBe(first + 1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("HTTP 503");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/rotated|first/);
  });

  it("fails startup when the first read fails, as the Runner did before", async () => {
    await expect(PlatformSecrets.load(async () => { throw new Error("Sandbox base Secret request failed with HTTP 403"); })).rejects.toThrow("HTTP 403");
  });

  it("refreshes every interval until stopped", async () => {
    vi.useFakeTimers();
    let n = 0;
    const secrets = await PlatformSecrets.load(async () => ({ N: String(++n) }));
    secrets.start(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(secrets.values()).toEqual({ N: "2" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(secrets.values()).toEqual({ N: "3" });
    secrets.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(secrets.values()).toEqual({ N: "3" });
  });
});
