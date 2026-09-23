import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run } from "./helpers.mjs";
test("CLI waits through real Host ingress/completion overlap, retaining final Turn text blocks", async () => {
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
  } finally {
    child.kill("SIGTERM");
  }
});
