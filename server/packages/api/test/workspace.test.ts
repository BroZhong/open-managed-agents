import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryArtifactStore, createMemoryStores } from "@oma-server/store-memory";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import type { ArtifactReadUrlOptions, WorkspaceMetadataStore } from "@oma-server/store";

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return { async findByKeyHash(hash) { return entries.get(hash) ?? null; } };
}

function createTestApp(signing = true) {
  process.env.AUTH_DISABLED = "true";
  const { workspaceStore } = createMemoryStores();
  const artifactStore = signing ? new SigningArtifactStore() : new InMemoryArtifactStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    workspaceStore,
    artifactStore,
  });
  return { app, workspaceStore, artifactStore };
}
async function seedWorkspace(
  workspaceStore: WorkspaceMetadataStore,
  tenantId = "dev",
  workspaceId = "ws_1",
) {
  return workspaceStore.create({ tenantId, id: workspaceId });
}

describe("GET /v1/workspaces/:id/files", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("lists the workspace file tree from the artifact store", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "a.txt", body: "hello" });
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/b.js", body: "x=1" });

    const res = await app.request(`/v1/workspaces/${workspace.id}/files`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const paths = body.data.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(["a.txt", "src/b.js"]);
    expect(body.data.find((f: { path: string }) => f.path === "a.txt").size).toBe(5);
  });

  it("scopes the listing directly to the requested Workspace without a Session", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore, "dev", "ws_1");
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "mine.txt", body: "1" });
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_other", path: "theirs.txt", body: "2" });

    const res = await app.request(`/v1/workspaces/${workspace.id}/files`);
    const body = await res.json();
    expect(body.data.map((f: { path: string }) => f.path)).toEqual(["mine.txt"]);
    expect(artifactStore.listCalls[0].workspaceId).toBe("ws_1");
  });

  it("returns 404 for a missing Workspace", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/workspaces/ws_nope/files");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a Workspace belonging to another tenant", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore, "other-tenant");
    const res = await app.request(`/v1/workspaces/${workspace.id}/files`);
    // Auth-disabled tenant is "dev"; Workspace belongs to "other-tenant".
    expect(res.status).toBe(404);
  });

  it("rejects a traversal prefix", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(`/v1/workspaces/${workspace.id}/files?prefix=../etc`);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/workspaces/:id/files/*", () => {
  it("reports signing failures as storage errors without leaking SDK diagnostics", async () => {
    const { app, workspaceStore, artifactStore } = createSigningTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "a.png", body: "x" });
    vi.spyOn(artifactStore, "createSignedReadUrl").mockRejectedValue(new Error("secret in SDK request"));
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/a.png`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "Workspace storage is unavailable. Retry the file operation.", code: "workspace_storage_error",
    });
  });

  it("only signs GET requests", async () => {
    const { app, workspaceStore, artifactStore } = createSigningTestApp();
    await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "a.png", body: "image" });
    const sign = vi.spyOn(artifactStore, "createSignedReadUrl");
    for (const method of ["PUT", "POST"]) {
      const response = await app.request("/v1/workspaces/ws_1/files/a.png", { method });
      expect([404, 405]).toContain(response.status);
    }
    expect(sign).not.toHaveBeenCalled();
  });
  it("decodes Unicode, percent and reserved characters exactly once before signing", async () => {
    const { app, workspaceStore, artifactStore } = createSigningTestApp();
    await seedWorkspace(workspaceStore);
    const path = "素材/%2e%2e/100% #ready?.mp4";
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path, body: "video" });
    const sign = vi.spyOn(artifactStore, "createSignedReadUrl");
    const response = await app.request(`/v1/workspaces/ws_1/files/${path.split("/").map(encodeURIComponent).join("/")}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path, size: 5, contentType: "video/mp4" });
    expect(sign).toHaveBeenCalledExactlyOnceWith("dev", "ws_1", path, 600, { download: false, contentType: "video/mp4" });
    expect(artifactStore.getCalls).toBe(0);
  });

  it("clamps access URL expiry and does not sign absent objects", async () => {
    const { app, workspaceStore, artifactStore } = createSigningTestApp();
    await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "empty", body: "" });
    for (const [query, expiresIn] of [["", 600], ["?expiresIn=9999", 900], ["?expiresIn=-1", 60], ["?expiresIn=abc", 600], ["?expiresIn=61.9", 61]] as const) {
      const response = await app.request(`/v1/workspaces/ws_1/files/empty${query}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ size: 0, expiresIn });
    }
    const sign = vi.spyOn(artifactStore, "createSignedReadUrl");
    expect((await app.request("/v1/workspaces/ws_1/files/missing")).status).toBe(404);
    expect(sign).not.toHaveBeenCalled();
  });

  it("reports unavailable storage without leaking SDK request details", async () => {
    const { app, workspaceStore, artifactStore } = createSigningTestApp();
    await seedWorkspace(workspaceStore);
    vi.spyOn(artifactStore, "stat").mockRejectedValue(new Error("secret in HEAD request"));
    const sign = vi.spyOn(artifactStore, "createSignedReadUrl");
    const response = await app.request("/v1/workspaces/ws_1/files/video.mp4");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Workspace storage is unavailable. Retry the file operation.", code: "workspace_storage_error" });
    expect(sign).not.toHaveBeenCalled();
  });

  it("returns 501 for a backend without signed reads", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp(false);
    await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "a.txt", body: "text" });
    const get = vi.spyOn(artifactStore, "get");
    expect((await app.request("/v1/workspaces/ws_1/files/a.txt")).status).toBe(501);
    expect(get).not.toHaveBeenCalled();
  });

  it("reads nested paths when the Workspace ID itself is files", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    await seedWorkspace(workspaceStore, "dev", "files");
    await artifactStore.put({ tenantId: "dev", workspaceId: "files", path: "files/nested.txt", body: "correct file" });
    const response = await app.request("/v1/workspaces/files/files/files/nested.txt");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ path: "files/nested.txt", size: 12 });
  });

  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("returns metadata and a signed URL without fetching file bytes", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({
      tenantId: "dev",
      workspaceId: "ws_1",
      path: "notes.md",
      body: "# hi",
      contentType: "text/markdown",
    });

    const get = vi.spyOn(artifactStore, "get");
    const stat = vi.spyOn(artifactStore, "stat");
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/notes.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ path: "notes.md", contentType: "text/markdown", size: 4, expiresIn: 600 });
    expect(body.url).toContain("/dev/ws_1/notes.md");
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 599_000);
    expect(stat).toHaveBeenCalledExactlyOnceWith("dev", "ws_1", "notes.md");
    expect(get).not.toHaveBeenCalled();
  });

  it("previews a nested file path", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/deep/x.txt", body: "deep" });

    const res = await app.request(`/v1/workspaces/${workspace.id}/files/src/deep/x.txt`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: "src/deep/x.txt", size: 4 });
  });

  it("requests an attachment URL when download=1", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/report.csv", body: "a,b" });

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/src/report.csv?download=1`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("download=1");
  });

  it("returns 404 for a missing file", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/ghost.txt`);
    expect(res.status).toBe(404);
  });

  it("downloads a Chinese filename and infers the MIME of an ossfs binary", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const path = "中文 图片.png";
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path, body: bytes, contentType: "application/octet-stream" });
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/${encodeURIComponent(path)}?download=1`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path, contentType: "image/png", size: bytes.length });
  });

  it("returns 400 for malformed URL encoding", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/bad%zz`);
    expect(res.status).toBe(400);
  });

  it("does not leak files outside the workspace via a traversal path", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore, "dev", "ws_1");
    // A sibling workspace's file must never be reachable via `..`.
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_2", path: "secret.txt", body: "nope" });
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/../ws_2/secret.txt`,
    );
    // Either the router normalizes the `..` away (no match / 404) or the
    // handler's isSafePath guard rejects it (400) — never a 200 with the file.
    expect(res.status).not.toBe(200);
    expect([400, 404]).toContain(res.status);
  });

  it("returns 404 for a file in another tenant's Workspace", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore, "other-tenant");
    await artifactStore.put({ tenantId: "other-tenant", workspaceId: "ws_1", path: "a.txt", body: "x" });
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/a.txt`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/workspaces/:id/files/content", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("writes a file that then shows up in list and get", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);

    const put = await app.request(
      `/v1/workspaces/${workspace.id}/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.md", content: "# hi" }),
      },
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ path: "notes.md" });

    const list = await app.request(`/v1/workspaces/${workspace.id}/files`);
    const listBody = await list.json();
    expect(listBody.data.map((f: { path: string }) => f.path)).toContain("notes.md");

    const get = await app.request(`/v1/workspaces/${workspace.id}/files/notes.md`);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ path: "notes.md", size: 4 });
  });

  it("rejects a traversal path with 400", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../escape.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it.each(["/absolute.txt", "a\\b.txt", "a//b.txt", "a/./b.txt", "a\u0000.txt"])(
    "rejects an ambiguous or unsafe write path %j before storage", async (path) => {
      const { app, workspaceStore, artifactStore } = createTestApp();
      const workspace = await seedWorkspace(workspaceStore);
      const res = await app.request(`/v1/workspaces/${workspace.id}/files/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content: "must not be saved" }),
      });
      expect(res.status).toBe(400);
      expect(await artifactStore.list("dev", "ws_1")).toEqual([]);
    },
  );

  it("returns 404 for another tenant's Workspace", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore, "other-tenant");
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "a.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(404);
  });


});

describe("DELETE /v1/workspaces/:id/files/content", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("deletes an existing file", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "gone.txt", body: "x" });

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/content?path=gone.txt`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "workspace_file_deleted", path: "gone.txt" });

    const get = await app.request(`/v1/workspaces/${workspace.id}/files/gone.txt`);
    expect(get.status).toBe(404);
  });

  it("returns 404 when the file does not exist", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/content?path=ghost.txt`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a traversal path with 400", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/content?path=..`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });

});

describe("POST /v1/workspaces/:id/files/rename", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("retains content when renaming a file to itself", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "same.txt", body: "keep" });
    const res = await app.request(`/v1/workspaces/${workspace.id}/files/rename`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "same.txt", to: "same.txt" }),
    });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode((await artifactStore.get("dev", "ws_1", "same.txt"))!.body)).toBe("keep");
  });

  it("moves the file to the new path and preserves contentType", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    await artifactStore.put({
      tenantId: "dev",
      workspaceId: "ws_1",
      path: "old.md",
      body: "# doc",
      contentType: "text/markdown",
    });

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "old.md", to: "new.md" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "workspace_file_renamed",
      from: "old.md",
      to: "new.md",
    });

    const oldGet = await app.request(`/v1/workspaces/${workspace.id}/files/old.md`);
    expect(oldGet.status).toBe(404);

    const newGet = await app.request(`/v1/workspaces/${workspace.id}/files/new.md`);
    expect(newGet.status).toBe(200);
    expect(await newGet.json()).toMatchObject({ path: "new.md", contentType: "text/markdown", size: 5 });
    expect(new TextDecoder().decode((await artifactStore.get("dev", "ws_1", "new.md"))!.body)).toBe("# doc");
  });

  it("returns 404 when the source file is missing", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "ghost.md", to: "new.md" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a traversal path with 400", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "ok.md", to: "../escape.md" }),
      },
    );
    expect(res.status).toBe(400);
  });

});

describe("POST /v1/workspaces/:id/files/upload", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("uploads a media file and persists its contentType from the upload MIME", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);

    const form = new FormData();
    const png = new File([new Uint8Array([1, 2, 3, 4])], "pic.png", { type: "image/png" });
    form.set("destDir", "assets");
    form.set("file", png);

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ path: "assets/pic.png" }] });

    const stored = await artifactStore.get("dev", "ws_1", "assets/pic.png");
    expect(stored).not.toBeNull();
    expect(stored!.contentType).toBe("image/png");
    expect(Array.from(stored!.body)).toEqual([1, 2, 3, 4]);
  });

  it("honors an explicit per-file path", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);

    const form = new FormData();
    form.set("path", "docs/readme.txt");
    form.set("file", new File([new Uint8Array([65])], "ignored.txt", { type: "text/plain" }));

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ path: "docs/readme.txt" }] });
    expect(await artifactStore.get("dev", "ws_1", "docs/readme.txt")).not.toBeNull();
  });

  it("uploads a folder beneath the destination without flattening nested names or changing audio", async () => {
    const { app, workspaceStore, artifactStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);
    const fixtures = [
      {
        name: "旁白.mp3",
        relativePath: "故事 素材/章节 一/音频/旁白.mp3",
        storedPath: "assets/imports/故事 素材/章节 一/音频/旁白.mp3",
        contentType: "audio/mpeg",
        bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x81]),
      },
      {
        name: "旁白.mp3",
        relativePath: "故事 素材/章节 二/音频/旁白.mp3",
        storedPath: "assets/imports/故事 素材/章节 二/音频/旁白.mp3",
        contentType: "audio/mpeg",
        bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x80, 0x00, 0xfe, 0x02]),
      },
      {
        name: "说明.txt",
        relativePath: "故事 素材/说明.txt",
        storedPath: "assets/imports/故事 素材/说明.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("来自拖入目录的说明"),
      },
    ];
    const form = new FormData();
    form.set("destDir", "assets/imports");
    for (const fixture of fixtures) {
      form.append(
        "files",
        new File([fixture.bytes], fixture.name, { type: fixture.contentType }),
        fixture.relativePath,
      );
    }

    const upload = await app.request(
      `/v1/workspaces/${workspace.id}/files/upload`,
      { method: "POST", body: form },
    );
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({
      data: fixtures.map((fixture) => ({ path: fixture.storedPath })),
    });

    const listing = await app.request(`/v1/workspaces/${workspace.id}/files`);
    expect(listing.status).toBe(200);
    const listed = (await listing.json()).data as Array<{ path: string; size: number }>;
    expect(listed.map((file) => file.path).sort()).toEqual(
      fixtures.map((fixture) => fixture.storedPath).sort(),
    );
    for (const fixture of fixtures) {
      expect(listed.find((file) => file.path === fixture.storedPath)?.size).toBe(fixture.bytes.length);
      const encodedPath = fixture.storedPath.split("/").map(encodeURIComponent).join("/");
      const read = await app.request(`/v1/workspaces/${workspace.id}/files/${encodedPath}`);
      expect(read.status).toBe(200);
      const descriptor = await read.json();
      expect(descriptor.contentType.split(";")[0]).toBe(fixture.contentType);
      expect(descriptor.size).toBe(fixture.bytes.length);
      expect((await artifactStore.get("dev", "ws_1", fixture.storedPath))!.body).toEqual(fixture.bytes);
    }
  });

  it("rejects a traversal destination with 400", async () => {
    const { app, workspaceStore } = createTestApp();
    const workspace = await seedWorkspace(workspaceStore);

    const form = new FormData();
    form.set("destDir", "..");
    form.set("file", new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }));

    const res = await app.request(
      `/v1/workspaces/${workspace.id}/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(400);
  });

});

// The production in-memory fake (store-memory) intentionally has no signing —
// signed reads need an external storage server. Unit tests use a URL-only fake;
// workspace-oss.test.ts verifies actual bytes using the official OSS SDK fixture.
const PUBLIC_BASE = "https://files.example.com";
class SigningArtifactStore extends InMemoryArtifactStore {
  public getCalls = 0;

  override async get(tenantId: string, workspaceId: string, path: string) {
    this.getCalls += 1;
    return super.get(tenantId, workspaceId, path);
  }

  async createSignedReadUrl(
    tenantId: string,
    workspaceId: string,
    path: string,
    expiresInSec: number,
    options: ArtifactReadUrlOptions = {},
  ): Promise<string> {
    return `${PUBLIC_BASE}/object/sign/workspace/${tenantId}/${workspaceId}/${path.split("/").map(encodeURIComponent).join("/")}?token=fake&exp=${expiresInSec}${options.download ? "&download=1" : ""}`;
  }
}

function createSigningTestApp() {
  process.env.AUTH_DISABLED = "true";
  const { workspaceStore } = createMemoryStores();
  const artifactStore = new SigningArtifactStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    workspaceStore,
    artifactStore,
  });
  return { app, workspaceStore, artifactStore };
}
