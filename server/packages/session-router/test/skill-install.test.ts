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
    // The fake cannot reach OSS, so every install fails: a cold Sandbox's on
    // its first tool call, an existing one's beside the next Turn. Either
    // fails the Turn's first tool call and ends the Turn.
    await h.turn();
    await h.turn();
    const execs = vi.mocked(h.sandbox.exec).mock.calls;
    const installCall = execs.find(([, command]) => isSkillInstallCommand(command))!;
    expect(installCall[2]?.stdin).toContain(SIGNED);
    expect(JSON.stringify(execs.map(([id, command, options]) => [id, command, { ...options, stdin: undefined }]))).not.toMatch(/SECRET|aliyuncs/);
    const events = await h.log();
    expect(events.filter((stored) => stored.type === "session.error").map((stored) => (stored.data as { error: { code: string } }).error.code))
      .toEqual(["skills_install_failed", "skills_install_failed"]);
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

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout = 4000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error("Timed out"); await sleep(5); }
}
type Writer = ReturnType<typeof journalWriter>;
type Script = (input: AdapterInput, write: Writer) => Promise<void>;
const SKILL = "/skills/writer/SKILL.md";

/**
 * Like Pi: records the calls of one model response, runs them in parallel
 * through the executor, records their results, and makes no next request
 * once the Turn is aborted.
 */
async function toolRound(input: AdapterInput, write: Writer, ids: string[]): Promise<void> {
  for (const id of ids) await write(event("agent.tool_use", { toolUseId: id, name: "read", input: { path: SKILL } }));
  const results = await Promise.all(ids.map(async (id) => {
    try { return { id, text: await input.toolExecutor!.readFile(SKILL), isError: false }; }
    catch (error) { return { id, text: (error as Error).message, isError: true }; }
  }));
  for (const { id, text: body, isError } of results) {
    await write(event("agent.tool_result", { toolUseId: id, content: [{ type: "text", text: body }], isError }));
  }
}

/** A Runner whose Adapter runs the current script; a warm-up Turn installs v1 into a new Sandbox. */
async function beside(options: { warm?: boolean } = {}) {
  let script: Script = async (input, write) => { await readSkills(input); await write(text("ready")); };
  const h = await harness({ async run(input) {
    await script(input, journalWriter(input));
    return "finished";
  } });
  const writer = await h.equip("writer", [file("SKILL.md", "v1")]);
  if (options.warm !== false) await h.turn();
  const businessReads = vi.spyOn(h.sandbox, "readFile");
  const allSpans = async () => (await h.log()).filter((stored) => stored.type.startsWith("span.skills_install_"));
  // The spans written after the warm-up Turn.
  const warmSpans = (await allSpans()).length;
  const spans = async () => (await allSpans()).slice(warmSpans);
  const types = async () => (await h.log()).map((stored) => stored.type);
  return { ...h, writer, businessReads, spans, types, run: (next: Script) => { script = next; } };
}

describe("Skill Install beside inference (#268)", () => {
  it("starts the first model request while the install runs; the first tool call runs only once it succeeded", async () => {
    const h = await beside();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    const download = deferred();
    h.sandbox.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    const order: string[] = [];
    let atRequest: string[] = [];
    h.run(async (input, write) => {
      await input.journal.flush();
      atRequest = (await h.spans()).map((stored) => stored.type);
      order.push("model request");
      const read = input.toolExecutor!.readFile(SKILL).then((body) => { order.push(`tool ran: ${body}`); return body; });
      await sleep(30);
      order.push(`install released after ${h.businessReads.mock.calls.length} business reads`);
      download.resolve();
      await read;
      await write(text("done"));
    });
    await h.turn();
    expect(atRequest).toEqual(["span.skills_install_start"]);
    expect(order).toEqual(["model request", "install released after 0 business reads", "tool ran: v2"]);
    expect(h.errors).toEqual([]);
  });

  it("writes a start and an end span with every field for an install that ran, and none for a skipped one", async () => {
    const h = await beside({ warm: false });
    // A cold Sandbox installs on its first tool call.
    await h.turn();
    await h.turn();
    await h.edit(h.writer, [file("SKILL.md", "v2"), file("font.ttf", FONT)]);
    await h.turn();
    const log = await h.log();
    const spans = log.filter((stored) => stored.type.startsWith("span.skills_install_"));
    const turns = log.filter((stored) => stored.type === "session.turn_completed").map((stored) => (stored.data as { turnId: string }).turnId);
    expect(turns).toHaveLength(3);
    expect(spans.map((stored) => [stored.type, (stored.data as { turnId: string }).turnId])).toEqual([
      ["span.skills_install_start", turns[0]], ["span.skills_install_end", turns[0]],
      ["span.skills_install_start", turns[2]], ["span.skills_install_end", turns[2]],
    ]);
    const [, , start, end] = spans.map((stored) => stored.data);
    const setHash = (await h.installed())!.setHash;
    expect(start).toEqual({ turnId: turns[2], installId: expect.any(String), setHash, skills: 1 });
    expect(end).toEqual({ turnId: turns[2], installId: (start as { installId: string }).installId, setHash, skills: 1,
      outcome: "installed", durationMs: expect.any(Number), downloaded: 1, bytes: expect.any(Number) });
    expect((end as { bytes: number }).bytes).toBeGreaterThan(FONT.byteLength);
    // Inside its Turn: after the running status, before the Turn's end.
    const third = log.filter((stored) => (stored.data as { turnId?: string }).turnId === turns[2] || stored.type === "session.status_running");
    expect(third.map((stored) => stored.type).filter((type) => type.startsWith("span.skills") || type.startsWith("session.")).slice(-4))
      .toEqual(["session.status_running", "span.skills_install_start", "span.skills_install_end", "session.turn_completed"]);
    expect(h.errors).toEqual([]);
  });

  it("ends the tool call that waited and its Turn with skills_install_failed; no further model request is made", async () => {
    const h = await beside();
    const recorded = await h.installed();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    h.sandbox.skillInstallFault = (stage) => { if (stage === "download") throw new Error("HTTP 503, curl exit 0"); };
    let continued = false;
    h.run(async (input, write) => {
      await toolRound(input, write, ["call_1", "call_2"]);
      if (input.signal?.aborted) return;
      continued = true;
      await write(text("worked around it"));
    });
    await h.turn();
    const log = await h.log();
    const message = "Skill Install failed at download: HTTP 503, curl exit 0";
    const results = log.filter((stored) => stored.type === "agent.tool_result").slice(-2).map((stored) => stored.data);
    expect(results).toEqual([1, 2].map((n) => expect.objectContaining({ toolUseId: `call_${n}`, isError: true,
      content: [{ type: "text", text: `skills_install_failed: ${message}. The tool was not executed.` }] })));
    expect(log.filter((stored) => stored.type === "session.error").map((stored) => stored.data))
      .toEqual([{ turnId: expect.any(String), error: { code: "skills_install_failed", message } }]);
    expect(continued).toBe(false);
    expect(h.businessReads).not.toHaveBeenCalled();
    expect((await h.spans()).at(-1)?.data).toMatchObject({ outcome: "failed", stage: "download", reason: "HTTP 503, curl exit 0", durationMs: expect.any(Number) });
    expect((await h.types()).slice(-4)).toEqual(["agent.tool_result", "session.error", "session.turn_completed", "session.status_idle"]);
    expect((await h.stores.sessionStore.getById(h.parent.id))?.status).toBe("idle");
    expect(await h.installed()).toEqual(recorded);
    expect(h.errors).toEqual([]);
  });

  it("ends a cold Sandbox's Turn with skills_install_failed when its install on the first tool call fails", async () => {
    const h = await beside({ warm: false });
    h.sandbox.skillInstallFault = (stage) => { if (stage === "download") throw new Error("HTTP 403, curl exit 0"); };
    let continued = false;
    h.run(async (input, write) => {
      await toolRound(input, write, ["call_1"]);
      if (input.signal?.aborted) return;
      continued = true;
    });
    await h.turn();
    const log = await h.log();
    expect(h.sandbox.created).toHaveLength(1);
    expect(log.filter((stored) => stored.type === "session.error").map((stored) => (stored.data as { error: unknown }).error))
      .toEqual([{ code: "skills_install_failed", message: "Skill Install failed at download: HTTP 403, curl exit 0" }]);
    expect(log.find((stored) => stored.type === "agent.tool_result")?.data).toMatchObject({ isError: true,
      content: [{ type: "text", text: expect.stringMatching(/^skills_install_failed: Skill Install failed at download/) }] });
    expect((await h.spans()).map((stored) => stored.type)).toEqual(["span.skills_install_start", "span.skills_install_end"]);
    expect(continued).toBe(false);
    expect(await h.installed()).toBeNull();
    expect(h.errors).toEqual([]);
  });

  it("answers a waiting call the Adapter left without a result with skills_install_failed", async () => {
    const h = await beside();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    h.sandbox.skillInstallFault = (stage) => { if (stage === "extract") throw new Error("unzip failed"); };
    h.run(async (input, write) => {
      await write(event("agent.tool_use", { toolUseId: "call_1", name: "read", input: { path: SKILL } }));
      await input.toolExecutor!.readFile(SKILL).catch(() => undefined);
      // Stops on the abort without recording the call's result.
    });
    await h.turn();
    const log = await h.log();
    expect(log.filter((stored) => stored.type === "agent.tool_result").map((stored) => stored.data)).toEqual([
      ...log.filter((stored) => stored.type === "agent.tool_result").slice(0, -1).map((stored) => stored.data),
      expect.objectContaining({ toolUseId: "call_1", isError: true, content: [{ type: "text",
        text: "skills_install_failed: Skill Install failed at extract: unzip failed. The tool was not executed." }] }),
    ]);
    expect((await h.types()).slice(-4)).toEqual(["agent.tool_result", "session.error", "session.turn_completed", "session.status_idle"]);
  });

  it("ends a Turn that calls no tool with skills_install_failed when its install failed, keeping the answer; the next Turn installs", async () => {
    const h = await beside();
    const recorded = await h.installed();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    h.sandbox.skillInstallFault = (stage) => { if (stage === "download") throw new Error("HTTP 503, curl exit 0"); };
    h.run(async (_input, write) => { await write(text("just chatting")); });
    await h.turn();
    const log = await h.log();
    const turnId = (log.findLast((stored) => stored.type === "session.turn_completed")!.data as { turnId: string }).turnId;
    expect(log.filter((stored) => stored.type === "session.error").map((stored) => stored.data)).toEqual([{ turnId, error: {
      code: "skills_install_failed",
      message: "Skill Install failed at download: HTTP 503, curl exit 0. The answer is retained; the Skills were not installed, and the next Turn installs them again.",
    } }]);
    // The answer stands: the error follows it, like the Workspace check at the Turn's end.
    expect(log.filter((stored) => stored.type === "agent.message").at(-1)?.data).toMatchObject({ turnId, content: [{ type: "text", text: "just chatting" }] });
    expect((await h.spans()).map((stored) => stored.data)).toEqual([expect.any(Object),
      expect.objectContaining({ outcome: "failed", stage: "download", reason: "HTTP 503, curl exit 0" })]);
    const types = await h.types();
    expect(types.lastIndexOf("span.skills_install_end")).toBeLessThan(types.lastIndexOf("session.error"));
    expect(types.slice(-3)).toEqual(["session.error", "session.turn_completed", "session.status_idle"]);
    expect((await h.stores.sessionStore.getById(h.parent.id))?.status).toBe("idle");
    expect(JSON.stringify(log)).not.toMatch(/data:application|https?:\/\//);
    expect(await h.installed()).toEqual(recorded);
    h.sandbox.skillInstallFault = undefined;
    const before = h.installs();
    const seen: string[] = [];
    h.run(async (input, write) => { seen.push(await input.toolExecutor!.readFile(SKILL)); await write(text("done")); });
    await h.turn();
    expect(seen).toEqual(["v2"]);
    expect(h.installs()).toBe(before + 1);
    expect(h.errors).toEqual([]);
  });

  it.each([
    ["a tool call waits for the install", true],
    ["no tool call waits for it", false],
  ])("ends an Interrupted Turn normally when %s: the install is cancelled, its end span says so, nothing is recorded", async (_case, waiting) => {
    const h = await beside();
    const recorded = await h.installed();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    // The download runs until the install is killed, as E2B kills it on abort.
    h.sandbox.skillInstallFault = (stage, signal) => stage === "download"
      ? new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) : undefined;
    h.run(async (input) => {
      const aborted = new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      if (waiting) await input.toolExecutor!.readFile(SKILL).catch(() => undefined);
      await aborted;
    });
    const turn = h.turn();
    await until(async () => (await h.spans()).length > 0 && h.router.interrupt(h.parent.id));
    await turn;
    const spans = await h.spans();
    expect(spans.map((stored) => stored.type)).toEqual(["span.skills_install_start", "span.skills_install_end"]);
    const [start, end] = spans.map((stored) => stored.data as Record<string, unknown>);
    expect(start).toMatchObject({ installId: expect.any(String) });
    expect(end).toMatchObject({ installId: start.installId, outcome: "aborted", reason: "Session interrupted" });
    expect((await h.types()).slice(-4)).toEqual(["span.skills_install_end", "session.turn_aborted", "session.turn_completed", "session.status_idle"]);
    // A cancelled install is no failure: the Turn records no error for it.
    expect((await h.log()).filter((stored) => stored.type === "session.error")).toEqual([]);
    expect((await h.stores.sessionStore.getById(h.parent.id))?.status).toBe("idle");
    expect(h.businessReads).not.toHaveBeenCalled();
    expect(await h.installed()).toEqual(recorded);
    // Nothing of the cancelled install is left: the next Turn installs at once.
    h.sandbox.skillInstallFault = undefined;
    const seen: string[] = [];
    h.run(async (input, write) => { seen.push(await input.toolExecutor!.readFile(SKILL)); await write(text("done")); });
    await h.turn();
    expect(seen).toEqual(["v2"]);
    expect(h.errors).toEqual([]);
  });

  it("ends the start span of an attempt that lost its Runner when another Runner takes the Turn over", async () => {
    const h = await beside();
    await h.edit(h.writer, [file("SKILL.md", "v2")]);
    const lost = new Set<string>();
    const renew = h.stores.pendingEventStore.renewClaim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.renewClaim = async (sessionId, eventId, claim, leaseMs) =>
      lost.has(claim.ownerId) ? { renewed: false, interruptRequested: false } : renew(sessionId, eventId, claim, leaseMs);
    const claim = h.stores.pendingEventStore.claim.bind(h.stores.pendingEventStore);
    h.stores.pendingEventStore.claim = async (sessionId, ownerId, leaseMs) => lost.has(ownerId) ? null : claim(sessionId, ownerId, leaseMs);
    const lease = { pendingClaimLeaseMs: 100, pendingClaimRenewIntervalMs: 30 };
    const runnerA = h.makeRouter({ pendingClaimOwnerId: "runner-a", ...lease });
    const runnerB = h.makeRouter({ pendingClaimOwnerId: "runner-b", ...lease });
    const download = deferred();
    h.sandbox.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    let attempts = 0;
    h.run(async (input, write) => {
      if (++attempts === 1) {
        // Runner A is lost while its install runs: it never writes again.
        lost.add("runner-a");
        await new Promise<void>(() => {});
      }
      download.resolve();
      await write(text(await input.toolExecutor!.readFile(SKILL)));
    });
    void h.turn(h.parent.id, runnerA);
    await until(async () => (await h.spans()).length === 1);
    await sleep(150);
    await runnerB.handleNewEvent(h.parent.id, (await h.stores.sessionStore.getById(h.parent.id))!.agent);
    expect(await runnerB.waitForIdle(4000)).toBe(true);
    const spans = (await h.spans()).map((stored) => stored.data as Record<string, unknown>);
    const starts = [spans[0], spans[2]];
    expect(spans.map((data) => data.outcome ?? "start")).toEqual(["start", "aborted", "start", "installed"]);
    expect(spans[1]).toEqual({ turnId: starts[0].turnId, installId: starts[0].installId, setHash: starts[0].setHash, skills: 1,
      outcome: "aborted", reason: "the Turn attempt that ran the install stopped before it ended" });
    expect(spans[3]).toMatchObject({ installId: starts[1].installId, outcome: "installed" });
    expect(starts[0].installId).not.toBe(starts[1].installId);
    const log = await h.log();
    const resumed = log.findIndex((stored) => stored.type === "session.turn_resumed");
    expect(log[resumed + 1]?.type).toBe("span.skills_install_end");
    // The stopped attempt's install is no failure: no error is recorded for it.
    expect(log.filter((stored) => stored.type === "session.error")).toEqual([]);
  });
});
