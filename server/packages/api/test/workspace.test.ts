import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import { InMemoryArtifactStore } from "@oma-server/store-memory";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
import type { ApiKeyStore, TenantContext } from "../src/types.js";
import type {
  SessionStore,
  Session,
  SessionStoreCreateInput,
  SessionStoreListOpts,
  SessionStatus,
  PaginatedResult,
} from "@oma-server/store";

// Minimal in-memory SessionStore for the workspace proxy tests.
class InMemorySessionStore implements SessionStore {
  private sessions: Session[] = [];
  private nextId = 1;

  async create(input: SessionStoreCreateInput): Promise<Session> {
    const session: Session = {
      id: `sess_${this.nextId++}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      status: "idle",
      agent: structuredClone(input.agent),
      workspaceId: input.workspaceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.push(session);
    return session;
  }
  async getById(id: string): Promise<Session | null> {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
  async list(
    tenantId: string,
    _opts?: SessionStoreListOpts,
  ): Promise<PaginatedResult<Session>> {
    return { data: this.sessions.filter((s) => s.tenantId === tenantId), hasMore: false };
  }
  async updateStatus(id: string, status: SessionStatus): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.status = status;
    return s;
  }
  async setTitle(id: string, title: string): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.title = title;
    return s;
  }
  async terminate(id: string): Promise<Session | null> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    s.status = "terminated";
    return s;
  }
}

function makeApiKeyStore(entries: Map<string, TenantContext>): ApiKeyStore {
  return { async findByKeyHash(hash) { return entries.get(hash) ?? null; } };
}

function createTestApp() {
  process.env.AUTH_DISABLED = "true";
  const sessionStore = new InMemorySessionStore();
  const artifactStore = new InMemoryArtifactStore();
  const turnStreamStore = new InMemoryTurnStreamStore();
  const app = createApp({
    apiKeyStore: makeApiKeyStore(new Map()),
    sessionStore,
    artifactStore,
    turnStreamStore,
  });
  return { app, sessionStore, artifactStore, turnStreamStore };
}

const dummyAgent = {
  id: "agent_1",
  tenantId: "dev",
  name: "A",
  model: "m",
  system: "s",
  runtime: "pi-agent" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function seedSession(
  sessionStore: InMemorySessionStore,
  tenantId = "dev",
  workspaceId = "ws_1",
) {
  return sessionStore.create({
    tenantId,
    agentId: dummyAgent.id,
    agent: dummyAgent,
    workspaceId,
  });
}

describe("GET /v1/sessions/:id/workspace/files", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("lists the workspace file tree from the artifact store", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "a.txt", body: "hello" });
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/b.js", body: "x=1" });

    const res = await app.request(`/v1/sessions/${session.id}/workspace/files`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const paths = body.data.map((f: { path: string }) => f.path).sort();
    expect(paths).toEqual(["a.txt", "src/b.js"]);
    expect(body.data.find((f: { path: string }) => f.path === "a.txt").size).toBe(5);
  });

  it("scopes the listing to the session's bound workspace", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore, "dev", "ws_1");
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "mine.txt", body: "1" });
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_other", path: "theirs.txt", body: "2" });

    const res = await app.request(`/v1/sessions/${session.id}/workspace/files`);
    const body = await res.json();
    expect(body.data.map((f: { path: string }) => f.path)).toEqual(["mine.txt"]);
    expect(artifactStore.listCalls[0].workspaceId).toBe("ws_1");
  });

  it("returns 404 for a missing session", async () => {
    const { app } = createTestApp();
    const res = await app.request("/v1/sessions/sess_nope/workspace/files");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a session belonging to another tenant", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore, "other-tenant");
    const res = await app.request(`/v1/sessions/${session.id}/workspace/files`);
    // Auth-disabled tenant is "dev"; session belongs to "other-tenant".
    expect(res.status).toBe(404);
  });

  it("rejects a traversal prefix", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(`/v1/sessions/${session.id}/workspace/files?prefix=../etc`);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/sessions/:id/workspace/files/*", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("previews a file's content through the Host proxy", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({
      tenantId: "dev",
      workspaceId: "ws_1",
      path: "notes.md",
      body: "# hi",
      contentType: "text/markdown",
    });

    const res = await app.request(`/v1/sessions/${session.id}/workspace/files/notes.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(await res.text()).toBe("# hi");
  });

  it("previews a nested file path", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/deep/x.txt", body: "deep" });

    const res = await app.request(`/v1/sessions/${session.id}/workspace/files/src/deep/x.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("deep");
  });

  it("sets Content-Disposition attachment when download=1", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "src/report.csv", body: "a,b" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/src/report.csv?download=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="report.csv"');
    expect(await res.text()).toBe("a,b");
  });

  it("returns 404 for a missing file", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(`/v1/sessions/${session.id}/workspace/files/ghost.txt`);
    expect(res.status).toBe(404);
  });

  it("does not leak files outside the workspace via a traversal path", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore, "dev", "ws_1");
    // A sibling workspace's file must never be reachable via `..`.
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_2", path: "secret.txt", body: "nope" });
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/../ws_2/secret.txt`,
    );
    // Either the router normalizes the `..` away (no match / 404) or the
    // handler's isSafePath guard rejects it (400) — never a 200 with the file.
    expect(res.status).not.toBe(200);
    expect([400, 404]).toContain(res.status);
  });

  it("returns 404 for a file in another tenant's session", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore, "other-tenant");
    await artifactStore.put({ tenantId: "other-tenant", workspaceId: "ws_1", path: "a.txt", body: "x" });
    const res = await app.request(`/v1/sessions/${session.id}/workspace/files/a.txt`);
    expect(res.status).toBe(404);
  });
});

describe("PUT /v1/sessions/:id/workspace/files/content", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("writes a file that then shows up in list and get", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);

    const put = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "notes.md", content: "# hi" }),
      },
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ path: "notes.md" });

    const list = await app.request(`/v1/sessions/${session.id}/workspace/files`);
    const listBody = await list.json();
    expect(listBody.data.map((f: { path: string }) => f.path)).toContain("notes.md");

    const get = await app.request(`/v1/sessions/${session.id}/workspace/files/notes.md`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("# hi");
  });

  it("rejects a traversal path with 400", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../escape.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for another tenant's session", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore, "other-tenant");
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "a.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("is rejected with 423 while the active turn is running", async () => {
    const { app, sessionStore, turnStreamStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await turnStreamStore.setActiveTurn(session.id, { turnId: "t1", status: "running" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "a.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("workspace_locked");
  });

  it("is allowed when the active turn is idle", async () => {
    const { app, sessionStore, turnStreamStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await turnStreamStore.setActiveTurn(session.id, { turnId: "t1", status: "idle" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "a.txt", content: "x" }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("DELETE /v1/sessions/:id/workspace/files/content", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("deletes an existing file", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "gone.txt", body: "x" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content?path=gone.txt`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "workspace_file_deleted", path: "gone.txt" });

    const get = await app.request(`/v1/sessions/${session.id}/workspace/files/gone.txt`);
    expect(get.status).toBe(404);
  });

  it("returns 404 when the file does not exist", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content?path=ghost.txt`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a traversal path with 400", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content?path=..`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });

  it("is rejected with 423 while the active turn is running", async () => {
    const { app, sessionStore, artifactStore, turnStreamStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "gone.txt", body: "x" });
    await turnStreamStore.setActiveTurn(session.id, { turnId: "t1", status: "running" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/content?path=gone.txt`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("workspace_locked");
  });
});

describe("POST /v1/sessions/:id/workspace/files/rename", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("moves the file to the new path and preserves contentType", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({
      tenantId: "dev",
      workspaceId: "ws_1",
      path: "old.md",
      body: "# doc",
      contentType: "text/markdown",
    });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/rename`,
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

    const oldGet = await app.request(`/v1/sessions/${session.id}/workspace/files/old.md`);
    expect(oldGet.status).toBe(404);

    const newGet = await app.request(`/v1/sessions/${session.id}/workspace/files/new.md`);
    expect(newGet.status).toBe(200);
    expect(newGet.headers.get("content-type")).toBe("text/markdown");
    expect(await newGet.text()).toBe("# doc");
  });

  it("returns 404 when the source file is missing", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "ghost.md", to: "new.md" }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a traversal path with 400", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);
    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "ok.md", to: "../escape.md" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("is rejected with 423 while the active turn is running", async () => {
    const { app, sessionStore, artifactStore, turnStreamStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await artifactStore.put({ tenantId: "dev", workspaceId: "ws_1", path: "old.md", body: "x" });
    await turnStreamStore.setActiveTurn(session.id, { turnId: "t1", status: "running" });

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "old.md", to: "new.md" }),
      },
    );
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("workspace_locked");
  });
});

describe("POST /v1/sessions/:id/workspace/files/upload", () => {
  beforeEach(() => {
    process.env.AUTH_DISABLED = "true";
  });

  it("uploads a media file and persists its contentType from the upload MIME", async () => {
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);

    const form = new FormData();
    const png = new File([new Uint8Array([1, 2, 3, 4])], "pic.png", { type: "image/png" });
    form.set("destDir", "assets");
    form.set("file", png);

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/upload`,
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
    const { app, sessionStore, artifactStore } = createTestApp();
    const session = await seedSession(sessionStore);

    const form = new FormData();
    form.set("path", "docs/readme.txt");
    form.set("file", new File([new Uint8Array([65])], "ignored.txt", { type: "text/plain" }));

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ path: "docs/readme.txt" }] });
    expect(await artifactStore.get("dev", "ws_1", "docs/readme.txt")).not.toBeNull();
  });

  it("rejects a traversal destination with 400", async () => {
    const { app, sessionStore } = createTestApp();
    const session = await seedSession(sessionStore);

    const form = new FormData();
    form.set("destDir", "..");
    form.set("file", new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }));

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(400);
  });

  it("is rejected with 423 while the active turn is running", async () => {
    const { app, sessionStore, turnStreamStore } = createTestApp();
    const session = await seedSession(sessionStore);
    await turnStreamStore.setActiveTurn(session.id, { turnId: "t1", status: "running" });

    const form = new FormData();
    form.set("destDir", "assets");
    form.set("file", new File([new Uint8Array([1])], "x.png", { type: "image/png" }));

    const res = await app.request(
      `/v1/sessions/${session.id}/workspace/files/upload`,
      { method: "POST", body: form },
    );
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe("workspace_locked");
  });
});
