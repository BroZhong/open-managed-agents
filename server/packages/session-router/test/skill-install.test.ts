import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createMemoryStores } from "@oma-server/store-memory";
import { packSkillBundle, type Skill, type SkillBundleInputFile, type SkillBundleStore } from "@oma-server/store";
import { DefaultSandboxManager, FakeSandboxClient, isSkillInstallCommand, type SkillInstallBudget } from "@oma-server/sandbox";
import { InProcessEventStreamHub } from "@oma-server/event-log";
import type { Adapter, AdapterInput, SessionEvent } from "@open-managed-agents/adapter-core";
import { journalWriter } from "@open-managed-agents/adapter-mock";
import { SessionRouter, type SessionRouterDeps } from "../src/session-router.js";

/**
 * Skill Install per Turn (ADR-0022, #265): the Router hands the Agent's Skill
 * Set to the Sandbox session, which installs it unless the environment
 * binding records that Set for its Sandbox.
 */

const event = (type: string, data: object = {}) => ({ id: randomUUID(), timestamp: new Date().toISOString(), type, ...data }) as SessionEvent;
const text = (message: string) => event("agent.message", { content: [{ type: "text", text: message }], stopReason: "stop" });
const file = (path: string, body: string | Uint8Array, mode?: number): SkillBundleInputFile =>
  ({ path, body: typeof body === "string" ? new TextEncoder().encode(body) : body, mode });
/** A TrueType header followed by every byte value: survives only a byte-exact path. */
const FONT = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, ...Array.from({ length: 256 }, (_, index) => index)]);
const workspaceMount = { bucket: "agentry", agentName: "agentry-workspace", pvName: "agentry-workspace-oss", credentialProviderName: "agentry-oss-rw" };

/** Each Turn reads every equipped Skill's SKILL.md through the Sandbox (creating it on the first Turn). */
async function readSkills(input: AdapterInput): Promise<Record<string, string>> {
  const bodies: Record<string, string> = {};
  for (const root of input.agent.skillPaths ?? []) bodies[root.slice("/skills/".length)] = await input.toolExecutor!.readFile(`${root}/SKILL.md`);
  if (!input.agent.skillPaths?.length) await input.toolExecutor!.writeFile("warm.txt", "warm");
  return bodies;
}

async function harness(adapter: Adapter, options: { budget?: SkillInstallBudget; sign?: SkillBundleStore["createInstallUrl"] } = {}) {
  const stores = createMemoryStores();
  const sandbox = new FakeSandboxClient();
  const bundleCalls: string[] = [];
  // Every bundle-store call the Runner makes is counted.
  const bundles = new Proxy(stores.skillBundleStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        bundleCalls.push(String(property));
        return property === "createInstallUrl" && options.sign ? options.sign(...args as [string, string, number]) : value.apply(target, args);
      };
    },
  });
  const exec = vi.spyOn(sandbox, "exec");
  const installs = () => exec.mock.calls.filter(([, command]) => isSkillInstallCommand(command)).length;
  const agent = await stores.agentStore.create({ tenantId: "tenant", name: "Writer", model: "test", system: "test", runtime: "pi-agent", sandbox: { enabled: true } });
  const workspace = await stores.workspaceStore.create({ tenantId: "tenant" });
  const parent = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: workspace.id });
  const errors: unknown[] = [];
  /** One Runner: its own Router and Sandbox Manager over the shared stores and Sandbox platform. */
  const makeRouter = (deps: Partial<SessionRouterDeps> = {}) => new SessionRouter({
    ...stores, eventStreamHub: new InProcessEventStreamHub(), resolveAdapter: () => adapter,
    sandboxManager: new DefaultSandboxManager({ sandboxClient: sandbox, skillBundleStore: bundles, skillInstallBudget: options.budget }),
    workspaceMount, pendingClaimRetryMinMs: 10, pendingClaimRetryMaxMs: 20,
    onDrainError: ({ error }) => errors.push(error),
    ...deps,
  });
  const router = makeRouter();
  const bundle = async (files: SkillBundleInputFile[]) => {
    const packed = await packSkillBundle(files);
    await stores.skillBundleStore.put("tenant", packed);
    return { bundleSha256: packed.sha256, bundleSize: packed.size };
  };
  const equipped = async () => (await stores.agentStore.getById(agent.id))!.skills ?? [];
  const equip = async (name: string, files: SkillBundleInputFile[]) => {
    const skill = await stores.skillStore.create({ tenantId: "tenant", name, description: name, ownerType: "agent", ownerId: agent.id, ...await bundle(files) });
    await stores.agentStore.update(agent.id, { skills: [...await equipped(), skill.id] });
    return skill;
  };
  const edit = async (skill: Skill, files: SkillBundleInputFile[]) => { await stores.skillStore.update(skill.id, await bundle(files)); };
  const unequip = async (skill: Skill) => { await stores.agentStore.update(agent.id, { skills: (await equipped()).filter((id) => id !== skill.id) }); };
  const turn = async (sessionId = parent.id, runner = router) => {
    await stores.pendingEventStore.enqueue(sessionId, { type: "user.message", data: { content: [{ type: "text", text: "go" }] }, sessionThreadId: "sthr_primary" });
    await runner.handleNewEvent(sessionId, (await stores.sessionStore.getById(sessionId))!.agent);
  };
  const log = async (id = parent.id) => (await stores.eventLogStore.getEvents(id, { limit: 1000 })).data;
  const installed = () => stores.delegationStore.installedSkillSet(parent.id);
  return { stores, sandbox, agent, parent, router, makeRouter, bundleCalls, installs, equip, edit, unequip, turn, log, installed, errors };
}

/** Reads the Skills each Turn and records what it saw. */
function readingAdapter() {
  const seen: Array<Record<string, string>> = [];
  const adapter: Adapter = { async run(input) {
    seen.push(await readSkills(input));
    await journalWriter(input)(text("done"));
    return "finished";
  } };
  return { adapter, seen };
}

describe("Skill Install per Turn", () => {
  it("installs once; a Turn whose Skill Set did not change makes no bundle-store or Sandbox install call", async () => {
    const { adapter, seen } = readingAdapter();
    const h = await harness(adapter);
    await h.equip("writer", [file("SKILL.md", "v1")]);
    await h.turn();
    expect(seen.at(-1)).toEqual({ writer: "v1" });
    expect(h.installs()).toBe(1);
    const calls = h.bundleCalls.length;
    await h.turn();
    await h.turn();
    expect(seen.at(-1)).toEqual({ writer: "v1" });
    expect(h.installs()).toBe(1);
    expect(h.bundleCalls).toHaveLength(calls);
    expect(h.sandbox.created).toHaveLength(1);
    expect(await h.installed()).toMatchObject({ sandboxId: h.sandbox.created[0] });
    expect(h.errors).toEqual([]);
  });

  it("makes no install call for a Child Turn sharing the Sandbox its parent installed", async () => {
    const counts: Array<{ installs: number; bundleCalls: number }> = [];
    let childSaw: Record<string, string> = {};
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        counts.push({ installs: h.installs(), bundleCalls: h.bundleCalls.length });
        childSaw = await readSkills(input);
        await write(text("child done"));
        return "finished";
      }
      await readSkills(input);
      counts.push({ installs: h.installs(), bundleCalls: h.bundleCalls.length });
      await write(event("agent.tool_use", { toolUseId: "child", name: "Agent", input: { prompt: "child" } }));
      const output = await input.subagents!.delegate({ prompt: "child", runInBackground: false }, { toolUseId: "child" });
      await write(event("agent.tool_result", { toolUseId: "child", content: [{ type: "text", text: JSON.stringify(output) }], isError: false }));
      return "finished";
    } });
    await h.equip("writer", [file("SKILL.md", "shared")]);
    await h.turn();
    expect(childSaw).toEqual({ writer: "shared" });
    const [afterParent, childStart] = counts;
    expect(afterParent.installs).toBe(1);
    expect(childStart).toEqual(afterParent);
    expect(h.installs()).toBe(1);
    expect(h.bundleCalls).toHaveLength(afterParent.bundleCalls);
    expect(h.sandbox.created).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });

  it("installs the next version after a content change, equip, unequip and rename, and reinstalls in a rebuilt Sandbox", async () => {
    const { adapter, seen } = readingAdapter();
    const h = await harness(adapter);
    const writer = await h.equip("writer", [file("SKILL.md", "v1")]);
    await h.turn();
    const steps: Array<[string, () => Promise<unknown>, Record<string, string>]> = [
      ["content change", () => h.edit(writer, [file("SKILL.md", "v2")]), { writer: "v2" }],
      ["equip", () => h.equip("editor", [file("SKILL.md", "edits")]), { writer: "v2", editor: "edits" }],
      ["unequip", () => h.unequip(writer), { editor: "edits" }],
      ["rename", async () => { const [id] = (await h.stores.agentStore.getById(h.agent.id))!.skills!; await h.stores.skillStore.update(id, { name: "reviser" }); }, { reviser: "edits" }],
    ];
    for (const [change, apply, expected] of steps) {
      const before = h.installs();
      await apply();
      await h.turn();
      expect(seen.at(-1), change).toEqual(expected);
      expect(h.installs(), change).toBe(before + 1);
    }
    const id = h.sandbox.created[0];
    expect(h.sandbox.filesOf(id).has("/skills/writer/SKILL.md")).toBe(false);
    expect(h.sandbox.filesOf(id).has("/skills/editor/SKILL.md")).toBe(false);
    // The record names the Sandbox it went into: a rebuilt one installs again.
    h.sandbox.reclaim(id);
    const before = h.installs();
    await h.turn();
    expect(h.sandbox.created).toHaveLength(2);
    expect(seen.at(-1)).toEqual({ reviser: "edits" });
    expect(h.installs()).toBe(before + 1);
    expect(await h.installed()).toMatchObject({ sandboxId: h.sandbox.created[1] });
    expect(h.errors).toEqual([]);
  });

  it("installs byte-exact files with the read-only permission convention", async () => {
    const { adapter } = readingAdapter();
    const h = await harness(adapter);
    await h.equip("subtitles", [file("SKILL.md", "fonts"), file("assets/fonts/LiberationSans-Regular.ttf", FONT), file("scripts/render.sh", "#!/bin/sh\n", 0o755)]);
    await h.turn();
    const files = h.sandbox.filesOf(h.sandbox.created[0]);
    expect(files.get("/skills/subtitles/assets/fonts/LiberationSans-Regular.ttf")).toMatchObject({ content: FONT, mode: 0o444 });
    expect(files.get("/skills/subtitles/scripts/render.sh")?.mode).toBe(0o555);
    expect(files.get("/skills/subtitles/SKILL.md")?.mode).toBe(0o444);
  });

  it("ends the Turn with skills_install_failed naming the stage and reason, without writing the binding or switching /skills", async () => {
    const { adapter, seen } = readingAdapter();
    const h = await harness(adapter);
    const writer = await h.equip("writer", [file("SKILL.md", "v1")]);
    await h.turn();
    const recorded = await h.installed();
    await h.edit(writer, [file("SKILL.md", "v2")]);
    h.sandbox.skillInstallFault = (stage) => { if (stage === "download") throw new Error("HTTP 503, curl exit 0"); };
    await h.turn();
    const failures = (await h.log()).filter((stored) => stored.type === "session.error");
    expect(failures.map((stored) => stored.data)).toEqual([{ turnId: expect.any(String),
      error: { code: "skills_install_failed", message: "Skill Install failed at download: HTTP 503, curl exit 0" } }]);
    expect((await h.stores.sessionStore.getById(h.parent.id))?.status).toBe("idle");
    expect(seen).toHaveLength(1);
    expect(await h.installed()).toEqual(recorded);
    expect(await h.sandbox.readFile(h.sandbox.created[0], "/skills/writer/SKILL.md")).toBe("v1");
    // The next Turn installs once the cause is gone.
    h.sandbox.skillInstallFault = undefined;
    await h.turn();
    expect(seen.at(-1)).toEqual({ writer: "v2" });
    expect(h.errors).toEqual([]);
  });

  it("ends an install over its budget with skills_install_failed instead of staying running", async () => {
    const { adapter } = readingAdapter();
    const h = await harness(adapter, { budget: { minBudgetMs: 50 } });
    const writer = await h.equip("writer", [file("SKILL.md", "v1")]);
    await h.turn();
    await h.edit(writer, [file("SKILL.md", "v2")]);
    h.sandbox.skillInstallFault = (stage, signal) => stage === "download"
      ? new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()))
      : undefined;
    await h.turn();
    const failure = (await h.log()).find((stored) => stored.type === "session.error");
    expect(failure?.data).toMatchObject({ error: { code: "skills_install_failed", message: "Skill Install failed at download: exceeded its budget of 1 s" } });
    expect((await h.stores.sessionStore.getById(h.parent.id))?.status).toBe("idle");
    expect(await h.sandbox.readFile(h.sandbox.created[0], "/skills/writer/SKILL.md")).toBe("v1");
  });

  it("keeps signed URLs out of exec argv, logs, errors and events", async () => {
    const SIGNED = "https://agentry.oss-cn-shanghai-internal.aliyuncs.com/__oma/skills/tenant/x.zip?OSSAccessKeyId=LTAI-SECRET&Expires=1&Signature=SIGNATURE-SECRET";
    const { adapter } = readingAdapter();
    const h = await harness(adapter, { sign: async () => SIGNED });
    const logged = ["log", "info", "warn", "error", "debug"].map((level) => vi.spyOn(console, level as "log").mockImplementation(() => {}));
    await h.equip("writer", [file("SKILL.md", "v1")]);
    // The fake cannot reach OSS, so every install fails. A cold Sandbox
    // installs on its first tool call, whose error the Adapter receives; once
    // the Sandbox exists, the next Turn's preparation fails the Turn.
    await h.turn();
    await h.turn();
    const execs = vi.mocked(h.sandbox.exec).mock.calls;
    const installCall = execs.find(([, command]) => isSkillInstallCommand(command))!;
    expect(installCall[2]?.stdin).toContain(SIGNED);
    expect(JSON.stringify(execs.map(([id, command, options]) => [id, command, { ...options, stdin: undefined }]))).not.toMatch(/SECRET|aliyuncs/);
    const events = await h.log();
    expect(events.filter((stored) => stored.type === "session.error").map((stored) => (stored.data as { error: { code: string } }).error.code))
      .toEqual(["adapter_error", "skills_install_failed"]);
    const everything = JSON.stringify(events) + JSON.stringify(h.errors) + JSON.stringify(logged.map((spy) => spy.mock.calls));
    expect(everything).toContain("Skill Install failed at download: HTTP 000, curl exit 6");
    expect(everything).not.toMatch(/SECRET|aliyuncs|OSSAccessKeyId|Signature=/);
    for (const spy of logged) spy.mockRestore();
  });

  it("lets two Runners install the same version into the shared Sandbox at once", async () => {
    const childReads: Array<Record<string, string>> = [];
    let parentTurns = 0;
    const h = await harness({ async run(input) {
      const write = journalWriter(input);
      if (input.execution?.isChild) {
        childReads.push(await readSkills(input));
        await write(text("child done"));
        return "finished";
      }
      if (++parentTurns > 1) { await write(text("noted")); return "finished"; }
      await readSkills(input);
      for (const id of ["first", "second"]) {
        await write(event("agent.tool_use", { toolUseId: id, name: "Agent", input: { prompt: id } }));
        const accepted = await input.subagents!.delegate({ prompt: id, runInBackground: true }, { toolUseId: id });
        await write(event("agent.tool_result", { toolUseId: id, content: [{ type: "text", text: JSON.stringify(accepted) }], isError: false }));
      }
      return "finished";
    } });
    // Children wait in their queues until each is run on its own Runner below.
    const runnerA = h.makeRouter({ wakeSession: () => {} });
    const runnerB = h.makeRouter({ wakeSession: () => {} });
    const writer = await h.equip("writer", [file("SKILL.md", "v1"), file("font.ttf", FONT)]);
    await h.turn(h.parent.id, runnerA);
    await h.edit(writer, [file("SKILL.md", "v2"), file("font.ttf", FONT)]);
    const children = await h.stores.delegationStore.list("tenant", h.parent.id);
    expect(children).toHaveLength(2);
    const before = h.installs();
    await Promise.all(children.map(async (execution, index) => {
      const child = (await h.stores.sessionStore.getById(execution.childId))!;
      await (index === 0 ? runnerA : runnerB).handleNewEvent(child.id, child.agent);
    }));
    expect(childReads).toEqual([{ writer: "v2" }, { writer: "v2" }]);
    expect(h.installs()).toBe(before + 2);
    const id = h.sandbox.created[0];
    expect(await h.sandbox.readFileBytes(id, "/skills/writer/font.ttf")).toEqual(FONT);
    expect(await h.installed()).toMatchObject({ sandboxId: id });
    expect(h.sandbox.created).toHaveLength(1);
    expect(h.errors).toEqual([]);
  });
});
