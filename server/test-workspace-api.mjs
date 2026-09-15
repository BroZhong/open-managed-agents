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
async function read(path, expected) {
  assert.deepEqual(new Uint8Array(await (await request("GET", `${root}/files/${encoded(path)}`)).arrayBuffer()),
    typeof expected === "string" ? new TextEncoder().encode(expected) : expected);
}
try {
  const spec = await json("GET", "/openapi.json", undefined, 200, false);
  assert(!Object.keys(spec.paths).some((path) => path.includes("/sessions/{id}/workspace")));
  assert(!spec.paths["/v1/sessions/{id}/messages"]);
  assert(spec.paths["/v1/workspaces/{id}/files"]);
  assert.equal(spec.servers[0].url.replace(/\/$/, ""), base);
  await json("POST", "/v1/workspaces", { id, name: "Workspace migration E2E" }, 201);
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
  const download = await request("GET", `${root}/files/${encoded("media/中文.bin")}?download=1`);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), binary);
  const signed = await json("GET", `${root}/preview-url?path=${encodeURIComponent("media/中文.bin")}&expiresIn=60`);
  assert.equal(signed.expiresIn, 60);
  const preview = await fetch(signed.url, { signal: AbortSignal.timeout(30000) });
  assert.equal(preview.status, 200);
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), binary);
  checks++;
  await json("POST", `${root}/files/rename`, { from: "outputs/a.txt", to: "outputs/result.txt" });
  await read("outputs/result.txt", "one");
  await request("GET", `${root}/files/outputs/a.txt`, undefined, 404);
  console.log("PASS real OSS file lifecycle, Unicode, binary download and signed preview");
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
  await json("POST", `/v1/sessions/${sessions[0]}/events`, { events: [{ type: "user.message", data: { content: [{ type: "text", text: "Workspace migration test" }] } }] });
  await json("PUT", `${root}/files/content`, { path: "during-turn.txt", content: "writable after dispatch" });
  let answered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const history = await json("GET", `/v1/sessions/${sessions[0]}/events`);
    if (history.data.some((event) => event.type === "agent.message")) { answered = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(answered, "Mock Turn must produce a durable agent.message");
  for (const [method, suffix] of [["GET", "files"], ["GET", "files/empty.txt"], ["PUT", "files/content"], ["DELETE", "files/content?path=empty.txt"], ["POST", "files/rename"], ["POST", "files/upload"], ["GET", "preview-url?path=empty.txt"]]) {
    await request(method, `/v1/sessions/${sessions[0]}/workspace/${suffix}`, undefined, 404);
  }
  await request("POST", `/v1/sessions/${sessions[0]}/messages`, {}, 404);
  for (const session of sessions) await json("DELETE", `/v1/sessions/${session}`);
  sessions.length = 0;
  await read("outputs/result.txt", "one");
  await json("PUT", `${root}/files/content`, { path: "after-termination.txt", content: "persisted" });
  await read("after-termination.txt", "persisted");
  console.log("PASS shared/terminated Sessions, event dispatch, authentication and removed routes");
} finally {
  const failures = [];
  if (created) {
    try {
      const files = (await json("GET", `${root}/files`)).data;
      for (const file of files) await json("DELETE", `${root}/files/content?path=${encodeURIComponent(file.path)}`);
      assert.deepEqual((await json("GET", `${root}/files`)).data, []);
    } catch (error) { failures.push(error); }
  }
  for (const session of sessions) {
    try { await json("DELETE", `/v1/sessions/${session}`); } catch (error) { failures.push(error); }
  }
  if (agent) {
    try { await json("DELETE", `/v1/agents/${agent}`); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "E2E cleanup failed");
  console.log(`Cleanup complete; Workspace metadata retained: ${id}`);
}
console.log(`PASS ${checks} HTTP checks`);
