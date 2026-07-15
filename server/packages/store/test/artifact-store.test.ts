import { describe, it, expect } from "vitest";
import { S3ArtifactStore } from "../src/s3/artifact-store.js";
import { encodeStoragePath } from "../src/s3/storage-path-codec.js";

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
function makeFakeFetch(
  initial: Record<string, Uint8Array> = {},
  opts: { rejectObjectKey?: (key: string) => boolean } = {},
) {
  const objects = new Map<string, Uint8Array>(Object.entries(initial));
  const userMetadata = new Map<string, Record<string, unknown>>();
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Model the HTTP boundary: URL path segments arrive percent-decoded at the
    // Storage route before its object-key validation runs.
    const decodedPathname = decodeURIComponent(new URL(url).pathname);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}),
    );
    let body: unknown;
    if (init?.body != null) {
      body = init.body instanceof Uint8Array ? init.body : init.body;
    }
    calls.push({ url, method, headers, body });

    const listMatch = decodedPathname.match(/\/object\/list\/([^/]+)$/);
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

    const signMatch = decodedPathname.match(/\/object\/sign\/([^/]+)\/(.+)$/);
    if (signMatch && method === "POST") {
      const key = signMatch[2];
      return jsonResponse({
        signedURL: `/object/sign/${signMatch[1]}/${key}?token=fake-jwt`,
      });
    }

    const infoMatch = decodedPathname.match(
      /\/object\/info\/authenticated\/([^/]+)\/(.+)$/,
    );
    if (infoMatch && method === "GET") {
      const objectKey = `${infoMatch[1]}/${infoMatch[2]}`;
      const key = `object/${objectKey}`;
      if (opts.rejectObjectKey?.(objectKey)) {
        return new Response(
          JSON.stringify({
            statusCode: "400",
            error: "InvalidKey",
            message: `Invalid key: ${objectKey}`,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (!objects.has(key)) return new Response(null, { status: 404 });
      return jsonResponse({ metadata: userMetadata.get(key) ?? null });
    }

    const objMatch = decodedPathname.match(/\/object\/(.+)$/);
    if (objMatch) {
      const key = `object/${objMatch[1]}`;
      if (opts.rejectObjectKey?.(objMatch[1])) {
        return new Response(
          JSON.stringify({
            statusCode: "400",
            error: "InvalidKey",
            message: `Invalid key: ${objMatch[1]}`,
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
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
        const encodedMetadata = headers["x-metadata"];
        if (encodedMetadata) {
          userMetadata.set(
            key,
            JSON.parse(Buffer.from(encodedMetadata, "base64").toString("utf8")) as Record<
              string,
              unknown
            >,
          );
        } else {
          userMetadata.delete(key);
        }
        return jsonResponse({ Key: objMatch[1] });
      }
      if (method === "DELETE") {
        const existed = objects.delete(key);
        userMetadata.delete(key);
        return existed
          ? jsonResponse({ message: "Deleted" })
          : new Response(null, { status: 404 });
      }
    }

    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;

  return { fetchImpl, objects, userMetadata, calls };
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

function isSupabaseInvalidKey(key: string): boolean {
  return !/^[-A-Za-z0-9_\/!.*'() &$@=;:+,?]+$/.test(key);
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
    const putCall = fake.calls.find(
      (c) => c.method === "POST" && c.url.includes("/object/workspace/"),
    );
    expect(putCall!.headers.Authorization).toBe("Bearer svc-key");
  });

  it("round-trips a Supabase-invalid filename without changing its logical path", async () => {
    const path = "项目/不要替我原谅她/正文/第10章：漂亮的流程.md";
    const fake = makeFakeFetch({}, {
      // Reproduce the production Storage response from sess_nmibO0vOAYowVVWK-FkNQ.
      rejectObjectKey: isSupabaseInvalidKey,
    });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "chapter" });

    expect(
      [...fake.objects.keys()].every((key) =>
        !isSupabaseInvalidKey(key.slice("object/".length)),
      ),
    ).toBe(true);
    expect((await store.list("t1", "w1")).map((item) => item.path)).toEqual([path]);
    expect(
      new TextDecoder().decode((await store.get("t1", "w1", path))!.body),
    ).toBe("chapter");
    expect(await store.exists("t1", "w1", path)).toBe(true);
    expect(await store.delete("t1", "w1", path)).toBe(true);
    expect(await store.exists("t1", "w1", path)).toBe(false);
  });

  it("preserves Chinese legacy keys while avoiding the session's U+FF1A failure", async () => {
    const legacyPath = "项目/不要替我原谅她/创作决策.md";
    const chapterPath = "项目/不要替我原谅她/正文/第10章：漂亮的流程.md";
    const legacyKey = `object/workspace/t1/w1/${legacyPath}`;
    const fake = makeFakeFetch(
      { [legacyKey]: new TextEncoder().encode("legacy") },
      {
        // Model the observed delta: these existing Chinese names work, while
        // the full-width colon is the character named by InvalidKey.
        rejectObjectKey: (key) => key.includes("："),
      },
    );
    const store = makeStore(fake);

    await store.put({
      tenantId: "t1",
      workspaceId: "w1",
      path: chapterPath,
      body: "new",
    });

    expect(fake.objects.has(legacyKey)).toBe(true);
    expect((await store.list("t1", "w1")).map((item) => item.path).sort()).toEqual(
      [legacyPath, chapterPath].sort(),
    );
    expect(
      fake.calls
        .filter(
          (call) => call.method === "POST" && call.url.includes("/object/workspace/"),
        )
        .every((call) => !decodeURIComponent(call.url).includes("：")),
    ).toBe(true);
  });

  it("keeps ASCII and full-width colon filenames distinct", async () => {
    const ascii = "项目/正文/第10章:漂亮的流程.md";
    const fullWidth = "项目/正文/第10章：漂亮的流程.md";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path: ascii, body: "ascii" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: fullWidth, body: "wide" });

    expect((await store.list("t1", "w1")).map((item) => item.path).sort()).toEqual(
      [ascii, fullWidth].sort(),
    );
    expect(new TextDecoder().decode((await store.get("t1", "w1", ascii))!.body)).toBe(
      "ascii",
    );
    expect(
      new TextDecoder().decode((await store.get("t1", "w1", fullWidth))!.body),
    ).toBe("wide");
    expect(await store.delete("t1", "w1", fullWidth)).toBe(true);
    expect(await store.get("t1", "w1", fullWidth)).toBeNull();
    expect(new TextDecoder().decode((await store.get("t1", "w1", ascii))!.body)).toBe(
      "ascii",
    );
  });

  it("keeps ASCII colon raw but encodes the U+FF1A full-width colon", async () => {
    const ascii = "notes/chapter:flow.md";
    const fullWidth = "notes/chapter：flow.md";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path: ascii, body: "ascii" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: fullWidth, body: "wide" });

    expect(fake.objects.has(`object/workspace/t1/w1/${ascii}`)).toBe(true);
    expect(
      fake.objects.has(`object/workspace/t1/w1/${encodeStoragePath(fullWidth)}`),
    ).toBe(true);
    expect((await store.list("t1", "w1")).map((item) => item.path).sort()).toEqual(
      [ascii, fullWidth].sort(),
    );
  });

  it("preserves a logical filename that starts with the codec marker", async () => {
    const path = "notes/__oma_b64url_v1__5Lit5paHLm1k";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "literal" });

    expect((await store.list("t1", "w1")).map((item) => item.path)).toEqual([path]);
    expect(new TextDecoder().decode((await store.get("t1", "w1", path))!.body)).toBe(
      "literal",
    );
  });

  it("never mistakes a pre-codec marker-shaped filename for an encoded key", async () => {
    const literalPath = "notes/__oma_b64url_v1__5Lit5paH";
    const unicodePath = "notes/中文";
    const rawKey = `object/workspace/t1/w1/${literalPath}`;
    const fake = makeFakeFetch(
      { [rawKey]: new TextEncoder().encode("literal") },
      { rejectObjectKey: isSupabaseInvalidKey },
    );
    const store = makeStore(fake);

    expect((await store.list("t1", "w1")).map((item) => item.path)).toEqual([
      literalPath,
    ]);
    expect(await store.get("t1", "w1", unicodePath)).toBeNull();
    expect(await store.delete("t1", "w1", unicodePath)).toBe(false);
    expect(fake.objects.has(rawKey)).toBe(true);
    await expect(
      store.put({ tenantId: "t1", workspaceId: "w1", path: unicodePath, body: "unicode" }),
    ).rejects.toThrow(/occupied by another logical path/);
  });

  it("stores an encoded name and its marker-shaped literal name independently", async () => {
    const unicodePath = "notes/中文";
    const literalPath = "notes/__oma_b64url_v1__5Lit5paH";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({
      tenantId: "t1",
      workspaceId: "w1",
      path: unicodePath,
      body: "unicode",
    });
    await store.put({
      tenantId: "t1",
      workspaceId: "w1",
      path: literalPath,
      body: "literal",
    });

    expect((await store.list("t1", "w1")).map((item) => item.path).sort()).toEqual(
      [unicodePath, literalPath].sort(),
    );
    expect(new TextDecoder().decode((await store.get("t1", "w1", unicodePath))!.body)).toBe(
      "unicode",
    );
    expect(new TextDecoder().decode((await store.get("t1", "w1", literalPath))!.body)).toBe(
      "literal",
    );
    expect(await store.delete("t1", "w1", literalPath)).toBe(true);
    expect(new TextDecoder().decode((await store.get("t1", "w1", unicodePath))!.body)).toBe(
      "unicode",
    );
  });

  it("marks every encoded upsert with authoritative codec metadata", async () => {
    const path = "notes/中文.md";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "one" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "two" });

    const writes = fake.calls.filter(
      (call) => call.method === "POST" && call.url.includes("/object/workspace/"),
    );
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(
        JSON.parse(Buffer.from(write.headers["x-metadata"], "base64").toString("utf8")),
      ).toEqual({ open_managed_agents_path_codec: "base64url-v1" });
    }
    expect((await store.list("t1", "w1")).map((item) => item.path)).toEqual([path]);
  });

  it("fails loudly for an unknown codec metadata version", async () => {
    const path = "notes/中文.md";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "body" });
    const physicalKey = [...fake.objects.keys()][0];
    fake.userMetadata.set(physicalKey, {
      open_managed_agents_path_codec: "base64url-v999",
    });

    await expect(store.list("t1", "w1")).rejects.toThrow(/Unsupported storage path codec/);
    await expect(store.get("t1", "w1", path)).rejects.toThrow(
      /Unsupported storage path codec/,
    );
  });

  it("rejects a path that cannot be encoded injectively", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);

    await expect(
      store.put({ tenantId: "t1", workspaceId: "w1", path: "bad-\ud800.md", body: "x" }),
    ).rejects.toThrow(/unpaired UTF-16 surrogate/);
    await expect(
      store.put({ tenantId: "t1", workspaceId: "w1", path: "bad-\0.md", body: "x" }),
    ).rejects.toThrow(/NUL byte/);
  });

  it("lists encoded and legacy paths under the same logical prefix", async () => {
    const legacyPath = "项目/不要替我原谅她/创作决策.md";
    const encodedPath = "项目/不要替我原谅她/正文/第10章：漂亮的流程.md";
    const fake = makeFakeFetch(
      {
        [`object/workspace/t1/w1/${legacyPath}`]: new TextEncoder().encode("legacy"),
      },
    );
    const store = makeStore(fake);
    await store.put({
      tenantId: "t1",
      workspaceId: "w1",
      path: encodedPath,
      body: "chapter",
    });

    expect(
      (await store.list("t1", "w1", "项目/不要替我原谅她/")).map(
        (item) => item.path,
      ).sort(),
    ).toEqual([legacyPath, encodedPath].sort());
    expect(new TextDecoder().decode((await store.get("t1", "w1", legacyPath))!.body)).toBe(
      "legacy",
    );
  });

  it("updates a legacy raw key in place instead of creating a duplicate", async () => {
    const path = "项目/不要替我原谅她/创作决策.md";
    const rawKey = `object/workspace/t1/w1/${path}`;
    const fake = makeFakeFetch({
      [rawKey]: new TextEncoder().encode("before"),
    });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "after" });

    expect([...fake.objects.keys()]).toEqual([rawKey]);
    expect(new TextDecoder().decode(fake.objects.get(rawKey)!)).toBe("after");
  });

  it("fails loudly when canonical and legacy keys conflict", async () => {
    const path = "项目/正文/第10章：漂亮的流程.md";
    const base = "object/workspace/t1/w1/";
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "canonical" });
    fake.objects.set(`${base}${path}`, new TextEncoder().encode("legacy"));

    await expect(store.list("t1", "w1")).rejects.toThrow(/conflicting physical keys/);
    await expect(store.get("t1", "w1", path)).rejects.toThrow(/conflicting physical keys/);
    await expect(store.exists("t1", "w1", path)).rejects.toThrow(
      /conflicting physical keys/,
    );
    await expect(
      store.put({ tenantId: "t1", workspaceId: "w1", path, body: "new" }),
    ).rejects.toThrow(/conflicting physical keys/);
    await expect(store.delete("t1", "w1", path)).rejects.toThrow(
      /conflicting physical keys/,
    );
  });

  it("keeps canonically equivalent Unicode filenames distinct", async () => {
    const nfc = "notes/café.md";
    const nfd = "notes/cafe\u0301.md";
    const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
    const store = makeStore(fake);

    await store.put({ tenantId: "t1", workspaceId: "w1", path: nfc, body: "NFC" });
    await store.put({ tenantId: "t1", workspaceId: "w1", path: nfd, body: "NFD" });

    expect((await store.list("t1", "w1")).map((item) => item.path).sort()).toEqual(
      [nfc, nfd].sort(),
    );
    expect(new TextDecoder().decode((await store.get("t1", "w1", nfc))!.body)).toBe(
      "NFC",
    );
    expect(new TextDecoder().decode((await store.get("t1", "w1", nfd))!.body)).toBe(
      "NFD",
    );
  });

  it("URL-encodes Storage-safe delimiters without changing their object key", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    const path = "notes/why?.md";

    await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "answer" });

    expect([...fake.objects.keys()]).toEqual([`object/workspace/t1/w1/${path}`]);
    const putCall = fake.calls.find((call) => call.method === "POST");
    expect(putCall!.url).toContain("why%3F.md");
    expect(new URL(putCall!.url).search).toBe("");
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

  it("checks existence with HEAD without downloading the object body", async () => {
    const fake = makeFakeFetch();
    const store = makeStore(fake);
    await store.put({ tenantId: "t1", workspaceId: "w1", path: "movie.mp4", body: "bytes" });

    expect(await store.exists("t1", "w1", "movie.mp4")).toBe(true);
    expect(await store.exists("t1", "w1", "missing.mp4")).toBe(false);

    const objectReads = fake.calls.filter((call) => call.url.includes("/object/workspace/") && ["GET", "HEAD"].includes(call.method));
    expect(objectReads.map((call) => call.method)).toEqual(["HEAD", "HEAD"]);
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

    it("signs the canonical key for a newly encoded logical path", async () => {
      const path = "项目/正文/第10章：漂亮的流程.md";
      const fake = makeFakeFetch({}, { rejectObjectKey: isSupabaseInvalidKey });
      const store = new S3ArtifactStore({
        endpoint: "http://storage.local/storage/v1",
        serviceKey: "svc-key",
        bucket: "workspace",
        fetch: fake.fetchImpl,
        publicBase: "http://public.example/storage/v1",
      });
      await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "chapter" });

      await store.createSignedReadUrl("t1", "w1", path, 300);

      const signCall = fake.calls.find((call) => call.url.includes("/object/sign/"));
      expect(decodeURIComponent(signCall!.url)).toContain(encodeStoragePath(path));
      expect(decodeURIComponent(signCall!.url)).not.toContain("：");
    });

    it("signs the exact raw key for a legacy object", async () => {
      const path = "项目/不要替我原谅她/创作决策.md";
      const fake = makeFakeFetch({
        [`object/workspace/t1/w1/${path}`]: new TextEncoder().encode("legacy"),
      });
      const store = new S3ArtifactStore({
        endpoint: "http://storage.local/storage/v1",
        serviceKey: "svc-key",
        bucket: "workspace",
        fetch: fake.fetchImpl,
        publicBase: "http://public.example/storage/v1",
      });

      await store.createSignedReadUrl("t1", "w1", path, 300);

      const signCall = fake.calls.find((call) => call.url.includes("/object/sign/"));
      expect(decodeURIComponent(signCall!.url)).toContain(`/workspace/t1/w1/${path}`);
    });

    it("refuses to sign when canonical and legacy keys conflict", async () => {
      const path = "项目/正文/第10章：漂亮的流程.md";
      const base = "object/workspace/t1/w1/";
      const fake = makeFakeFetch();
      const store = new S3ArtifactStore({
        endpoint: "http://storage.local/storage/v1",
        serviceKey: "svc-key",
        bucket: "workspace",
        fetch: fake.fetchImpl,
        publicBase: "http://public.example/storage/v1",
      });
      await store.put({ tenantId: "t1", workspaceId: "w1", path, body: "canonical" });
      fake.objects.set(`${base}${path}`, new TextEncoder().encode("legacy"));

      await expect(store.createSignedReadUrl("t1", "w1", path, 300)).rejects.toThrow(
        /conflicting physical keys/,
      );
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
