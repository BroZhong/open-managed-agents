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
    await expect(store.stat("t1", "w1", "missing.txt")).rejects.toMatchObject({ code: "NoSuchBucket" });
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
    const metadata = await store.stat("t1", "w1", "素材/片段 无扩展名");
    expect(metadata).toMatchObject({ size: body.length, contentType: "video/mp4", etag: '"fixture-etag"' });
    const signed = new URL(await store.createSignedReadUrl("t1", "w1", "素材/片段 无扩展名", 300));
    // Preserve the signed resource/query; route transport to a regional OSS fixture.
    const response = await fetch(`${fixture.endpoint}${signed.pathname}${signed.search}`, { headers: { host: signed.host } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    const ranged = await fetch(`${fixture.endpoint}${signed.pathname}${signed.search}`, {
      headers: { host: signed.host, range: "bytes=1-2" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 1-2/${body.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(body.slice(1, 3));
  } finally {
    await fixture.close();
  }
});


it("uses a bound custom domain to preview generic-MIME objects without rewriting their metadata", async () => {
  const fixture = await createOSSHTTPHarness({ customDomain: true });
  try {
    const store = new OSSArtifactStore({ ...ossTestOptions, endpoint: fixture.endpoint, publicEndpoint: "https://files.example.com" });
    const body = Uint8Array.from([0, 255, 13, 128]);
    // Simulate an existing ossfs object with generic metadata via the SDK fixture.
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "clip", body });
    const url = new URL(await store.createSignedReadUrl("t1", "w1", "clip", 300, { contentType: "video/mp4" }));
    const response = await fetch(`${fixture.endpoint}${url.pathname}${url.search}`, { headers: { host: url.host } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect((await store.stat("t1", "w1", "clip"))?.contentType).toBe("application/octet-stream");
    expect(fixture.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
