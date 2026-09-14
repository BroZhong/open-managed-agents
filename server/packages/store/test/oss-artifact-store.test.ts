import { describe, expect, it } from "vitest";
import { OSSArtifactStore } from "../src/oss/artifact-store.js";

import { fakeOSS, ossTestOptions as options } from "./oss-harness.js";

describe("OSS Workspace artifact storage", () => {
  it("round-trips binary and empty files under literal Unicode, space, hidden and percent names", async () => {
    const { client } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    const binary = Uint8Array.from([0, 255, 13, 10, 128]);
    for (const path of ["素材/你好 世界.png", ".hidden", "100% ready.bin", "%2e%2e/literal.bin"]) {
      expect(await store.put({ tenantId: "t1", workspaceId: "w1", path, body: binary })).toEqual({ path, size: 5 });
      expect((await store.get("t1", "w1", path))?.body).toEqual(binary);
    }
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "empty.txt", body: "" });
    expect((await store.get("t1", "w1", "empty.txt"))?.body).toEqual(new Uint8Array());
  });

  it("distinguishes an absent artifact from storage permission or service failures", async () => {
    const { client } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    expect(await store.get("t1", "w1", "missing.txt")).toBeNull();
    expect(await store.exists("t1", "w1", "missing.txt")).toBe(false);
    expect(await store.delete("t1", "w1", "missing.txt")).toBe(false);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "first" });
    expect(await store.exists("t1", "w1", "a.txt")).toBe(true);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "overwrite" });
    expect(new TextDecoder().decode((await store.get("t1", "w1", "a.txt"))!.body)).toBe("overwrite");
    expect(await store.delete("t1", "w1", "a.txt")).toBe(true);
    expect(await store.get("t1", "w1", "a.txt")).toBeNull();

    for (const error of [
      Object.assign(new Error("Access denied"), { status: 403, code: "AccessDenied" }),
      Object.assign(new Error("Backend unavailable"), { status: 503, code: "ServiceUnavailable" }),
      Object.assign(new Error("Bucket missing"), { status: 404, code: "NoSuchBucket" }),
      new Error("Connection timed out"),
    ]) {
      client.get = async () => { throw error; };
      client.head = async () => { throw error; };
      await expect(store.get("t1", "w1", "a.txt")).rejects.toBe(error);
      await expect(store.exists("t1", "w1", "a.txt")).rejects.toBe(error);
      await expect(store.delete("t1", "w1", "a.txt")).rejects.toBe(error);
    }
  });

  it("lists every page and directory subtree without leaking adjacent Tenant or Workspace prefixes", async () => {
    const { client, objects } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    for (const path of [".hidden", "a.txt", "docs/你好 世界.txt", "docs/deep/b.bin", "docs-other/secret.txt"]) {
      await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "data" });
    }
    await store.put({ tenantId: "t1", workspaceId: "w10", path: "neighbor.txt", body: "secret" });
    await store.put({ tenantId: "t10", workspaceId: "w1", path: "neighbor.txt", body: "secret" });
    objects.set("t1/w1/docs/", { body: Buffer.alloc(0) }); // ossfs directory marker
    objects.set("t1/w1/.oma-workspace-checks/probe", { body: Buffer.from("health") });
    expect((await store.list("t1", "w1")).map((file) => file.path).sort()).toEqual([
      ".hidden", "a.txt", "docs-other/secret.txt", "docs/deep/b.bin", "docs/你好 世界.txt",
    ]);
    for (const prefix of ["docs", "docs/"]) {
      const files = await store.list("t1", "w1", prefix);
      expect(files.map((file) => file.path).sort()).toEqual(["docs/deep/b.bin", "docs/你好 世界.txt"]);
      expect(files.every((file) => file.size === 4 && file.updatedAt?.toISOString() === "2026-09-14T00:00:00.000Z")).toBe(true);
    }
    expect(await store.get("t1", "w1", "neighbor.txt")).toBeNull();
    expect(await store.delete("t1", "w1", "neighbor.txt")).toBe(false);
    expect(await store.exists("t1", "w10", "neighbor.txt")).toBe(true);
    expect(await store.exists("t10", "w1", "neighbor.txt")).toBe(true);
    const failure = new Error("Listing unavailable");
    client.listV2 = async () => { throw failure; };
    await expect(store.list("t1", "w1")).rejects.toBe(failure);
  });

  it("rejects traversal, malformed identities and the reserved mount-check subtree at every file boundary", async () => {
    const { client } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    for (const path of [".oma-workspace-checks/probe", ".oma-workspace-checks", "../w2/secret", "a/../../secret", "/secret", "a//b", "a/./b", "a\\..\\secret", "a\u0000b", "a\nb", "\ud800"]) {
      await expect(store.get("t1", "w1", path)).rejects.toThrow(/Invalid artifact path/);
      await expect(store.exists("t1", "w1", path)).rejects.toThrow(/Invalid artifact path/);
      await expect(store.put({ tenantId: "t1", workspaceId: "w1", path, body: "attack" })).rejects.toThrow(/Invalid artifact path/);
      await expect(store.delete("t1", "w1", path)).rejects.toThrow(/Invalid artifact path/);
      await expect(store.list("t1", "w1", path)).rejects.toThrow(/Invalid artifact path/);
    }
    for (const id of ["", "..", "tenant/other", "tenant%2fother", "tenant\\other", "a".repeat(129)]) {
      await expect(store.list(id, "w1")).rejects.toThrow(/Invalid Workspace storage identity/);
      await expect(store.put({ tenantId: "t1", workspaceId: id, path: "a.txt", body: "attack" })).rejects.toThrow(/Invalid Workspace storage identity/);
    }
    await expect(store.put({ tenantId: "t1", workspaceId: "w1", path: "长".repeat(400), body: "attack" })).rejects.toThrow(/Invalid artifact path/);
  });

  it("previews ossfs-created files using their extension when MIME is absent or generic", async () => {
    const { client, objects } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    for (const contentType of [undefined, "application/octet-stream", "binary/octet-stream", "text/plain; charset=utf-8"]) {
      objects.set("t1/w1/素材/片 段.MP4", { body: Buffer.from("media"), contentType });
      expect((await store.get("t1", "w1", "素材/片 段.MP4"))?.contentType).toBe("video/mp4");
    }
    objects.set("t1/w1/image.png", { body: Buffer.from("image"), contentType: "image/custom" });
    expect((await store.get("t1", "w1", "image.png"))?.contentType).toBe("image/custom");
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "unknown", body: "bytes" });
    expect((await store.get("t1", "w1", "unknown"))?.contentType).toBe("application/octet-stream");
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "图.png", body: "bytes" });
    expect((await store.get("t1", "w1", "图.png"))?.contentType).toBe("image/png");
  });

  it("signs only short-lived public HTTPS GET URLs with encoded names and preview MIME", async () => {
    const { client } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, endpoint: "https://oss-cn-shanghai-internal.aliyuncs.com", client });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "素材/片 段%2f.mp4", body: "media" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.png", body: "media" });
    const signed = await store.createSignedReadUrl("t1", "w1", "素材/片 段%2f.mp4", 300);
    const url = new URL(signed);
    expect(url.origin).toBe("https://agentry.oss-cn-shanghai.aliyuncs.com");
    expect(decodeURIComponent(url.pathname)).toBe("/t1/w1/素材/片 段%2f.mp4");
    expect(url.searchParams.get("x-oss-expires")).toBe("300");
    expect(url.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256");
    expect(url.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(url.searchParams.get("x-oss-signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(signed).not.toContain(options.accessKeySecret);
    expect(new URL(await store.createSignedReadUrl("t1", "w1", "a.png", 900)).searchParams.get("x-oss-expires")).toBe("900");
    for (const ttl of [0, -1, 901, Infinity, NaN, 1.5]) {
      await expect(store.createSignedReadUrl("t1", "w1", "a.png", ttl)).rejects.toThrow(/between 1 and 900/);
    }
    for (const path of ["../w2/secret.mp4", ".oma-workspace-checks/probe"]) {
      await expect(store.createSignedReadUrl("t1", "w1", path, 300)).rejects.toThrow(/Invalid artifact path/);
    }
    for (const publicEndpoint of ["http://oss-cn-shanghai.aliyuncs.com", "https://oss-cn-shanghai-internal.aliyuncs.com", "https://localhost", "https://oss-cn-beijing.aliyuncs.com"]) {
      expect(() => new OSSArtifactStore({ ...options, publicEndpoint, client })).toThrow(/public OSS endpoint/);
    }
  });

  it("retains uploaded MIME in signed previews even when the name has no extension", async () => {
    const { client } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "upload", body: "media", contentType: "video/mp4" });
    const url = new URL(await store.createSignedReadUrl("t1", "w1", "upload", 60));
    expect(url.searchParams.get("response-content-type")).toBe("video/mp4");
  });

  it("verifies a closed Sandbox probe only in the exact trusted prefix without exposing storage errors", async () => {
    const { client, objects } = fakeOSS();
    const store = new OSSArtifactStore({ ...options, client });
    const name = "12345678-1234-1234-1234-123456789abc";
    objects.set(`t1/w1/.oma-workspace-checks/${name}`, { body: Buffer.from("fresh nonce") });
    await expect(store.verifyWorkspaceProbe("t1/w1/", name, "fresh nonce")).resolves.toBeUndefined();
    await expect(store.verifyWorkspaceProbe("t1/w2/", name, "fresh nonce")).rejects.toThrow("Workspace mount verification failed");
    await expect(store.verifyWorkspaceProbe("t1/w1/", name, "wrong nonce")).rejects.toThrow("Workspace mount verification failed");
    for (const prefix of ["t1/w1", "t1/w1/../w2/", "t1/w1/extra/", "t1%2fw2/w1/"]) {
      await expect(store.verifyWorkspaceProbe(prefix, name, "fresh nonce")).rejects.toThrow(/Invalid Workspace probe/);
    }
    await expect(store.verifyWorkspaceProbe("t1/w1/", "../../secret.txt", "fresh nonce")).rejects.toThrow(/Invalid Workspace probe/);
    client.get = async () => { throw new Error("backend failure with secret credential"); };
    await expect(store.verifyWorkspaceProbe("t1/w1/", name, "fresh nonce")).rejects.toThrow(/^Workspace mount verification failed$/);
  });
});
