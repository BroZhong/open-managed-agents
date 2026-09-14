import { expect, it } from "vitest";
import { OSSArtifactStore } from "../src/oss/artifact-store.js";
import { ossTestOptions } from "./oss-harness.js";
import { createOSSHTTPHarness } from "./oss-http-harness.js";

it("round-trips Workspace files through the official OSS SDK HTTP protocol", async () => {
  const fixture = await createOSSHTTPHarness();
  try {
    const store = new OSSArtifactStore({ ...ossTestOptions, endpoint: fixture.endpoint });
    const files = ["素材/你好 世界.png", "100% ready.bin", "%2f/literal.txt", ".hidden", "empty.txt"];
    for (const path of files) {
      const body = path === "empty.txt" ? new Uint8Array() : Uint8Array.from([0, 255, 13, 128]);
      await store.put({ tenantId: "t1", workspaceId: "w1", path, body });
      expect((await store.get("t1", "w1", path))?.body).toEqual(body);
    }
    await store.put({ tenantId: "t1", workspaceId: "w10", path: "secret.txt", body: "neighbor" });
    expect((await store.list("t1", "w1")).map((file) => file.path).sort()).toEqual([...files].sort());
    expect(await store.get("t1", "w1", "secret.txt")).toBeNull();
    expect(await store.exists("t1", "w1", "100% ready.bin")).toBe(true);
    expect(await store.delete("t1", "w1", "100% ready.bin")).toBe(true);
    expect(await store.delete("t1", "w1", "100% ready.bin")).toBe(false);
    expect(await store.get("t1", "w1", "100% ready.bin")).toBeNull();
    expect((await store.get("t1", "w1", "素材/你好 世界.png"))?.contentType).toBe("image/png");
  } finally {
    await fixture.close();
  }
});
