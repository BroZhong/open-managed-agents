import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// A separate SDK singleton per case, with real requests held by a local server.
// This checks the installed patch, both module formats and sharing across clients.
const run = promisify(execFile);
describe("E2B control API connection budget", () => {
  it.each(["module", "commonjs"])("defaults to 100 and accepts 200 (%s)", async format => {
    for (const limit of [undefined, "200"]) {
      const env = { ...process.env };
      delete env.E2B_API_CONNECTIONS;
      if (limit) env.E2B_API_CONNECTIONS = limit;
      const expected = Number(limit ?? 100);
      const script = `
        (async () => {
          const { ApiClient, ConnectionConfig } = ${format === "module" ? 'await import("e2b")' : 'require("e2b")'};
          const { createServer } = await import("node:http");
          const held = []; let release = false;
          const server = createServer((req, res) => {
            if (release) res.end('{}'); else held.push(res);
          });
          await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
          const config = new ConnectionConfig({ apiKey: 'local-fixture', apiUrl: 'http://127.0.0.1:' + server.address().port });
          const clients = [new ApiClient(config), new ApiClient(config)];
          const requests = Array.from({ length: 220 }, (_, i) => clients[i % 2].api.GET('/sandboxes'));
          const until = Date.now() + 8000;
          while (held.length < ${expected} && Date.now() < until) await new Promise(r => setTimeout(r, 10));
          await new Promise(r => setTimeout(r, 200));
          const observed = held.length; release = true;
          held.forEach(res => res.end('{}'));
          await Promise.all(requests);
          server.closeAllConnections(); server.close();
          console.log(JSON.stringify({ observed }));
        })().catch(e => { console.error(e); process.exit(1); });
      `;
      const { stdout } = await run(process.execPath, [`--input-type=${format}`, "-e", script], { env, timeout: 15000 });
      expect(JSON.parse(stdout).observed).toBe(expected);
    }
  }, 30000);
});
