import { spawn } from "node:child_process";
import { createServer } from "node:http";
export async function fixture(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    });
    try {
      await handler(req, res, body);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(r);
      }),
  };
}
export function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
export function run(
  args,
  {
    env = {},
    input = "",
    bin = new URL("../dist/main.js", import.meta.url),
    cwd,
    signalAfter,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [typeof bin === "string" ? bin : bin.pathname, ...args],
      {
        cwd,
        env: { ...process.env, OMA_BASE_URL: "", OMA_API_KEY: "", ...env },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    child.on("error", reject);
    const timer = signalAfter
      ? setTimeout(() => child.kill("SIGINT"), signalAfter)
      : undefined;
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        data: () => JSON.parse(stdout),
        error: () => JSON.parse(stderr).error,
      });
    });
    child.stdin.end(input);
  });
}
export const auth = (f) => ({
  env: { OMA_BASE_URL: f.url + "/prefix", OMA_API_KEY: "test-secret" },
});
