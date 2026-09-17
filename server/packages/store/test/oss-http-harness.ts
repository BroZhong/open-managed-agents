import { createServer } from "node:http";

/** A repeatable OSS wire fixture: the production SDK still serializes, signs,
 * sends and parses every request. No cloud credentials or live Bucket needed. */
export async function createOSSHTTPHarness(options: { missingBucket?: boolean; customDomain?: boolean } = {}) {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const requests: Array<{ method: string; key: string }> = [];
  const xml = (value: string) => value.replace(/[<>&'\"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]!);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const key = decodeURIComponent(url.pathname.slice(1));
    requests.push({ method: request.method!, key });
    response.setHeader("x-oss-request-id", "repeatable-integration");
    // Current OSS rejects this override even on correctly signed GETs (EC0017-00000902).
    if (request.method === "GET" && url.searchParams.has("response-content-type") && !options.customDomain) {
      response.writeHead(400, { "content-type": "application/xml" });
      response.end("<Error><Code>InvalidRequest</Code><Message>Can not override response header on content-type</Message></Error>");
      return;
    }
    const signedRead = request.method === "GET" &&
      url.searchParams.get("x-oss-signature-version") === "OSS4-HMAC-SHA256" &&
      /^[a-f0-9]{64}$/.test(url.searchParams.get("x-oss-signature") ?? "");
    if (!signedRead && !request.headers.authorization?.startsWith("OSS4-HMAC-SHA256 ")) {
      response.writeHead(403, { "content-type": "application/xml" });
      response.end("<Error><Code>AccessDenied</Code><Message>V4 signature required</Message></Error>");
      return;
    }
    if (options.missingBucket) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchBucket</Code><Message>Bucket absent</Message></Error>");
      return;
    }
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const entries = [...objects].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = entries.slice(start, start + 2);
      const more = start + 2 < entries.length;
      response.writeHead(200, { "content-type": "application/xml" });
      response.end(`<ListBucketResult><Name>agentry</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}${page.map(([name, object]) => `<Contents><Key>${xml(name)}</Key><LastModified>2026-09-14T00:00:00.000Z</LastModified><Size>${object.body.length}</Size></Contents>`).join("")}</ListBucketResult>`);
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key, { body: Buffer.concat(chunks), contentType: request.headers["content-type"] ?? "application/octet-stream" });
      response.writeHead(200, { etag: '"fixture-etag"' });
      response.end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchKey</Code><Message>Object absent</Message></Error>");
      return;
    }
    const headers: Record<string, string | number> = {
      "content-type": url.searchParams.get("response-content-type") ?? object.contentType,
      "content-length": object.body.length,
      etag: '"fixture-etag"', "accept-ranges": "bytes",
    };
    const disposition = url.searchParams.get("response-content-disposition");
    if (disposition) headers["content-disposition"] = disposition;
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (request.method === "GET" && range) {
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : object.body.length - 1, object.body.length - 1);
      if (start > end) {
        response.writeHead(416, { "content-range": `bytes */${object.body.length}` });
        response.end();
        return;
      }
      response.writeHead(206, { ...headers, "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${object.body.length}` });
      response.end(object.body.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : object.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OSS fixture did not listen");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
