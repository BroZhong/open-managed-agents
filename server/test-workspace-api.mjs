// Run with OMA_API_URL and OMA_API_KEY. Creates its own Workspace and mock Agent;
// deletes files/Agent and terminates Sessions even on failure. Workspace and
// Session metadata remain because the public API has no metadata deletion.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.OMA_API_URL?.replace(/\/$/, "");
const key = process.env.OMA_API_KEY;
assert(base && key, "Set OMA_API_URL and OMA_API_KEY");
const id = `e2e_${randomUUID().replaceAll("-", "")}`;
const root = `/v1/workspaces/${id}`;
const sessions = [];
let agent;
let created = false;
let checks = 0;
async function request(method, path, body, expected = 200, authenticated = true) {
  const multipart = body instanceof FormData;
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(30000),
    headers: { ...(authenticated ? { "x-api-key": key } : {}),
      ...(body !== undefined && !multipart ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${path}: HTTP ${response.status}, expected ${expected}`);
  checks++;
  return response;
}
const json = async (...args) => (await request(...args)).json();
const encoded = (path) => path.split("/").map(encodeURIComponent).join("/");
async function fileAccess(path, download = false) {
  const response = await request("GET", `${root}/files/${encoded(path)}${download ? "?download=1" : ""}`);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const access = await response.json();
  assert.equal(access.path, path);
  assert.equal(typeof access.url, "string");
  assert.equal(new URL(access.url).protocol, "https:");
  assert(access.expiresIn >= 60 && access.expiresIn <= 900);
  assert(Date.parse(access.expiresAt) > Date.now());
  assert(Number.isInteger(access.size) && access.size >= 0);
  assert.equal(typeof access.contentType, "string");
  if (access.etag !== undefined) assert.equal(typeof access.etag, "string");
  return access;
}
async function storageRead(access, headers) {
  // This is a separate, unauthenticated HTTP request to the signed URL.
  const response = await fetch(access.url, { headers, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, headers?.Range ? 206 : 200, `Storage read: HTTP ${response.status}`);
  checks++;
  return response;
}
async function read(path, expected) {
  const access = await fileAccess(path);
  const expectedBytes = typeof expected === "string" ? new TextEncoder().encode(expected) : expected;
  assert.equal(access.size, expectedBytes.byteLength);
  assert.deepEqual(new Uint8Array(await (await storageRead(access)).arrayBuffer()), expectedBytes);
}
try {
  const spec = await json("GET", "/openapi.json", undefined, 200, false);
  assert(!Object.keys(spec.paths).some((path) => path.includes("/sessions/{id}/workspace")));
  assert(!spec.paths["/v1/sessions/{id}/messages"]);
  assert(spec.paths["/v1/workspaces/{id}/files"]);
  assert.equal(spec.servers[0].url.replace(/\/$/, ""), base);
  await json("POST", "/v1/workspaces", { id, name: "Workspace signed read E2E" }, 201);
  created = true;
  assert.deepEqual((await json("GET", `${root}/files`)).data, []);
  console.log("PASS contract and unbound Workspace");
  for (const [path, content] of [["files/nested.txt", "nested"], ["中文/100% #?.txt", "你好"], ["empty.txt", ""]]) {
    await json("PUT", `${root}/files/content`, { path, content });
    await read(path, content);
  }
  const binary = new Uint8Array([0, 255, 137, 80, 78, 71]);
  const form = new FormData();
  form.append("path", "media/中文.bin");
  form.append("file", new File([binary], "source.bin", { type: "application/octet-stream" }));
  await json("POST", `${root}/files/upload`, form);
  await read("media/中文.bin", binary);
  const multiple = new FormData();
  multiple.append("destDir", "outputs");
  multiple.append("files", new File(["one"], "a.txt"));
  multiple.append("files", new File(["two"], "b.txt"));
  assert.equal((await json("POST", `${root}/files/upload`, multiple)).data.length, 2);
  assert.deepEqual((await json("GET", `${root}/files?prefix=outputs/`)).data.map((f) => f.path).sort(), ["outputs/a.txt", "outputs/b.txt"]);
  const downloadAccess = await fileAccess("media/中文.bin", true);
  assert.equal(downloadAccess.contentType, "application/octet-stream");
  const download = await storageRead(downloadAccess);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), binary);
  const access = await fileAccess("media/中文.bin");
  const partial = await storageRead(access, { Range: "bytes=1-3" });
  assert.equal(partial.headers.get("content-range"), `bytes 1-3/${binary.byteLength}`);
  assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), binary.slice(1, 4));
  await json("POST", `${root}/files/rename`, { from: "outputs/a.txt", to: "outputs/result.txt" });
  await read("outputs/result.txt", "one");
  await request("GET", `${root}/files/outputs/a.txt`, undefined, 404);
  console.log("PASS real OSS file lifecycle, Unicode, file descriptors, signed downloads and byte ranges");
  await request("GET", `${root}/files`, undefined, 401, false);
  await request("GET", `/v1/workspaces/missing_${id}/files`, undefined, 404);
  await request("PUT", `${root}/files/content`, { path: "../escape", content: "blocked" }, 400);
  await request("PUT", `${root}/files/content`, { path: ".oma-workspace-checks/forbidden", content: "blocked" }, 400);
  agent = (await json("POST", "/v1/agents", { name: "Workspace E2E", runtime: "mock", model: "mock-model", system: "test", sandbox: { enabled: false } }, 201)).id;
  for (let i = 0; i < 2; i++) {
    const session = await json("POST", "/v1/sessions", { agent, workspace_id: id }, 201);
    sessions.push(session.id);
    assert.equal(session.workspaceId, id);
  }
  await json("POST", `/v1/sessions/${sessions[0]}/events`, { events: [{ type: "user.message", data: { content: [{ type: "text", text: "Workspace migration test" }] } }] }, 202);
  await json("PUT", `${root}/files/content`, { path: "during-turn.txt", content: "writable after dispatch" });
  let answered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const history = await json("GET", `/v1/sessions/${sessions[0]}/events`);
    if (history.data.some((event) => event.type === "agent.message")) { answered = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(answered, "Mock Turn must produce a durable agent.message");
  for (const [method, suffix] of [["GET", "files"], ["GET", "files/empty.txt"], ["PUT", "files/content"], ["DELETE", "files/content?path=empty.txt"], ["POST", "files/rename"], ["POST", "files/upload"]]) {
    await request(method, `/v1/sessions/${sessions[0]}/workspace/${suffix}`, undefined, 404);
  }
  await request("POST", `/v1/sessions/${sessions[0]}/messages`, {}, 404);
  for (const session of sessions) await json("DELETE", `/v1/sessions/${session}`);
  sessions.length = 0;
  await read("outputs/result.txt", "one");
  await json("PUT", `${root}/files/content`, { path: "after-termination.txt", content: "persisted" });
  await read("after-termination.txt", "persisted");
  console.log("PASS shared/terminated Sessions, event dispatch, authentication and removed routes");
  if (process.env.OMA_E2E_MODEL) {
    await json("DELETE", `/v1/agents/${agent}`);
    agent = undefined;
    agent = (await json("POST", "/v1/agents", {
      name: "Workspace real Sandbox E2E", runtime: "pi-agent", model: process.env.OMA_E2E_MODEL,
      system: "Use the bash tool to execute the requested command exactly. Work only in /home/user/workspace. Then reply done.",
      sandbox: { enabled: true },
    }, 201)).id;
    const session = await json("POST", "/v1/sessions", { agent, workspace_id: id }, 201);
    sessions.push(session.id);
    const marker = `workspace-e2e-${randomUUID()}`;
    await json("PUT", `${root}/files/content`, { path: "host-input.txt", content: marker });
    await json("POST", `/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", data: { content: [{ type: "text", text:
        "Run this bash command exactly and then reply done:\ncd /home/user/workspace && mkdir -p outputs && sleep 8 && cat host-input.txt > outputs/agent-result.txt" }] } }],
    }, 202);
    let runningWrite = false;
    let realAnswer = false;
    for (let attempt = 0; attempt < 75; attempt++) {
      const state = await json("GET", `/v1/sessions/${session.id}`);
      if (state.status === "running" && !runningWrite) {
        await json("PUT", `${root}/files/content`, { path: "while-running.txt", content: "Host writes remain available" });
        runningWrite = true;
      }
      const history = await json("GET", `/v1/sessions/${session.id}/events`);
      if (history.data.some((event) => event.type === "agent.message") && state.status === "idle") {
        realAnswer = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
    assert(realAnswer, "Real Pi Agent must complete a Turn");
    assert(runningWrite, "A Host file write must succeed while the Session is running");
    const files = (await json("GET", `${root}/files?prefix=outputs/`)).data;
    assert(files.some((file) => file.path === "outputs/agent-result.txt"));
    await read("outputs/agent-result.txt", marker);
    console.log("PASS real Pi Agent: Host input → mounted Sandbox bash → Workspace artifact list/read, including a write during execution");
  }
} finally {
  const failures = [];
  for (const session of sessions) {
    try { await json("DELETE", `/v1/sessions/${session}`); } catch (error) { failures.push(error); }
  }
  if (created) {
    try {
      const files = (await json("GET", `${root}/files`)).data;
      for (const file of files) await json("DELETE", `${root}/files/content?path=${encodeURIComponent(file.path)}`);
      assert.deepEqual((await json("GET", `${root}/files`)).data, []);
    } catch (error) { failures.push(error); }
  }
  if (agent) {
    try { await json("DELETE", `/v1/agents/${agent}`); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "E2E cleanup failed");
  console.log(`Cleanup complete; Workspace metadata retained: ${id}`);
}
console.log(`PASS ${checks} HTTP checks`);
