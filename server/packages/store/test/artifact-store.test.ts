import { describe, it, expect } from "vitest";
import { S3ArtifactStore } from "../src/s3/artifact-store.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * A fake HTTP layer backed by an in-memory object map keyed by the full
 * storage object key (`object/<bucket>/<tenant>/<workspace>/<path>`). This is
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

    const signMatch = url.match(/\/object\/sign\/([^/]+)\/(.+)$/);
    if (signMatch && method === "POST") {
      const key = signMatch[2];
      return jsonResponse({
        signedURL: `/object/sign/${signMatch[1]}/${key}?token=fake-jwt`,
      });
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
  return new S3ArtifactStore({
    endpoint: "http://storage.local/storage/v1",
    serviceKey: "svc-key",
    bucket: "workspace",
    fetch: fake.fetchImpl,
  });
}

describe("S3ArtifactStore", () => {
  it("puts an object under <tenant>/<workspace>/<path>", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);

    await store.put({
      tenantId: "t1",
      workspaceId: "w1",
      path: "dir/file.txt",
      body: "hello",
    });

    expect([...fake.objects.keys()]).toEqual([
      "object/workspace/t1/w1/dir/file.txt",
    ]);
    const putCall = fake.calls.find((c) => c.method === "POST" && c.url.includes("/object/workspace/"));
    expect(putCall!.headers.Authorization).toBe("Bearer svc-key");
  });

  it("gets an object it wrote", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "hi" });

    const got = await store.get("t1", "w1", "a.txt");
    expect(got).not.toBeNull();
    expect(new TextDecoder().decode(got!.body)).toBe("hi");
  });

  it("returns null for a missing object", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    expect(await store.get("t1", "w1", "nope.txt")).toBeNull();
  });

  it("lists only objects under the workspace prefix", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "a" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "sub/b.txt", body: "b" });

    const items = await store.list("t1", "w1");
    const paths = items.map((i) => i.path).sort();
    expect(paths).toEqual(["a.txt", "sub/b.txt"]);
    expect(items[0].size).toBeGreaterThan(0);
  });

  it("deletes an object and reports whether it existed", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "a" });

    expect(await store.delete("t1", "w1", "a.txt")).toBe(true);
    expect(await store.delete("t1", "w1", "a.txt")).toBe(false);
    expect(await store.get("t1", "w1", "a.txt")).toBeNull();
  });

  describe("cross-tenant / cross-workspace isolation", () => {
    it("does not read another tenant's object at the same path", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake);
      await store.put({ tenantId: "t1", workspaceId: "w1", path: "secret.txt", body: "t1-data" });

      // Same workspace id + path, different tenant → distinct key, no leak.
      const other = await store.get("t2", "w1", "secret.txt");
      expect(other).toBeNull();
    });

    it("does not list another tenant's objects", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake);
      await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "a" });
      await store.put({ tenantId: "t2", workspaceId: "w1", path: "b.txt", body: "b" });

      const t1 = await store.list("t1", "w1");
      expect(t1.map((i) => i.path)).toEqual(["a.txt"]);
      const t2 = await store.list("t2", "w1");
      expect(t2.map((i) => i.path)).toEqual(["b.txt"]);
    });

    it("does not list another workspace within the same tenant", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake);
      await store.put({ tenantId: "t1", workspaceId: "w1", path: "a.txt", body: "a" });
      await store.put({ tenantId: "t1", workspaceId: "w2", path: "b.txt", body: "b" });

      const w1 = await store.list("t1", "w1");
      expect(w1.map((i) => i.path)).toEqual(["a.txt"]);
    });

    it("deleting in one workspace does not remove another workspace's object", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake);
      await store.put({ tenantId: "t1", workspaceId: "w1", path: "x.txt", body: "1" });
      await store.put({ tenantId: "t1", workspaceId: "w2", path: "x.txt", body: "2" });

      await store.delete("t1", "w1", "x.txt");
      expect(await store.get("t1", "w1", "x.txt")).toBeNull();
      expect(await store.get("t1", "w2", "x.txt")).not.toBeNull();
    });

    it("rejects path traversal that would escape the workspace prefix", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake);
      await expect(
        store.get("t1", "w1", "../w2/secret.txt"),
      ).rejects.toThrow(/Invalid artifact path/);
    });
  });

  describe("createSignedReadUrl", () => {
    it("signs on the internal endpoint under <tenant>/<workspace>/<path> and prefixes the public base", async () => {
      const fake = makeFakeFetch();
      const store = new S3ArtifactStore({
        endpoint: "http://storage.local/storage/v1",
        serviceKey: "svc-key",
        bucket: "workspace",
        fetch: fake.fetchImpl,
        publicBase: "http://public.example/storage/v1/",
      });

      const url = await store.createSignedReadUrl("t1", "w1", "dir/clip.mp4", 300);

      // Absolute URL: public base (trailing slash trimmed) + relative signedURL.
      expect(url).toBe(
        "http://public.example/storage/v1/object/sign/workspace/t1/w1/dir/clip.mp4?token=fake-jwt",
      );

      // The sign request went to the INTERNAL endpoint, POST, service-role auth,
      // for the fully-prefixed key.
      const signCall = fake.calls.find((c) => c.url.includes("/object/sign/"));
      expect(signCall).toBeDefined();
      expect(signCall!.method).toBe("POST");
      expect(signCall!.url).toBe(
        "http://storage.local/storage/v1/object/sign/workspace/t1/w1/dir/clip.mp4",
      );
      expect(signCall!.headers.Authorization).toBe("Bearer svc-key");
      expect(JSON.parse(String(signCall!.body))).toEqual({ expiresIn: 300 });
    });

    it("throws when no public base is configured", async () => {
      const fake = makeFakeFetch();
      const store = makeStore(fake); // no publicBase
      await expect(
        store.createSignedReadUrl("t1", "w1", "a.png", 300),
      ).rejects.toThrow(/publicBase not configured/);
    });

    it("rejects a traversal path before signing", async () => {
      const fake = makeFakeFetch();
      const store = new S3ArtifactStore({
        endpoint: "http://storage.local/storage/v1",
        serviceKey: "svc-key",
        bucket: "workspace",
        fetch: fake.fetchImpl,
        publicBase: "http://public.example/storage/v1",
      });
      await expect(
        store.createSignedReadUrl("t1", "w1", "../w2/secret.mp4", 300),
      ).rejects.toThrow(/Invalid artifact path/);
    });
  });
});
