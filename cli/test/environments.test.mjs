import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, json, run, auth } from "./helpers.mjs";

const SECRET = "s3cret-value-never-printed";
const existing = {
  id: "env_1",
  ownerType: "tenant",
  name: "data",
  description: "",
  baseImage: "oma-base",
  initScript: "true\n",
  status: "ready",
  env: [
    { name: "A", value: "1" },
    { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } },
    { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } },
  ],
};
/** A Host that answers like /v1/environments: secret values never come back. */
const host = () =>
  fixture((req, res, body) => {
    if (req.method === "GET" && req.url.endsWith("/v1/environments"))
      return json(res, { data: [{ ...existing, ownerType: "platform", id: "env_video_production", name: "video-production" }, existing] });
    if (req.method === "GET") return json(res, existing);
    if (req.method === "DELETE") return json(res, { type: "environment_deleted", id: "env_1" });
    const sent = JSON.parse(body.toString());
    const env = (sent.env ?? existing.env).map(({ value, ...x }) => (x.secretRef ? x : { ...x, value }));
    return json(res, { ...existing, ...sent, env, status: "pending" }, req.url.endsWith("/v1/environments") ? 201 : 200);
  });
const sent = (f, index = -1) => JSON.parse(f.requests.at(index).body.toString());

test("environment create sends the script, plain variables and secrets, and never prints a secret", async () => {
  const f = await host();
  const dir = await mkdtemp(join(tmpdir(), "oma-cli-env-"));
  try {
    await writeFile(join(dir, "init.sh"), "pip install requests\n");
    await writeFile(join(dir, "vars.env"), "# comment\nexport B=two\nC=\"quoted value\"\n\nD='x=y'\n");
    await writeFile(join(dir, "secrets.env"), `API_KEY=${SECRET}\n`);
    const r = await run(
      ["environment", "create", "--name", "data", "--base-image", "oma-base", "--init-script", "@" + join(dir, "init.sh"),
        "--env", "A=1", "--env", "URL=http://x/?a=b", "--env-file", join(dir, "vars.env"),
        "--secret", `TOKEN=${SECRET}`, "--secret-file", join(dir, "secrets.env")],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "POST");
    assert.equal(f.requests[0].url, "/prefix/v1/environments");
    assert.deepEqual(sent(f), {
      name: "data", baseImage: "oma-base", initScript: "pip install requests\n",
      env: [
        { name: "A", value: "1" }, { name: "URL", value: "http://x/?a=b" },
        { name: "B", value: "two" }, { name: "C", value: "quoted value" }, { name: "D", value: "x=y" },
        { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" }, value: SECRET },
        { name: "API_KEY", secretRef: { source: "environment", key: "API_KEY" }, value: SECRET },
      ],
    });
    assert.equal(r.data().data.status, "pending");
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SECRET));
    const dry = await run(["environment", "create", "--name", "x", "--base-image", "oma-base", "--secret", `TOKEN=${SECRET}`, "--dry-run"], auth(f));
    assert.equal(dry.code, 10, dry.stderr);
    assert.equal(f.requests.length, 1);
    assert.doesNotMatch(dry.stdout + dry.stderr, new RegExp(SECRET));
    const inline = await run(["environment", "create", "--name", "x", "--base-image", "oma-media", "--init-script", "apt-get install -y jq"], auth(f));
    assert.equal(inline.code, 0, inline.stderr);
    assert.equal(sent(f).initScript, "apt-get install -y jq");
  } finally {
    await f.close();
  }
});

test("environment variable flags are validated before any request", async () => {
  const f = await host();
  try {
    for (const args of [
      ["environment", "create", "--base-image", "oma-base"],
      ["environment", "create", "--name", "x"],
      ["environment", "create", "--name", "x", "--base-image", "ubuntu"],
      ["environment", "create", "--name", "x", "--base-image", "oma-base", "--env", "NOVALUE"],
      ["environment", "create", "--name", "x", "--base-image", "oma-base", "--env", "EMPTY="],
      ["environment", "create", "--name", "x", "--base-image", "oma-base", "--env", "1BAD=x"],
      ["environment", "create", "--name", "x", "--base-image", "oma-base", "--env", "A=1", "--secret", "A=2"],
      ["environment", "create", "--name", "x", "--base-image", "oma-base", "--env", "A=1", "--body", '{"env":[]}'],
      ["environment", "update", "--environment-id", "env_1"],
      ["environment", "update", "--environment-id", "env_1", "--unset", "bad name"],
      ["environment", "update", "--environment-id", "env_1", "--from", "env_2"],
      ["environment", "delete", "--environment-id", "env_1"],
      ["environment", "get", "--environment-id", ""],
    ]) {
      const r = await run(args, auth(f));
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stderr}`);
    }
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("environment update merges variable flags into the current set, keeping secrets without values", async () => {
  const f = await host();
  try {
    const r = await run(
      ["environment", "update", "--environment-id", "env_1", "--env", "B=2", "--unset", "A", "--secret", "TOKEN=rotated", "--secret", "NEW=n"],
      auth(f),
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(f.requests.map((x) => [x.method, x.url]), [["GET", "/prefix/v1/environments/env_1"], ["POST", "/prefix/v1/environments/env_1"]]);
    assert.deepEqual(sent(f), {
      env: [
        { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" }, value: "rotated" },
        { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } },
        { name: "B", value: "2" },
        { name: "NEW", secretRef: { source: "environment", key: "NEW" }, value: "n" },
      ],
    });
    assert.doesNotMatch(r.stdout, /rotated/);
    const script = await run(["environment", "update", "--environment-id", "env_1", "--init-script", "echo v2", "--name", "renamed"], auth(f));
    assert.equal(script.code, 0, script.stderr);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(sent(f), { initScript: "echo v2", name: "renamed" });
  } finally {
    await f.close();
  }
});

test("environment create --from copies, merging variable flags into the source's set", async () => {
  const f = await host();
  try {
    const copy = await run(["environment", "create", "--from", "env_video_production"], auth(f));
    assert.equal(copy.code, 0, copy.stderr);
    assert.deepEqual(sent(f), { from: "env_video_production" });
    const merged = await run(["environment", "create", "--from", "env_1", "--name", "mine", "--env", "A=9"], auth(f));
    assert.equal(merged.code, 0, merged.stderr);
    assert.equal(f.requests.at(-2).url, "/prefix/v1/environments/env_1");
    assert.deepEqual(sent(f), {
      from: "env_1", name: "mine",
      env: [
        { name: "A", value: "9" },
        { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } },
        { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } },
      ],
    });
  } finally {
    await f.close();
  }
});

test("environment list, get and delete", async () => {
  const f = await host();
  try {
    const list = await run(["environment", "list", "--format", "table"], auth(f));
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /^id\tname\townerType\tbaseImage\tstatus\tupdatedAt/m);
    assert.match(list.stdout, /env_video_production\tvideo-production\tplatform/);
    const listed = await run(["environment", "list"], auth(f));
    assert.deepEqual(listed.data().data.map((x) => x.id), ["env_video_production", "env_1"]);
    assert.equal(listed.data().data[0].env, undefined);
    const get = await run(["environment", "get", "--environment-id", "env_1"], auth(f));
    assert.deepEqual(get.data().data.env, existing.env);
    const deleted = await run(["environment", "delete", "--environment-id", "env_1", "--yes"], auth(f));
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(f.requests.at(-1).method, "DELETE");
  } finally {
    await f.close();
  }
});
