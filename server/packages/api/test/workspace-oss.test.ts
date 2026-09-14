import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OSSArtifactStore } from "@oma-server/store";
import { createMemoryStores } from "@oma-server/store-memory";
import { InMemoryTurnStreamStore } from "@oma-server/redis";
import { ossTestOptions } from "../../store/test/oss-harness.js";
import { createOSSHTTPHarness } from "../../store/test/oss-http-harness.js";
import { createApp } from "../src/app.js";

beforeEach(() => {
  vi.stubEnv("AUTH_DISABLED", "false");
  vi.stubEnv("INVITE_CODE", "integration-test");
  vi.stubEnv("AUTH_JWT_SECRET", "integration-test-jwt-secret");
});
const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  vi.unstubAllEnvs();
});

async function harness() {
  const stores = createMemoryStores();
  const oss = await createOSSHTTPHarness();
  fixtures.push(oss);
  const artifactStore = new OSSArtifactStore({ ...ossTestOptions, endpoint: oss.endpoint });
  const turnStreamStore = new InMemoryTurnStreamStore();
  const app = createApp({ ...stores, artifactStore, turnStreamStore });
  const json = (path: string, body: unknown, token?: string) => app.request(path, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  async function login(username: string) {
    expect((await json("/auth/register", { username, password: "test-password", inviteCode: "integration-test" })).status).toBe(200);
    const response = await json("/auth/login", { username, password: "test-password" });
    expect(response.status).toBe(200);
    return (await response.json()).token as string;
  }
  async function session(token: string, workspaceId: string) {
    const agent = await json("/v1/agents", { name: "OSS test", runtime: "mock", model: "mock", system: "test" }, token);
    expect(agent.status).toBe(201);
    const response = await json("/v1/sessions", { agent: (await agent.json()).id, workspace_id: workspaceId }, token);
    expect(response.status).toBe(201);
    return await response.json() as { id: string; tenantId: string; workspaceId: string };
  }
  return { app, oss, turnStreamStore, json, login, session };
}

describe("authenticated Host file management backed by OSS", () => {
  it("uploads, lists paginated Unicode/hidden/empty files, previews, downloads, overwrites, renames and deletes", async () => {
    const h = await harness();
    const token = await h.login("alice");
    const session = await h.session(token, "shared");
    const base = `/v1/sessions/${session.id}/workspace`;
    const headers = { authorization: `Bearer ${token}` };
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
    for (const [path, body] of [["中文 图片.png", bytes], [".hidden", "secret"], ["empty.txt", ""]] as const) {
      const form = new FormData();
      form.append("path", path);
      form.append("file", new File([body], path));
      expect((await h.app.request(`${base}/files/upload`, { method: "POST", headers, body: form })).status).toBe(200);
    }
    const listing = await h.app.request(`${base}/files`, { headers });
    expect((await listing.json()).data.map((f: { path: string }) => f.path).sort()).toEqual([".hidden", "empty.txt", "中文 图片.png"]);
    const preview = await h.app.request(`${base}/files/${encodeURIComponent("中文 图片.png")}`, { headers });
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);
    const download = await h.app.request(`${base}/files/${encodeURIComponent("中文 图片.png")}?download=1`, { headers });
    expect(download.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
    const signed = await h.app.request(`${base}/preview-url?path=${encodeURIComponent("中文 图片.png")}`, { headers });
    expect(signed.status).toBe(200);
    const { url, expiresIn } = await signed.json();
    expect(new URL(url).hostname).toBe("agentry.oss-cn-shanghai.aliyuncs.com");
    expect(expiresIn).toBe(600);
    expect(url).not.toContain(ossTestOptions.accessKeySecret);
    expect((await h.json(`${base}/files/rename`, { from: "中文 图片.png", to: "empty.txt" }, token)).status).toBe(200);
    const overwritten = await h.app.request(`${base}/files/empty.txt`, { headers });
    expect(new Uint8Array(await overwritten.arrayBuffer())).toEqual(bytes);
    expect((await h.app.request(`${base}/files/content?path=empty.txt`, { method: "DELETE", headers })).status).toBe(200);
    expect((await h.app.request(`${base}/files/empty.txt`, { headers })).status).toBe(404);
  });

  it("binds every API operation to the authenticated Tenant and Session Workspace", async () => {
    const h = await harness();
    const alice = await h.login("alice");
    const bob = await h.login("bob");
    const owner = await h.session(alice, "shared");
    const sibling = await h.session(alice, "shared_other");
    const foreign = await h.session(bob, "shared");
    const base = `/v1/sessions/${owner.id}/workspace`;
    const headers = { authorization: `Bearer ${alice}` };
    const write = (target: string, path: string) => h.app.request(`${target}/files/content`, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ path, content: "private" }),
    });
    expect((await write(base, "private.txt")).status).toBe(200);
    for (const id of ["../other", "tenant%2fworkspace", "bad name", ""]) {
      expect((await h.json("/v1/workspaces", { id }, alice)).status).toBe(400);
    }
    expect((await h.app.request(`${base}/files`)).status).toBe(401);
    expect((await h.app.request(`${base}/files`, { headers: { authorization: `Bearer ${bob}` } })).status).toBe(404);
    const other = await h.app.request(`/v1/sessions/${sibling.id}/workspace/files`, { headers });
    expect((await other.json()).data).toEqual([]);
    for (const suffix of ["files", "files/private.txt", "preview-url?path=private.txt"]) {
      expect((await h.app.request(`/v1/sessions/${foreign.id}/workspace/${suffix}`, { headers })).status).toBe(404);
    }
    expect((await write(`/v1/sessions/${foreign.id}/workspace`, "evil.txt")).status).toBe(404);
    for (const path of ["../shared_other/x", "/etc/passwd", "a\\b", ".oma-workspace-checks/probe"]) {
      expect((await write(base, path)).status).toBe(400);
    }
    expect((await h.app.request(`${base}/files?prefix=%2e%2e%2fshared_other`, { headers })).status).toBe(400);
    await h.turnStreamStore.setActiveTurn(owner.id, { turnId: "running", status: "running" });
    expect((await write(base, "locked.txt")).status).toBe(423);
    // A second Session of the same Workspace retains the existing per-Session gate.
    const concurrent = await h.session(alice, "shared");
    expect((await write(`/v1/sessions/${concurrent.id}/workspace`, "parallel.txt")).status).toBe(200);
  });
});
