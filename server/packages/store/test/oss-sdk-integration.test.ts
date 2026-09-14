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
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "100% ready.bin.extra", body: "adjacent key" });
    expect(await store.exists("t1", "w1", "100% ready.bin")).toBe(false);
    expect((await store.get("t1", "w1", "素材/你好 世界.png"))?.contentType).toBe("image/png");
  } finally {
    await fixture.close();
  }
});

it("reports a missing Bucket as a storage failure even when OSS HEAD has no XML error body", async () => {
  const fixture = await createOSSHTTPHarness({ missingBucket: true });
  try {
    const store = new OSSArtifactStore({ ...ossTestOptions, endpoint: fixture.endpoint });
    await expect(store.exists("t1", "w1", "missing.txt")).rejects.toMatchObject({ code: "NoSuchBucket" });
    await expect(store.delete("t1", "w1", "missing.txt")).rejects.toMatchObject({ code: "NoSuchBucket" });
    await expect(store.createSignedReadUrl("t1", "w1", "missing.txt", 300)).rejects.toMatchObject({ code: "NoSuchBucket" });
  } finally {
    await fixture.close();
  }
});

it("serves signed GET bytes with stored MIME through the current OSS response-header rules", async () => {
  const fixture = await createOSSHTTPHarness();
  try {
    const store = new OSSArtifactStore({ ...ossTestOptions, endpoint: fixture.endpoint });
    const body = Uint8Array.from([0, 255, 13, 128]);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "素材/片段 无扩展名", body, contentType: "video/mp4" });
    const signed = new URL(await store.createSignedReadUrl("t1", "w1", "素材/片段 无扩展名", 300));
    // Preserve the signed resource and Host; only route transport to the repeatable fixture.
    const response = await fetch(`${fixture.endpoint}${signed.pathname}${signed.search}`, { headers: { host: signed.host } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  } finally {
    await fixture.close();
  }
});
