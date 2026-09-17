import type { OSSObjectClient } from "../src/oss/artifact-store.js";

export function fakeOSS() {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const missing = () => Object.assign(new Error("Object absent"), { status: 404, code: "NoSuchKey" });
  const client: OSSObjectClient = {
    async put(name, body, options) {
      objects.set(name, { body: Buffer.from(body), contentType: options?.mime });
    },
    async get(name) {
      const object = objects.get(name);
      if (!object) throw missing();
      return { content: object.body, res: { headers: { "content-type": object.contentType } } };
    },
    async head(name) {
      const object = objects.get(name);
      if (!object) throw missing();
      return { res: { headers: { "content-type": object.contentType, "content-length": String(object.body.length), etag: '"fixture-etag"' } } };
    },
    async delete(name) { objects.delete(name); },
    async listV2(query) {
      const matches = [...objects].filter(([name]) => name.startsWith(query.prefix)).sort(([a], [b]) => a.localeCompare(b));
      const offset = Number(query["continuation-token"] ?? "0");
      const page = matches.slice(offset, offset + 2);
      return {
        objects: page.map(([name, object]) => ({ name, size: object.body.length, lastModified: "2026-09-14T00:00:00.000Z" })),
        isTruncated: offset + 2 < matches.length,
        nextContinuationToken: String(offset + 2),
      };
    },
  };
  return { client, objects };
}

export const ossTestOptions = {
  region: "oss-cn-shanghai",
  bucket: "agentry",
  accessKeyId: "test-access-id",
  accessKeySecret: "test-secret-never-returned",
};
