// Opt-in: creates and removes only newly named test resources in the configured Tenant.
// Credentials come exclusively from the environment; reports contain no responses or secrets.
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { run } from "../test/helpers.mjs";
if (!process.env.OMA_BASE_URL || !process.env.OMA_API_KEY)
  throw new Error("Set OMA_BASE_URL and OMA_API_KEY explicitly");
const env = {
  OMA_BASE_URL: process.env.OMA_BASE_URL,
  OMA_API_KEY: process.env.OMA_API_KEY,
};
const dir = await realpath(await mkdtemp(join(tmpdir(), "oma-live-")));
const prefix = "oma-cli-check-" + Date.now();
const root = new URL("..", import.meta.url).pathname;
let agent, library, fork, workspace, session, agentFork;
let drained = false;
const checks = [];
const cleanup = [];
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", dir], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--prefix",
    dir,
    join(dir, packed[0].filename),
  ],
  { stdio: "pipe" },
);
const bin = join(dir, "node_modules/oma-cli-local/dist/main.js");
async function cli(args, expected = 0) {
  const r = await run(args, { env, bin, cwd: dir });
  assert.equal(r.code, expected, `${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r;
}
async function data(args) {
  return (await cli(args)).data().data;
}
try {
  const available = await data(["agent", "list", "--all"]);
  const model =
    process.env.OMA_TEST_MODEL ??
    available.find((a) => a.runtime === "pi-agent")?.model;
  if (!model) throw new Error("No Pi model available; set OMA_TEST_MODEL");
  agent = await data([
    "agent",
    "create",
    "--name",
    prefix,
    "--runtime",
    "pi-agent",
    "--model",
    model,
    "--system",
    "You are an integration test Agent. Operate only on files in your own Workspace. Follow exact test instructions; do not access external services.",
  ]);
  checks.push("create isolated Agent");
  await data([
    "agent",
    "file",
    "write",
    "--agent-id",
    agent.id,
    "--name",
    "SOUL",
    "--content",
    "Only operate within this test Workspace.",
  ]);
  await data(["agent", "file", "list", "--agent-id", agent.id]);
  assert.match(
    (
      await data([
        "agent",
        "file",
        "read",
        "--agent-id",
        agent.id,
        "--name",
        "SOUL",
      ])
    ).content,
    /test Workspace/,
  );
  checks.push("Agent Files");
  const skillDir = join(dir, prefix);
  await mkdir(skillDir);
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${prefix}\ndescription: CLI acceptance fixture\n---\n# Test\nUse only in this test Workspace.\n`,
  );
  library = (await data(["skill", "upload", "--directory", skillDir]))[0];
  fork = await data([
    "agent",
    "skill",
    "equip",
    "--agent-id",
    agent.id,
    "--skill-id",
    library.id,
  ]);
  assert.notEqual(fork.id, library.id);
  await data([
    "skill",
    "file",
    "write",
    "--skill-id",
    fork.id,
    "--path",
    "private.txt",
    "--content",
    "Private copy\n",
  ]);
  assert.ok(
    !(await data(["skill", "file", "list", "--skill-id", library.id])).includes(
      "private.txt",
    ),
  );
  await data([
    "skill",
    "download",
    "--skill-id",
    fork.id,
    "--output",
    join(dir, "skill-export"),
  ]);
  assert.equal(
    await readFile(join(dir, "skill-export/private.txt"), "utf8"),
    "Private copy\n",
  );
  checks.push("Skill Library → independent fork → private edit → export");
  agentFork = await data([
    "agent",
    "fork",
    "--agent-id",
    agent.id,
    "--name",
    prefix + "-fork",
  ]);
  assert.notEqual(agentFork.id, agent.id);
  checks.push("Agent fork");
  workspace = await data(["workspace", "create", "--name", prefix]);
  const input = join(dir, "input.txt");
  await writeFile(input, "CLI input bytes\n");
  await data([
    "workspace",
    "file",
    "upload",
    "--workspace-id",
    workspace.id,
    "--path",
    "input.txt",
    "--file",
    input,
  ]);
  const binary = join(dir, "binary.bin");
  await writeFile(binary, Buffer.from([0, 255, 128, 1]));
  await data([
    "workspace",
    "file",
    "upload",
    "--workspace-id",
    workspace.id,
    "--path",
    "binary.bin",
    "--file",
    binary,
  ]);
  await data([
    "workspace",
    "file",
    "download",
    "--workspace-id",
    workspace.id,
    "--path",
    "binary.bin",
    "--output",
    join(dir, "binary-copy.bin"),
  ]);
  assert.deepEqual(
    await readFile(join(dir, "binary-copy.bin")),
    Buffer.from([0, 255, 128, 1]),
  );
  checks.push("Workspace text/binary transfers");
  session = await data([
    "session",
    "create",
    "--agent-id",
    agent.id,
    "--workspace-id",
    workspace.id,
  ]);
  await data([
    "session",
    "send",
    "--session-id",
    session.id,
    "--prompt",
    "Read input.txt. Write first.txt with exactly FIRST followed by newline. Then reply FIRST_DONE.",
  ]);
  const stream = await cli([
    "session",
    "send",
    "--session-id",
    session.id,
    "--prompt",
    "Write output.txt containing exactly OMA_CLI_ACCEPTED followed by a newline. Then reply SECOND_DONE.",
    "--wait",
    "--stream",
    "--wait-timeout",
    "3m",
  ]);
  const rows = stream.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(rows.filter((r) => r.kind === "result").length, 1);
  assert.equal(rows.at(-1).data.status, "idle");
  drained = true;
  assert.ok(
    rows
      .filter((r) => r.kind === "event")
      .every((r) => Number.isSafeInteger(r.seq)),
  );
  const result = await data([
    "session",
    "wait",
    "--session-id",
    session.id,
    "--wait-timeout",
    "10s",
  ]);
  assert.match(JSON.stringify(result.messages), /SECOND_DONE/);
  checks.push(
    "two accepted inputs → stream → queue drained → last Turn replay",
  );
  const events = await data([
    "session",
    "events",
    "list",
    "--session-id",
    session.id,
    "--all",
  ]);
  assert.ok(
    events.filter((e) => e.type === "session.turn_completed").length >= 2,
  );
  const lastIdle = events.findLast((e) => e.type === "session.status_idle");
  assert.ok(
    lastIdle.seq >
      events.findLast((e) => e.type === "session.turn_completed").seq,
  );
  await data([
    "session",
    "events",
    "read",
    "--session-id",
    session.id,
    "--seq",
    String(events[0].seq),
  ]);
  const follow = await cli([
    "session",
    "events",
    "follow",
    "--session-id",
    session.id,
    "--duration",
    "500ms",
  ]);
  assert.ok(
    follow.stdout
      .trim()
      .split("\n")
      .map(JSON.parse)
      .every((r) => r.kind === "event"),
  );
  checks.push("event list/detail/follow");
  await data(["workspace", "file", "list", "--workspace-id", workspace.id]);
  await data([
    "workspace",
    "file",
    "download",
    "--workspace-id",
    workspace.id,
    "--path",
    "output.txt",
    "--output",
    join(dir, "output.txt"),
  ]);
  assert.equal(
    await readFile(join(dir, "output.txt"), "utf8"),
    "OMA_CLI_ACCEPTED\n",
  );
  checks.push("actual Agent artifact bytes");
  console.log(
    JSON.stringify({
      phase: "verification",
      baseUrl: env.OMA_BASE_URL,
      node: process.version,
      prefix,
      agentId: agent.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      skillId: library.id,
      checks,
    }),
  );
} finally {
  // Never tear down resources underneath an execution whose outcome is unknown.
  if (!session || drained) {
    const remove = async (args) => {
      try {
        await cli(args);
        cleanup.push(args.slice(0, 3).join(" "));
      } catch (e) {
        cleanup.push("FAILED " + args.slice(0, 3).join(" "));
      }
    };
    if (session)
      await remove(["session", "delete", "--session-id", session.id, "--yes"]);
    if (workspace) {
      try {
        for (const f of await data([
          "workspace",
          "file",
          "list",
          "--workspace-id",
          workspace.id,
        ]))
          await remove([
            "workspace",
            "file",
            "delete",
            "--workspace-id",
            workspace.id,
            "--path",
            f.path,
            "--yes",
          ]);
      } catch {}
      await remove([
        "workspace",
        "delete",
        "--workspace-id",
        workspace.id,
        "--yes",
      ]);
    }
    for (const a of [agentFork, agent].filter(Boolean)) {
      try {
        for (const s of await data([
          "agent",
          "skill",
          "list",
          "--agent-id",
          a.id,
        ]))
          await remove([
            "agent",
            "skill",
            "unequip",
            "--agent-id",
            a.id,
            "--skill-id",
            s.id,
            "--yes",
          ]);
        for (const f of await data([
          "agent",
          "file",
          "list",
          "--agent-id",
          a.id,
        ]))
          await remove([
            "agent",
            "file",
            "delete",
            "--agent-id",
            a.id,
            "--name",
            f.filename,
            "--yes",
          ]);
      } catch {}
      await remove(["agent", "delete", "--agent-id", a.id, "--yes"]);
    }
    if (library)
      await remove(["skill", "delete", "--skill-id", library.id, "--yes"]);
  } else
    cleanup.push(
      `retained unknown execution resources: Agent ${agent?.id}, Session ${session?.id}, Workspace ${workspace?.id}, Skill ${library?.id}, Agent Fork ${agentFork?.id}`,
    );
  console.log(JSON.stringify({ phase: "cleanup", cleanup, checks }));
  await rm(dir, { recursive: true, force: true });
}
