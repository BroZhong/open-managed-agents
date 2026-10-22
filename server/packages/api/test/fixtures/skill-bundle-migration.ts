import { createHash } from "node:crypto";
import { OFFICIAL_LIBERATION_SANS_REGULAR } from "../../src/skill-bundle-migration/fonts.js";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const text = (value: string) => new TextEncoder().encode(value);

/** A minimal well-formed sfnt: a directory of `head` + `name`, `head` carrying its magic number. */
export function syntheticFont(version = 0x00010000, seed = 1): Uint8Array {
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  const name = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 37 + seed * 101) % 256));
  const tables = [["head", head], ["name", name]] as const;
  const directory = Buffer.alloc(12 + 16 * tables.length);
  directory.writeUInt32BE(version, 0);
  directory.writeUInt16BE(tables.length, 4);
  let offset = directory.length;
  const bodies: Buffer[] = [];
  tables.forEach(([tag, body], index) => {
    const record = 12 + 16 * index;
    directory.write(tag, record, "latin1");
    directory.writeUInt32BE(offset, record + 8);
    directory.writeUInt32BE(body.length, record + 12);
    const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return new Uint8Array(Buffer.concat([directory, ...bodies]));
}

/** What the old upload route stored: the bytes decoded as UTF-8 and re-encoded. */
export function utf8Mangled(bytes: Uint8Array): Uint8Array {
  return text(new TextDecoder().decode(bytes));
}

/** The official pin with its digest swapped for a test font's, so tests never need the real file. */
export const pinnedFor = (body: Uint8Array) => ({ ...OFFICIAL_LIBERATION_SANS_REGULAR, sha256: sha256(body), size: body.byteLength });

type Failure = () => { status: number; body: string };

/**
 * An in-process Supabase Storage REST API over one bucket's objects: the
 * `object/list` endpoint (one folder level per call, folders as entries with a
 * null id and metadata, `limit`/`offset` paging) and object GET, which answers
 * a missing object with HTTP 400 and a JSON 404 body like the real service.
 * `failNext` queues failures; a failure that throws is a network error.
 */
export function fakeSupabaseStorage(options: { latencyMs?: number } = {}) {
  const objects = new Map<string, Uint8Array>();
  const failures: Failure[] = [];
  const requests: Array<{ kind: "list" | "get"; url: string; bucket: string; authorization: string | null }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
      const url = String(input);
      const rest = new URL(url).pathname.replace(/^\/storage\/v1\/object\//, "");
      const kind = rest.startsWith("list/") ? "list" : "get";
      const bucket = decodeURIComponent(kind === "list" ? rest.slice("list/".length) : rest.split("/")[0]);
      requests.push({ kind, url, bucket, authorization: new Headers(init?.headers).get("authorization") });
      const failure = failures.shift();
      if (failure) {
        const { status, body } = failure();
        return new Response(body, { status });
      }
      if (kind === "list") {
        const { prefix, limit, offset } = JSON.parse(String(init?.body)) as { prefix: string; limit: number; offset: number };
        const children = new Map<string, boolean>();
        for (const key of objects.keys()) {
          if (!key.startsWith(prefix)) continue;
          const [name, ...more] = key.slice(prefix.length).split("/");
          children.set(name, (children.get(name) ?? false) || more.length > 0);
        }
        const entries = [...children].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, folder]) => folder
          ? { name, id: null, metadata: null }
          : { name, id: `id-${name}`, metadata: { size: objects.get(`${prefix}${name}`)!.byteLength } });
        return Response.json(entries.slice(offset, offset + limit));
      }
      const body = objects.get(rest.split("/").slice(1).map(decodeURIComponent).join("/"));
      if (!body) return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
      return new Response(body.slice(), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    objects,
    requests,
    put(key: string, body: Uint8Array) { objects.set(key, body); },
    failNext(failure: Failure) { failures.push(failure); },
    maxInFlight: () => maxInFlight,
  };
}
