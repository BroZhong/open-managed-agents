import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./helpers.mjs";
async function withHost(check) {
  const child = spawn(
    new URL("../../server/packages/api/node_modules/.bin/tsx", import.meta.url)
      .pathname,
    [new URL("./host-fixture.ts", import.meta.url).pathname],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (x) => (errors += x));
  try {
    const config = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", () => reject(new Error(errors)));
      const lines = createInterface({ input: child.stdout });
      lines.once("line", (l) => {
        try {
          resolve(JSON.parse(l));
        } catch {
          reject(new Error(l + errors));
        }
      });
    });
    const opts = {
      env: { OMA_BASE_URL: config.url, OMA_API_KEY: "local-test" },
    };
    await check(config, opts);
  } finally {
    child.kill("SIGTERM");
  }
}
test("CLI waits through real Host ingress/completion overlap, retaining final Turn text blocks", async () =>
  withHost(async (config, opts) => {
    const create = await run(
      ["session", "create", "--agent-id", config.agentId],
      opts,
    );
    assert.equal(create.code, 0, create.stderr);
    const id = create.data().data.id;
    const r = await run(
      [
        "session",
        "send",
        "--session-id",
        id,
        "--prompt",
        "A",
        "--wait",
        "--stream",
        "--wait-timeout",
        "5s",
      ],
      opts,
    );
    assert.equal(r.code, 0, r.stderr);
    const rows = r.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(
      rows.filter((e) => e.type === "session.turn_completed").length,
      2,
    );
    assert.equal(
      rows.filter((e) => e.type === "session.status_idle").length,
      1,
    );
    assert.equal(rows.at(-1).kind, "result");
    assert.deepEqual(rows.at(-1).data.messages[0].content, [
      { type: "text", text: "reply B" },
      { type: "text", text: "second block" },
    ]);
  }));

test("real Host resource workflows preserve private forks and Workspace deletion semantics", async () =>
  withHost(async (config, opts) => {
    const { mkdtemp, realpath, mkdir, writeFile, rm } = await import(
      "node:fs/promises"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-host-crud-")));
    const call = async (args, code = 0) => {
      const r = await run(args, opts);
      assert.equal(r.code, code, r.stderr);
      return code === 0 ? r.data().data : r;
    };
    try {
      const a = await call([
        "agent",
        "create",
        "--name",
        "Private",
        "--runtime",
        "mock",
        "--model",
        "test",
        "--system",
        "original",
      ]);
      const updated = await call([
        "agent",
        "update",
        "--agent-id",
        a.id,
        "--description",
        "changed",
      ]);
      assert.equal(updated.system, "original");
      for (const name of ["IDENTITY", "SOUL", "USER", "MEMORY"]) {
        await call([
          "agent",
          "file",
          "write",
          "--agent-id",
          a.id,
          "--name",
          name,
          "--content",
          "",
        ]);
        assert.equal(
          (
            await call([
              "agent",
              "file",
              "read",
              "--agent-id",
              a.id,
              "--name",
              name,
            ])
          ).content,
          "",
        );
      }
      const w = await call([
        "workspace",
        "create",
        "--workspace-id",
        "custom",
        "--name",
        "first",
      ]);
      assert.equal(
        (
          await call([
            "workspace",
            "create",
            "--workspace-id",
            "custom",
            "--name",
            "ignored",
          ])
        ).name,
        "first",
      );
      await call(["workspace", "rename", "--workspace-id", w.id, "--name", ""]);
      assert.equal(
        (await call(["workspace", "get", "--workspace-id", w.id])).name,
        "",
      );
      const skillDir = join(dir, "fixture-skill");
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        "# Title\nFallback description\n",
      );
      await writeFile(join(skillDir, "old.txt"), "original");
      const lib = (await call(["skill", "upload", "--directory", skillDir]))[0];
      const fork = await call([
        "agent",
        "skill",
        "equip",
        "--agent-id",
        a.id,
        "--skill-id",
        lib.id,
      ]);
      assert.notEqual(lib.id, fork.id);
      await call([
        "skill",
        "file",
        "write",
        "--skill-id",
        fork.id,
        "--path",
        "private.txt",
        "--content",
        "mine",
      ]);
      assert.equal(
        (
          await call([
            "agent",
            "skill",
            "equip",
            "--agent-id",
            a.id,
            "--skill-id",
            lib.id,
          ])
        ).id,
        fork.id,
      );
      assert.equal(
        (
          await call([
            "skill",
            "file",
            "read",
            "--skill-id",
            fork.id,
            "--path",
            "private.txt",
          ])
        ).content,
        "mine",
      );
      await call(["skill", "delete", "--skill-id", fork.id, "--yes"], 2);
      await rm(join(skillDir, "old.txt"));
      await writeFile(join(skillDir, "new.txt"), "new");
      await call(["skill", "upload", "--directory", skillDir], 5);
      assert.equal(
        (
          await call([
            "skill",
            "upload",
            "--directory",
            skillDir,
            "--overwrite",
          ])
        )[0].id,
        lib.id,
      );
      assert.ok(
        !(await call(["skill", "file", "list", "--skill-id", lib.id])).includes(
          "old.txt",
        ),
      );
      assert.ok(
        (await call(["skill", "file", "list", "--skill-id", fork.id])).includes(
          "old.txt",
        ),
      );
      const af = await call([
        "agent",
        "fork",
        "--agent-id",
        a.id,
        "--name",
        "independent",
      ]);
      const copied = await call([
        "agent",
        "skill",
        "list",
        "--agent-id",
        af.id,
      ]);
      assert.notEqual(copied[0].id, fork.id);
      assert.equal(
        (
          await call([
            "skill",
            "file",
            "read",
            "--skill-id",
            copied[0].id,
            "--path",
            "private.txt",
          ])
        ).content,
        "mine",
      );
      await call([
        "skill",
        "file",
        "rename",
        "--skill-id",
        fork.id,
        "--path",
        "private.txt",
        "--to",
        "renamed.txt",
      ]);
      await call([
        "skill",
        "file",
        "delete",
        "--skill-id",
        fork.id,
        "--path",
        "missing.txt",
        "--yes",
      ]);
      await call([
        "agent",
        "skill",
        "equip",
        "--agent-id",
        a.id,
        "--skill-id",
        lib.id,
        "--overwrite",
      ]);
      await call(
        [
          "skill",
          "file",
          "read",
          "--skill-id",
          fork.id,
          "--path",
          "renamed.txt",
        ],
        3,
      );
      assert.ok(
        (await call(["skill", "file", "list", "--skill-id", fork.id])).includes(
          "new.txt",
        ),
      );
      await call(["skill", "delete", "--skill-id", lib.id, "--yes"]);
      assert.ok(
        (await call(["skill", "get", "--skill-id", fork.id])).files.includes(
          "new.txt",
        ),
      );
      await call([
        "agent",
        "skill",
        "unequip",
        "--agent-id",
        a.id,
        "--skill-id",
        fork.id,
        "--yes",
      ]);
      assert.deepEqual(
        await call(["agent", "skill", "list", "--agent-id", a.id]),
        [],
      );
      await call(["workspace", "delete", "--workspace-id", w.id, "--yes"]);
      await call(["workspace", "delete", "--workspace-id", w.id, "--yes"]);
      await call(["workspace", "create", "--workspace-id", w.id], 5);
      await call(["workspace", "file", "list", "--workspace-id", w.id], 3);
      assert.deepEqual(await call(["workspace", "list"]), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
