import { describe, expect, it, vi } from "vitest";
import type { InstalledSkillSet } from "@oma-server/store";
import { createMemoryStores } from "@oma-server/store-memory";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { Bundles, TENANT, text } from "./skill-bundles.js";
import {
  EMPTY_SKILL_SET,
  SkillInstallError,
  SkillInstaller,
  installSkillSet,
  isSkillInstallCommand,
  redactUrls,
  SKILL_INSTALL_COMMAND,
  skillInstallBudgetMs,
  skillSetOf,
  type SkillInstallLedger,
  type SkillSetMember,
} from "../src/skill-install.js";

/** A TrueType header followed by every byte value: survives only a byte-exact path. */
const FONT = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, ...Array.from({ length: 256 }, (_, index) => index)]);

async function setUp() {
  const client = new FakeSandboxClient();
  const { id } = await client.create();
  const bundles = new Bundles();
  const exec = vi.spyOn(client, "exec");
  const installs = () => exec.mock.calls.filter(([, command]) => isSkillInstallCommand(command));
  return { client, id, bundles, exec, installs };
}

/** One binding of the in-memory delegation store, optionally recording `initial` as installed into its Sandbox. */
async function ledger(initial: Omit<InstalledSkillSet, "generation"> | null = null) {
  const store = createMemoryStores().delegationStore;
  const bind = (sandboxId: string | null) => store.withEnvironmentLock("binding", async () => ({ next: sandboxId ? { ready: sandboxId } : "cold" as const, value: undefined }));
  if (initial) {
    await bind(initial.sandboxId);
    await store.recordSkillSetInstall("binding", { ...initial, generation: 1 });
  }
  const book = {
    bind,
    installed: vi.fn(() => store.installedSkillSet("binding")),
    record: vi.fn((next: InstalledSkillSet) => store.recordSkillSetInstall("binding", next)),
  };
  return book satisfies SkillInstallLedger;
}

describe("Skill Install into one Sandbox", () => {
  it("installs byte-exact read-only Skills as root, with signed URLs only on stdin", async () => {
    const { client, id, bundles, installs } = await setUp();
    const writer = await bundles.add("writer", [
      text("SKILL.md", "---\nname: writer\n---\nwrite"),
      { path: "assets/fonts/Font.ttf", body: FONT },
      text("bin/run.sh", "#!/bin/sh\necho ok\n", 0o755),
    ]);
    const report = await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([writer]), budgetMs: 30_000 });
    expect(report).toMatchObject({ reused: false, skills: 1, downloaded: 1, legacy: false });
    const files = client.filesOf(id);
    expect(new TextDecoder().decode(files.get("/skills/writer/SKILL.md")!.content as Uint8Array)).toBe("---\nname: writer\n---\nwrite");
    expect(files.get("/skills/writer/assets/fonts/Font.ttf")!.content).toEqual(FONT);
    expect(files.get("/skills/writer/SKILL.md")!.mode).toBe(0o444);
    expect(files.get("/skills/writer/assets/fonts/Font.ttf")!.mode).toBe(0o444);
    expect(files.get("/skills/writer/bin/run.sh")!.mode).toBe(0o555);
    const [[, command, options]] = installs();
    expect(options).toMatchObject({ user: "root", stdin: expect.stringContaining("data:application/zip") });
    expect(command).toEqual(SKILL_INSTALL_COMMAND);
    expect(JSON.stringify(command)).not.toContain("data:application");
  });

  it("downloads only bundles the Sandbox does not hold and keeps the current and previous versions", async () => {
    const { client, id, bundles } = await setUp();
    const one = await bundles.add("one", [text("SKILL.md", "one")]);
    const two = await bundles.add("two", [text("SKILL.md", "two v1")]);
    const twoEdited = await bundles.add("two", [text("SKILL.md", "two v2")]);
    const install = (members: SkillSetMember[]) => installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf(members), budgetMs: 30_000 });
    const first = skillSetOf([one, two]);
    expect(await install([one, two])).toMatchObject({ downloaded: 2 });
    const second = skillSetOf([one, twoEdited]);
    expect(await install([one, twoEdited])).toMatchObject({ downloaded: 1, reused: false });
    expect(await client.readFile(id, "/skills/two/SKILL.md")).toBe("two v2");
    expect(client.skillVersionsOf(id)).toEqual([first.setHash, second.setHash].sort());
    // Renaming installs a new version from the cached bundle.
    const renamed = { ...one, name: "uno" };
    expect(await install([renamed, twoEdited])).toMatchObject({ downloaded: 0, reused: false });
    expect(await client.readFile(id, "/skills/uno/SKILL.md")).toBe("one");
    expect(client.filesOf(id).has("/skills/one/SKILL.md")).toBe(false);
    // The oldest version and the bundle only it referenced are gone.
    expect(client.skillVersionsOf(id)).toEqual([second.setHash, skillSetOf([renamed, twoEdited]).setHash].sort());
    expect(client.skillBundlesOf(id)).toEqual([one.sha256, twoEdited.sha256].sort());
    // Switching back to the previous version reuses its directory.
    expect(await install([one, twoEdited])).toMatchObject({ reused: true, downloaded: 0 });
    expect(await client.readFile(id, "/skills/one/SKILL.md")).toBe("one");
  });

  it("replaces a projected /skills directory, also with an empty Skill Set", async () => {
    const { client, id, bundles } = await setUp();
    await client.writeFile(id, "/skills/old/SKILL.md", "projected");
    const report = await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: EMPTY_SKILL_SET, budgetMs: 30_000 });
    expect(report).toMatchObject({ legacy: true, skills: 0, downloaded: 0 });
    expect(await client.list(id, "/skills")).toEqual([]);
    expect(bundles.signed).toEqual([]);
  });

  it.each([
    ["download", "HTTP 000, curl exit 6", (bundles: Bundles) => { bundles.createInstallUrl = async () => "https://agentry.oss-cn-shanghai-internal.aliyuncs.com/b.zip?Signature=secret"; }],
    ["verify", "sha256 mismatch", (bundles: Bundles) => { const sign = bundles.createInstallUrl.bind(bundles); bundles.createInstallUrl = async (...args) => (await sign(...args)).replace(/.{8}$/, "AAAAAAAA"); }],
  ] as const)("fails at %s without exposing a URL or switching /skills", async (stage, reason, sabotage) => {
    const { client, id, bundles } = await setUp();
    const kept = await bundles.add("kept", [text("SKILL.md", "kept")]);
    await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([kept]), budgetMs: 30_000 });
    const next = await bundles.add("next", [text("SKILL.md", "next")]);
    sabotage(bundles);
    const failure = await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([kept, next]), budgetMs: 30_000 }).catch((error) => error);
    expect(failure).toBeInstanceOf(SkillInstallError);
    expect(failure).toMatchObject({ stage, message: expect.stringContaining(reason) });
    expect(failure.message).not.toMatch(/https?:|data:|Signature/);
    expect(await client.readFile(id, "/skills/kept/SKILL.md")).toBe("kept");
    expect(client.filesOf(id).has("/skills/next/SKILL.md")).toBe(false);
  });

  it("stops an install over its budget and keeps the old /skills target", async () => {
    const { client, id, bundles } = await setUp();
    const kept = await bundles.add("kept", [text("SKILL.md", "kept")]);
    await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([kept]), budgetMs: 30_000 });
    const next = await bundles.add("next", [text("SKILL.md", "next")]);
    client.skillInstallFault = (stage, signal) => stage === "extract" ? new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())) : undefined;
    const failure = await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([next]), budgetMs: 50 }).catch((error) => error);
    expect(failure).toMatchObject({ name: "SkillInstallError", stage: "extract", reason: "exceeded its budget of 1 s" });
    expect(await client.readFile(id, "/skills/kept/SKILL.md")).toBe("kept");
  });

  it("names the stage and redacts URLs from signing errors", async () => {
    const { client, id, bundles } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    bundles.createInstallUrl = async () => { throw new Error("signing failed for https://agentry.oss.example/key?OSSAccessKeyId=AK&Signature=s3cr3t"); };
    const failure = await installSkillSet({ client, bundles, sandboxId: id, tenantId: TENANT, skills: skillSetOf([skill]), budgetMs: 30_000 }).catch((error) => error);
    expect(failure).toMatchObject({ stage: "sign" });
    expect(failure.message).not.toMatch(/s3cr3t|AK&|agentry\.oss/);
  });

  it("sizes the budget from the Set's bytes with a 30 s floor", () => {
    const set = (size: number) => skillSetOf([{ name: "big", sha256: "c".repeat(64), size }]);
    expect(skillInstallBudgetMs(set(5_000_000))).toBe(30_000);
    expect(skillInstallBudgetMs(set(1_000_000_000))).toBe(50_000);
    expect(skillInstallBudgetMs(set(1_000_000_000), { throughputBytesPerSec: 10_000_000 })).toBe(100_000);
  });

  it("redacts URLs and signature parameters", () => {
    expect(redactUrls("GET https://b.oss/k.zip?Signature=x failed; data:application/zip;base64,AAAA too"))
      .toBe("GET <redacted URL> failed; <redacted URL> too");
    expect(redactUrls("x-oss-signature=abc&x-oss-credential=LTAI")).toBe("x-oss-signature=<redacted>&x-oss-credential=<redacted>");
  });
});

describe("Skill Installer: skip, single flight, retry and record", () => {
  it("skips a Sandbox that recorded the same Skill Set with no bundle-store or Sandbox call", async () => {
    const { client, id, bundles, exec } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    const skills = skillSetOf([skill]);
    const book = await ledger({ sandboxId: id, setHash: skills.setHash });
    expect(await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skills)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(bundles.signed).toEqual([]);
    expect(book.record).not.toHaveBeenCalled();
  });

  it("reinstalls into a different Sandbox and records only after complete success", async () => {
    const { client, id, bundles, installs } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    const skills = skillSetOf([skill]);
    const book = await ledger({ sandboxId: "sbx-old", setHash: skills.setHash });
    await book.bind(id);
    const report = await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skills);
    expect(report).toMatchObject({ downloaded: 1 });
    expect(installs()).toHaveLength(1);
    expect(book.record).toHaveBeenCalledExactlyOnceWith({ sandboxId: id, setHash: skills.setHash, generation: 1 });
  });

  it("retries a failed attempt once and never records a failure", async () => {
    const { client, id, bundles, installs } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    const book = await ledger(); await book.bind(id);
    let faults = 0;
    client.skillInstallFault = (stage) => { if (stage === "switch" && faults++ < 1) throw new Error("rename failed"); };
    await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skillSetOf([skill]));
    expect(installs()).toHaveLength(2);
    expect(book.record).toHaveBeenCalledOnce();
    client.skillInstallFault = (stage) => { if (stage === "download") throw new Error("network down"); };
    const other = await bundles.add("other", [text("SKILL.md", "y")]);
    const failure = await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skillSetOf([other])).catch((error) => error);
    expect(failure).toMatchObject({ stage: "download", reason: "network down" });
    expect(installs()).toHaveLength(4);
    expect(book.record).toHaveBeenCalledOnce();
    expect(await client.readFile(id, "/skills/writer/SKILL.md")).toBe("x");
  });

  it("downloads a failing bundle once per attempt: the Host's single retry is the only one", async () => {
    const { client, id, bundles } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    bundles.createInstallUrl = async () => "https://agentry.oss-cn-shanghai-internal.aliyuncs.com/b.zip?Signature=unreachable";
    const downloads: string[] = [];
    client.skillInstallFault = (stage) => { if (stage === "download") downloads.push(stage); };
    const book = await ledger(); await book.bind(id);
    const failure = await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skillSetOf([skill])).catch((error) => error);
    expect(failure).toMatchObject({ name: "SkillInstallError", stage: "download" });
    expect(downloads).toHaveLength(2);
  });

  it("runs one install per binding in a process; a waiter re-checks what it recorded", async () => {
    const { client, id, bundles, installs } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    const skills = skillSetOf([skill]);
    const book = await ledger(); await book.bind(id);
    const installer = new SkillInstaller({ client, bundles });
    const target = { sandboxId: id, tenantId: TENANT };
    const [parent, child] = await Promise.all([installer.ensure("root", book, target, skills), installer.ensure("root", book, target, skills)]);
    expect(parent).toMatchObject({ downloaded: 1 });
    expect(child).toBeUndefined();
    expect(installs()).toHaveLength(1);
  });

  it("lets two Runners install the same version into one Sandbox at once", async () => {
    const { client, id, bundles, installs } = await setUp();
    const members = await Promise.all(["a", "b", "c"].map((name) => bundles.add(name, [text("SKILL.md", name), { path: "font.ttf", body: FONT }])));
    const skills = skillSetOf(members);
    const book = await ledger(); await book.bind(id);
    const target = { sandboxId: id, tenantId: TENANT };
    const reports = await Promise.all([new SkillInstaller({ client, bundles }), new SkillInstaller({ client, bundles })]
      .map((installer) => installer.ensure("root", book, target, skills)));
    expect(installs()).toHaveLength(2);
    expect(reports.map((report) => report?.downloaded).sort()).toEqual([0, 3]);
    for (const name of ["a", "b", "c"]) {
      expect(await client.readFile(id, `/skills/${name}/SKILL.md`)).toBe(name);
      expect(await client.readFileBytes(id, `/skills/${name}/font.ttf`)).toEqual(FONT);
    }
    expect(client.skillVersionsOf(id)).toEqual([skills.setHash]);
    expect(book.record).toHaveBeenCalledTimes(2);
  });

  it("records the last switch when two Runners install different Sets into one Sandbox and record out of order", async () => {
    const { client, id, bundles, installs } = await setUp();
    const x = skillSetOf([await bundles.add("writer", [text("SKILL.md", "x")])]);
    const y = skillSetOf([await bundles.add("writer", [text("SKILL.md", "y")])]);
    const book = await ledger(); await book.bind(id);
    const target = { sandboxId: id, tenantId: TENANT };
    // Runner B installs Y first and switches first, but records only after Runner A switched to X and recorded it.
    const recordY = deferred();
    const lateBook: SkillInstallLedger = { installed: book.installed, record: async (next) => { await recordY.promise; return book.record(next); } };
    const runnerB = new SkillInstaller({ client, bundles }).ensure("root", lateBook, target, y);
    await vi.waitFor(() => expect(installs()).toHaveLength(1));
    const runnerA = new SkillInstaller({ client, bundles }).ensure("root", book, target, x);
    expect(await runnerA).toMatchObject({ generation: 2 });
    recordY.resolve();
    // The superseded record is not a failure: B's Turn sees X, which another Turn switched to.
    expect(await runnerB).toMatchObject({ generation: 1 });
    expect(await client.readFile(id, "/skills/writer/SKILL.md")).toBe("x");
    expect(await book.installed()).toEqual({ sandboxId: id, setHash: x.setHash, generation: 2 });
  });

  it("fails at record when the binding moved on to another Sandbox", async () => {
    const { client, id, bundles } = await setUp();
    const skill = await bundles.add("writer", [text("SKILL.md", "x")]);
    const book = await ledger(); await book.bind("sbx-replacement");
    const failure = await new SkillInstaller({ client, bundles }).ensure("binding", book, { sandboxId: id, tenantId: TENANT }, skillSetOf([skill])).catch((error) => error);
    expect(failure).toMatchObject({ name: "SkillInstallError", stage: "record" });
  });

  it("keeps a process-local record for a binding without a ledger", async () => {
    const { client, id, bundles, installs } = await setUp();
    const installer = new SkillInstaller({ client, bundles });
    const target = { sandboxId: id, tenantId: TENANT };
    await installer.ensure("session", undefined, target, EMPTY_SKILL_SET);
    await installer.ensure("session", undefined, target, EMPTY_SKILL_SET);
    expect(installs()).toHaveLength(1);
  });
});

/** A promise the test settles. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("Skill Installer beside a Turn (#268)", () => {
  async function installerFor(name = "writer") {
    const fixture = await setUp();
    const skills = skillSetOf([await fixture.bundles.add(name, [text("SKILL.md", name)])]);
    const book = await ledger(); await book.bind(fixture.id);
    const installer = new SkillInstaller({ client: fixture.client, bundles: fixture.bundles });
    return { ...fixture, skills, book, installer, target: { sandboxId: fixture.id, tenantId: TENANT } };
  }

  it("decides first: begin resolves nothing for a recorded Set, else the started install without waiting for it", async () => {
    const { client, id, skills, book, installer, target } = await installerFor();
    const onStart = vi.fn();
    const recorded = await ledger({ sandboxId: id, setHash: skills.setHash });
    expect(await installer.begin("recorded", recorded, target, skills, { onStart })).toBeUndefined();
    expect(onStart).not.toHaveBeenCalled();
    const download = deferred();
    client.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    const pending = await installer.begin("binding", book, target, skills, { onStart });
    expect(onStart).toHaveBeenCalledOnce();
    expect(book.record).not.toHaveBeenCalled();
    download.resolve();
    expect(await pending!.settled).toMatchObject({ downloaded: 1, skills: 1 });
    expect(book.record).toHaveBeenCalledOnce();
  });

  it("cancels an install whose caller aborts at once: no retry, no record, and the binding's single flight is free", async () => {
    const { client, skills, book, installer, target, installs } = await installerFor();
    // An exec that ignores the abort must not hold the caller or the binding.
    client.skillInstallFault = (stage) => stage === "download" ? new Promise<void>(() => {}) : undefined;
    const turn = new AbortController();
    const pending = await installer.begin("binding", book, target, skills, { signal: turn.signal });
    await vi.waitFor(() => expect(installs()).toHaveLength(1));
    turn.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(pending!.settled).rejects.toMatchObject({ name: "AbortError", message: "Session interrupted" });
    expect(installs()).toHaveLength(1);
    expect(book.record).not.toHaveBeenCalled();
    client.skillInstallFault = undefined;
    expect(await installer.ensure("binding", book, target, skills)).toMatchObject({ downloaded: 1 });
    expect(book.record).toHaveBeenCalledOnce();
  });

  it("records a switch the installer completed even when its caller cancelled right after", async () => {
    const { client, skills, book, installer, target } = await installerFor();
    const turn = new AbortController();
    const exec = FakeSandboxClient.prototype.exec;
    // The cancellation lands after the script reported its switch, before the record.
    vi.mocked(client.exec).mockImplementation(async function* (id, command, opts) {
      yield* exec.call(client, id, command, opts);
      if (isSkillInstallCommand(command)) turn.abort(new DOMException("Session interrupted", "AbortError"));
    });
    const pending = await installer.begin("binding", book, target, skills, { signal: turn.signal });
    await expect(pending!.settled).rejects.toMatchObject({ name: "AbortError" });
    // A record never lags a completed switch, so a later Turn with this Set skips.
    await vi.waitFor(() => expect(book.record).toHaveBeenCalledOnce());
    expect(await book.installed()).toMatchObject({ sandboxId: target.sandboxId, setHash: skills.setHash });
    expect(await installer.begin("binding", book, target, skills)).toBeUndefined();
  });

  it("stops a waiter that aborts without cancelling the install it waits for", async () => {
    const { client, skills, book, installer, target, installs } = await installerFor();
    const download = deferred();
    client.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    const running = await installer.begin("binding", book, target, skills);
    const child = new AbortController();
    const onStart = vi.fn();
    const waiting = await installer.begin("binding", book, target, skills, { signal: child.signal, onStart });
    child.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(waiting!.settled).rejects.toMatchObject({ name: "AbortError" });
    download.resolve();
    expect(await running!.settled).toMatchObject({ downloaded: 1 });
    expect(onStart).not.toHaveBeenCalled();
    expect(installs()).toHaveLength(1);
  });

  it("lets a waiter install the Set itself once the install it waited for was aborted", async () => {
    const { client, skills, book, installer, target, installs } = await installerFor();
    const download = deferred();
    client.skillInstallFault = (stage) => stage === "download" ? download.promise : undefined;
    const parent = new AbortController();
    const running = await installer.begin("binding", book, target, skills, { signal: parent.signal });
    const onStart = vi.fn();
    const waiting = await installer.begin("binding", book, target, skills, { onStart });
    expect(onStart).not.toHaveBeenCalled();
    parent.abort(new DOMException("Session interrupted", "AbortError"));
    await expect(running!.settled).rejects.toMatchObject({ name: "AbortError" });
    client.skillInstallFault = undefined;
    expect(await waiting!.settled).toMatchObject({ skills: 1 });
    expect(onStart).toHaveBeenCalledOnce();
    expect(installs()).toHaveLength(2);
    expect(book.record).toHaveBeenCalledOnce();
  });

  it("fails at check when the binding's record cannot be read", async () => {
    const { skills, book, installer, target, installs } = await installerFor();
    book.installed.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    await expect(installer.ensure("binding", book, target, skills)).rejects.toMatchObject({
      name: "SkillInstallError", stage: "check", message: "Skill Install failed at check: cannot read what the binding installed: connection terminated unexpectedly",
    });
    expect(installs()).toHaveLength(0);
  });
});
