import { expect, it } from "vitest";
import { OSSEnvironmentBuildLogStore } from "../src/oss/environment-build-log-store.js";
import { environmentBuildLogKey } from "../src/interfaces/environment-build-log-store.js";
import { createOSSHTTPHarness } from "./oss-http-harness.js";
import { ossTestOptions } from "./oss-harness.js";

it("keeps a build log's tail as plain text with the dropped head's length, through the actual OSS SDK", async () => {
  const fixture = await createOSSHTTPHarness();
  try {
    const store = new OSSEnvironmentBuildLogStore({ ...ossTestOptions, endpoint: fixture.endpoint });
    const key = environmentBuildLogKey("tenant_1", "envb_abc-1_x");
    expect(key).toBe("__oma/environment-builds/tenant_1/envb_abc-1_x.log");
    expect(await store.read(key)).toBeNull();
    await store.write(key, { text: "==> pull\n构建 ok\n", start: 0 });
    await store.write(key, { text: "line 2\nline 3\n", start: 4096 });
    expect(await store.read(key)).toEqual({ text: "line 2\nline 3\n", start: 4096 });
    expect(fixture.requests.map((r) => [r.method, r.key])).toEqual([
      ["GET", key], ["PUT", key], ["PUT", key], ["GET", key],
    ]);
    expect(environmentBuildLogKey(null, "envb_1")).toBe("__oma/environment-builds/platform/envb_1.log");
    expect(() => environmentBuildLogKey("../x", "envb_1")).toThrow("identity");
    expect(() => environmentBuildLogKey("platform", "envb_1")).toThrow("identity");
    await expect(store.read("__oma/session-results/v1/x.log")).rejects.toThrow("key");
  } finally { await fixture.close(); }
});
