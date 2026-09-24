import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { S3SkillArtifactStore } from "../src/s3/skill-artifact-store.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture() {
  const objects = new Map<string, Buffer>();
  const requests: URL[] = [];
  let failureStatus: number | undefined;
  let failureBody = "storage request failed";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://storage.test");
    requests.push(url);
    if (failureStatus) { res.writeHead(failureStatus); res.end(failureBody); return; }
    const key = decodeURIComponent(url.pathname);
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200); res.end("{}");
    } else if (!objects.has(key)) {
      res.writeHead(404); res.end();
    } else if (req.method === "DELETE") {
      objects.delete(key); res.writeHead(200); res.end("{}");
    } else {
      res.writeHead(200); res.end(objects.get(key));
    }
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const store = new S3SkillArtifactStore({
    endpoint: `http://127.0.0.1:${address.port}/storage/v1`,
    serviceKey: "test-service-key", bucket: "workspace",
  });
  return {
    store,
    objects,
    requests,
    fail: (status: number, body?: string) => {
      failureStatus = status;
      failureBody = body ?? "storage request failed";
    },
  };
}

describe("retained Skill storage over actual HTTP", () => {
  it("preserves special names and encoded traversal as literal keys inside the owning Skill", async () => {
    const { store, objects, requests } = await fixture();
    const paths = ["references/a#b.md", "references/a?b.md", "references/a%2Fb.md", "中文 空格.md",
      "%2e%2e/other/SKILL.md", "%2e%2e/%2e%2e/%2e%2e/other-tenant/SKILL.md"];
    for (const path of paths) await store.put("tenant", "own", path, path);
    expect([...objects.keys()]).toEqual(paths.map(path => `/storage/v1/object/workspace/tenant/skills/own/${path}`));
    for (const path of paths) {
      expect(new TextDecoder().decode((await store.get("tenant", "own", path))!)).toBe(path);
      await store.delete("tenant", "own", path);
    }
    expect(objects.size).toBe(0);
    expect(requests.every(url => url.search === "" && url.hash === "")).toBe(true);
  });

  it("reports HTTP 400 reads and deletes as errors, while 404 means missing", async () => {
    const { store, fail } = await fixture();
    expect(await store.get("tenant", "own", "missing.md")).toBeNull();
    await store.delete("tenant", "own", "missing.md");
    fail(400);
    await expect(store.get("tenant", "own", "SKILL.md")).rejects.toThrow("400");
    await expect(store.delete("tenant", "own", "SKILL.md")).rejects.toThrow("400");
  });

  it("treats Supabase's JSON 404 wrapped in HTTP 400 as a missing object", async () => {
    const { store, fail } = await fixture();
    fail(
      400,
      JSON.stringify({
        statusCode: "404",
        error: "Not Found",
        message: "Object not found",
      }),
    );
    expect(await store.get("tenant", "own", "missing.md")).toBeNull();
    await expect(store.delete("tenant", "own", "missing.md")).resolves.toBeUndefined();
  });
});
