import { describe, it, expect } from "vitest";
import { S3SkillArtifactStore } from "../src/s3/skill-artifact-store.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fake HTTP layer backed by an in-memory object map keyed by the full
 * storage object key (`object/<bucket>/<tenant>/skills/<skill-id>/<path>`). This is
 * the S3/Supabase Storage boundary the store speaks to; mocking it lets us
 * assert exactly what keys get written/read/listed/deleted.
 */
function makeFakeFetch(initial: Record<string, Uint8Array> = {}) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}),
    );
    let body: unknown;
    if (init?.body != null) {
      body = init.body instanceof Uint8Array ? init.body : init.body;
    }
    calls.push({ url, method, headers, body });

    const listMatch = url.match(/\/object\/list\/([^/]+)$/);
    if (listMatch && method === "POST") {
      const { prefix, limit, offset } = JSON.parse(String(init!.body)) as {
        prefix: string;
        limit: number;
        offset: number;
      };
      // Mimic Supabase Storage's object/list: it is NOT recursive. For a given
      // prefix it returns files at that exact level, plus a single folder
      // placeholder (id/metadata null) per subdir name for anything deeper.
      const base = `object/${listMatch[1]}/${prefix}`;
      const seenFolders = new Set<string>();
      const fileEntries: Array<Record<string, unknown>> = [];
      for (const k of [...objects.keys()].sort()) {
        if (!k.startsWith(base)) continue;
        const rel = k.slice(base.length);
        const slash = rel.indexOf("/");
        if (slash === -1) {
          fileEntries.push({
            name: rel,
            id: k,
            updated_at: "2024-01-01T00:00:00Z",
            metadata: { size: objects.get(k)!.byteLength },
          });
        } else {
          seenFolders.add(rel.slice(0, slash));
        }
      }
      const folderEntries = [...seenFolders].sort().map((name) => ({
        name,
        id: null,
        updated_at: null,
        metadata: null,
      }));
      const all = [...folderEntries, ...fileEntries];
      return jsonResponse(all.slice(offset, offset + limit));
    }

    const objMatch = url.match(/\/object\/(.+)$/);
    if (objMatch) {
      const key = `object/${objMatch[1]}`;
      if (method === "GET") {
        const val = objects.get(key);
        if (!val) return new Response(null, { status: 404 });
        return new Response(val, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (method === "HEAD") {
        return new Response(null, { status: objects.has(key) ? 200 : 404 });
      }
      if (method === "POST") {
        const buf =
          init!.body instanceof Uint8Array
            ? init!.body
            : new TextEncoder().encode(String(init!.body));
        objects.set(key, buf);
        return jsonResponse({ Key: objMatch[1] });
      }
      if (method === "DELETE") {
        const existed = objects.delete(key);
        return existed
          ? jsonResponse({ message: "Deleted" })
          : new Response(null, { status: 404 });
      }
    }

    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  return { fetchImpl, objects, calls };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStore(fake: ReturnType<typeof makeFakeFetch>) {
  return new S3SkillArtifactStore({
    endpoint: "http://storage.local/storage/v1",
    serviceKey: "svc-key",
    bucket: "workspace",
    fetch: fake.fetchImpl,
  });
}

describe("Supabase Skill artifact storage retained after OSS Workspace cutover", () => {
  it("keeps Skill forks isolated by tenant and ID while supporting tree copy and deletion", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put("tenant", "original", "SKILL.md", "# Writer");
    await store.put("tenant", "original", "scripts/helper", new Uint8Array([0, 255]));
    await store.copyTree("tenant", "original", "fork");
    expect(await store.list("tenant", "fork")).toEqual(["scripts/helper", "SKILL.md"]);
    expect(await store.get("other", "fork", "SKILL.md")).toBeNull();
    expect(await store.get("tenant", "other", "SKILL.md")).toBeNull();
    await store.deleteTree("tenant", "original");
    expect(await store.list("tenant", "original")).toEqual([]);
    expect(new TextDecoder().decode((await store.get("tenant", "fork", "SKILL.md"))!)).toBe("# Writer");
    expect([...fake.objects.keys()]).toEqual([
      "object/workspace/tenant/skills/fork/scripts/helper",
      "object/workspace/tenant/skills/fork/SKILL.md",
    ]);
    expect(fake.calls[0].headers.Authorization).toBe("Bearer svc-key");
  });

  it("recursively lists every Supabase page, including empty files and nested Skill assets", async () => {
    const initial: Record<string, Uint8Array> = {};
    for (let index = 0; index < 1001; index++) initial[`object/workspace/t/skills/s/file-${index}`] = new Uint8Array();
    initial["object/workspace/t/skills/s/references/guide.md"] = new TextEncoder().encode("guide");
    const store = makeStore(makeFakeFetch(initial));
    const files = await store.getAll("t", "s");
    expect(files).toHaveLength(1002);
    expect(files.find((file) => file.path === "file-1000")?.body).toEqual(new Uint8Array());
    expect(new TextDecoder().decode(files.find((file) => file.path === "references/guide.md")?.body)).toBe("guide");
  });

  it("rejects traversal and reports Skill storage service failures", async () => {
    const store = makeStore(makeFakeFetch());
    await expect(store.put("tenant", "fork", "../secret", "bad")).rejects.toThrow("Invalid skill path");
    const failed = new S3SkillArtifactStore({
      endpoint: "http://storage.local/storage/v1", serviceKey: "test-key",
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    await expect(failed.list("tenant", "fork")).rejects.toThrow("503");
    await expect(failed.get("tenant", "fork", "SKILL.md")).rejects.toThrow("503");
    await expect(failed.put("tenant", "fork", "SKILL.md", "# Skill")).rejects.toThrow("503");
  });
});
