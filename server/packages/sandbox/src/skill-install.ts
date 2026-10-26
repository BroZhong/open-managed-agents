import { readFileSync } from "node:fs";
import { EMPTY_SKILL_SET_HASH, skillSetHash, type InstalledSkillSet, type SkillBundleStore, type SkillSetRecordOutcome } from "@oma-server/store";
import type { SandboxClient } from "./sandbox-client.js";

/**
 * Skill Install (ADR-0022): placing one Skill Set version into a Sandbox at
 * `/skills/<name>/`. The Host signs short-lived GET URLs for the Skill
 * Bundles; one root exec in the Sandbox downloads the bundles it does not
 * hold yet, extracts them read-only into `/opt/oma/skills/<setHash>` and
 * atomically switches the `/skills` symlink (see `skill-install.sh`).
 */

/** One equipped Skill: its installed directory name and current Skill Bundle. */
export interface SkillSetMember {
  name: string;
  sha256: string;
  /** Uncompressed bytes of the bundle (`skills.bundle_size`): sizes the install budget. */
  size: number;
}

/** An Agent's equipped Skills and their order-independent Skill Set hash. */
export interface SkillSet {
  setHash: string;
  bundles: readonly SkillSetMember[];
}

export function skillSetOf(bundles: readonly SkillSetMember[]): SkillSet {
  return {
    setHash: skillSetHash(bundles.map(({ name, sha256 }) => ({ name, bundleSha256: sha256 }))),
    bundles: bundles.map(({ name, sha256, size }) => ({ name, sha256, size })),
  };
}

/**
 * No Skills is a real version like any other: it installs an empty `/skills`,
 * which also replaces a projected `/skills` directory left by earlier Runners.
 */
export const EMPTY_SKILL_SET: SkillSet = { setHash: EMPTY_SKILL_SET_HASH, bundles: [] };

export const SKILLS_PATH = "/skills";
export const SKILLS_ROOT = "/opt/oma/skills";

/**
 * Where an install stopped: reading the binding's record, Host signing, a step
 * of the Sandbox script, or the binding write-back.
 */
export type SkillInstallStage = "check" | "start" | "sign" | "download" | "verify" | "extract" | "switch" | "record";
const SCRIPT_STAGES: readonly SkillInstallStage[] = ["start", "download", "verify", "extract", "switch"];

/**
 * A failed Skill Install. It carries no underlying error object: SDK and
 * storage errors may quote a signed URL, so only a redacted reason is kept.
 */
export class SkillInstallError extends Error {
  readonly reason: string;
  constructor(readonly stage: SkillInstallStage, reason: string) {
    const safe = redactUrls(reason);
    super(`Skill Install failed at ${stage}: ${safe}`);
    this.name = "SkillInstallError";
    this.reason = safe;
  }
}

/** Remove anything that looks like a URL or a signature from text that may reach logs or events. */
export function redactUrls(text: string): string {
  return text
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|data:)[^\s"'<>]*/gi, "<redacted URL>")
    .replace(/\b(Signature|OSSAccessKeyId|security-token|x-oss-[a-z-]+)=[^&\s"'<>]*/gi, "$1=<redacted>");
}

/** What a completed install did, from the script's result line. */
export interface SkillInstallReport {
  /** The version directory was already complete; nothing was downloaded. */
  reused: boolean;
  skills: number;
  /** Bundles downloaded because the Sandbox did not hold them. */
  downloaded: number;
  /** Zip bytes downloaded. */
  bytes: number;
  /** A projected `/skills` directory was replaced. */
  legacy: boolean;
  /**
   * The Sandbox's switch generation of this install's `/skills` switch:
   * higher than every earlier switch in the Sandbox, so the record of the
   * highest one names what `/skills` points at.
   */
  generation: number;
}

export const SKILL_INSTALL_SCRIPT = readFileSync(new URL("./skill-install.sh", import.meta.url), "utf8");
/** argv of the install exec; the request travels on stdin. */
export const SKILL_INSTALL_COMMAND: readonly string[] = ["bash", "-c", SKILL_INSTALL_SCRIPT, "oma-skill-install"];
export const SKILL_INSTALL_PROTOCOL = "oma-skill-install/1";
export const isSkillInstallCommand = (command: readonly string[]): boolean =>
  command.length === SKILL_INSTALL_COMMAND.length && command.every((part, index) => part === SKILL_INSTALL_COMMAND[index]);

/** Calibrated by the #261 spike: the slowest observed end-to-end install ran at 29 MB/s. */
export const DEFAULT_SKILL_INSTALL_THROUGHPUT = 20_000_000;
export const MIN_SKILL_INSTALL_BUDGET_MS = 30_000;

export interface SkillInstallBudget {
  /** Bytes per second the budget assumes. Default {@link DEFAULT_SKILL_INSTALL_THROUGHPUT}. */
  throughputBytesPerSec?: number;
  /** Floor of an attempt's budget. Default {@link MIN_SKILL_INSTALL_BUDGET_MS}. */
  minBudgetMs?: number;
}

/** One attempt's budget: max(floor, the Set's bytes ÷ throughput). */
export function skillInstallBudgetMs(skills: SkillSet, budget: SkillInstallBudget = {}): number {
  const throughput = budget.throughputBytesPerSec ?? DEFAULT_SKILL_INSTALL_THROUGHPUT;
  const floor = budget.minBudgetMs ?? MIN_SKILL_INSTALL_BUDGET_MS;
  const bytes = [...new Map(skills.bundles.map((bundle) => [bundle.sha256, bundle.size])).values()]
    .reduce((total, size) => total + size, 0);
  return Math.max(floor, Math.ceil((bytes / throughput) * 1000));
}

/** Shell-safe signed URLs only: the script refuses anything else, and must never quote one. */
const SAFE_URL = /^[^\s"'\\]+$/;

/**
 * One Skill Install attempt into one Sandbox. Signs a URL for each bundle of
 * the Set (local signing, no storage request), runs the install script as root
 * with the request on stdin and parses its result line. The script downloads
 * only bundles the Sandbox does not hold. Throws {@link SkillInstallError}.
 */
export async function installSkillSet(input: {
  client: Pick<SandboxClient, "exec">;
  bundles?: Pick<SkillBundleStore, "createInstallUrl">;
  sandboxId: string;
  tenantId: string;
  skills: SkillSet;
  budgetMs: number;
  /** Cancels the install: the exec is killed and the signal's reason is thrown. */
  signal?: AbortSignal;
}): Promise<SkillInstallReport> {
  const { client, bundles, sandboxId, tenantId, skills, budgetMs, signal } = input;
  signal?.throwIfAborted();
  const budgetSeconds = Math.ceil(budgetMs / 1000);
  const expiresInSec = Math.min(900, Math.max(600, budgetSeconds + 60));
  const urls = new Map<string, string>();
  for (const { sha256 } of skills.bundles) {
    if (urls.has(sha256)) continue;
    if (!bundles) throw new SkillInstallError("sign", "no Skill Bundle store is configured");
    let url: string;
    try { url = await bundles.createInstallUrl(tenantId, sha256, expiresInSec); }
    catch (error) { throw new SkillInstallError("sign", `cannot sign bundle ${sha256.slice(0, 12)}: ${messageOf(error)}`); }
    if (!SAFE_URL.test(url)) throw new SkillInstallError("sign", `the install URL of bundle ${sha256.slice(0, 12)} is not shell-safe`);
    urls.set(sha256, url);
  }
  const request = [
    `${SKILL_INSTALL_PROTOCOL} ${skills.setHash} ${skills.bundles.length} ${budgetSeconds}`,
    ...skills.bundles.map(({ name, sha256 }) => `${sha256} ${Buffer.from(name, "utf8").toString("base64")} ${urls.get(sha256)}`),
  ].join("\n") + "\n";

  // Filled by the output scan and the exit callback.
  const seen: { stage: SkillInstallStage; result?: Record<string, unknown>; exit?: { exitCode: number | null; signal?: string } } = { stage: "start" };
  let stdout = "";
  const scan = (final: boolean) => {
    const lines = stdout.split("\n");
    stdout = final ? "" : lines.pop()!;
    for (const line of lines) {
      const progress = /^OMA_SKILLS_STAGE (\w+)$/.exec(line.trim());
      if (progress && isScriptStage(progress[1])) seen.stage = progress[1];
      if (line.startsWith("OMA_SKILLS_RESULT ")) {
        try { seen.result = JSON.parse(line.slice("OMA_SKILLS_RESULT ".length)); } catch { /* reported below as no result */ }
      }
    }
  };
  // The budget is enforced here, not only by the exec timeout: aborting
  // kills the remote process instead of merely dropping its stream.
  const budget = AbortSignal.timeout(budgetMs);
  try {
    for await (const chunk of client.exec(sandboxId, [...SKILL_INSTALL_COMMAND], {
      user: "root", stdin: request, signal: signal ? AbortSignal.any([budget, signal]) : budget,
      timeoutSeconds: budgetSeconds + 30,
      onExit: (observed) => { seen.exit = observed; },
    })) {
      if (chunk.stream !== "stdout") continue;
      stdout += chunk.text;
      scan(false);
    }
    scan(true);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (budget.aborted) throw new SkillInstallError(seen.stage, `exceeded its budget of ${budgetSeconds} s`);
    throw new SkillInstallError(seen.stage, `the install exec failed: ${messageOf(error)}`);
  }
  const { result, exit } = seen;
  if (!result) {
    throw new SkillInstallError(seen.stage, exit ? `the installer exited with ${exit.signal ?? `code ${exit.exitCode}`} and no result` : "the installer reported no result");
  }
  if (result.ok !== true) {
    throw new SkillInstallError(isScriptStage(result.stage) ? result.stage : seen.stage, typeof result.reason === "string" ? result.reason : "the installer failed");
  }
  if (exit && exit.exitCode !== 0) throw new SkillInstallError(seen.stage, `the installer exited with code ${exit.exitCode}`);
  const generation = Number(result.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new SkillInstallError("switch", "the installer reported no switch generation");
  return {
    reused: result.reused === 1, skills: Number(result.skills), downloaded: Number(result.downloaded),
    bytes: Number(result.bytes), legacy: result.legacy === 1, generation,
  };
}

function isScriptStage(value: unknown): value is SkillInstallStage {
  return SCRIPT_STAGES.includes(value as SkillInstallStage);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where the binding records what its Sandbox holds. */
export interface SkillInstallLedger {
  installed(): Promise<InstalledSkillSet | null>;
  /**
   * Compare-and-set on the bound Sandbox and the switch generation: an
   * install records only over an earlier switch (see `SkillSetRecordOutcome`).
   */
  record(installed: InstalledSkillSet): Promise<SkillSetRecordOutcome>;
}

export interface SkillInstallerDeps extends SkillInstallBudget {
  client: Pick<SandboxClient, "exec">;
  bundles?: Pick<SkillBundleStore, "createInstallUrl">;
}

/** How a caller takes part in an install. */
export interface SkillInstallOptions {
  /**
   * Cancels the caller's part: its own install is killed and recorded nowhere,
   * a wait for another caller's install ends. Either rejects with the reason.
   */
  signal?: AbortSignal;
  /** Called right before the caller's own install starts; never for a skip or a wait. */
  onStart?(): void;
}

/** An install {@link SkillInstaller.begin} found necessary, running or waiting for one in flight. */
export interface PendingSkillInstall {
  /** The caller's own install's report; undefined when another's made it unnecessary. */
  readonly settled: Promise<SkillInstallReport | undefined>;
}

/**
 * The Sandbox Manager's Skill Installs. Skips an install the binding already
 * recorded for the same Sandbox and Skill Set, runs at most one install per
 * binding in this process at a time (a parent and its Child Sessions each have
 * a SandboxSession but share the binding), retries a failed attempt once and
 * records the binding only after complete success. A cancelled install is
 * neither retried nor recorded, and frees the binding at once.
 */
export class SkillInstaller {
  private readonly inflight = new Map<unknown, Promise<SkillInstallReport>>();
  /** Bindings without a durable ledger remember their installs per process. */
  private readonly local = new Map<unknown, InstalledSkillSet>();

  constructor(private readonly deps: SkillInstallerDeps) {}

  /**
   * Decide whether `sandboxId` must install `skills`, and start making it hold
   * them. Resolves undefined when the binding records the Set for the Sandbox
   * and no install for the binding runs in this process: nothing is to be
   * done. Otherwise resolves as soon as the caller's install has started, or
   * its wait for the one in flight, without waiting for either. `key`
   * identifies the binding; without a `ledger` the record is kept in this
   * process.
   */
  async begin(key: unknown, ledger: SkillInstallLedger | undefined, target: { sandboxId: string; tenantId: string }, skills: SkillSet, options: SkillInstallOptions = {}): Promise<PendingSkillInstall | undefined> {
    const book = ledger ?? this.localLedger(key);
    const checked = !this.inflight.has(key);
    if (checked && await this.holds(book, target, skills)) return undefined;
    const settled = this.settle(key, book, target, skills, options, checked && !this.inflight.has(key));
    // The caller may never look at the outcome of an install it started.
    settled.catch(() => {});
    return { settled };
  }

  /** {@link begin} and wait: the report of the caller's own install, undefined when it ran none. */
  async ensure(key: unknown, ledger: SkillInstallLedger | undefined, target: { sandboxId: string; tenantId: string }, skills: SkillSet, options?: SkillInstallOptions): Promise<SkillInstallReport | undefined> {
    return (await this.begin(key, ledger, target, skills, options))?.settled;
  }

  /**
   * Wait for the install in flight, re-check what it recorded, and install the
   * Set unless it did. `checked`: the caller just read that the binding does
   * not hold the Set, and nothing was in flight.
   */
  private async settle(key: unknown, ledger: SkillInstallLedger, target: { sandboxId: string; tenantId: string }, skills: SkillSet, options: SkillInstallOptions, checked: boolean): Promise<SkillInstallReport | undefined> {
    const { signal } = options;
    for (;;) {
      signal?.throwIfAborted();
      const running = this.inflight.get(key);
      if (running) {
        // Re-check what the finished install recorded: it may have installed this Set.
        await untilSettled(running, signal);
        checked = false;
        continue;
      }
      if (!checked && await this.holds(ledger, target, skills)) return undefined;
      checked = false;
      if (this.inflight.has(key)) continue;
      signal?.throwIfAborted();
      options.onStart?.();
      // The binding is free as soon as its caller gives up on the install,
      // even before a killed exec reports its end.
      const install = cancellable(this.install(ledger, target, skills, signal), signal).finally(() => {
        if (this.inflight.get(key) === install) this.inflight.delete(key);
      });
      this.inflight.set(key, install);
      return install;
    }
  }

  private async holds(ledger: SkillInstallLedger, target: { sandboxId: string }, skills: SkillSet): Promise<boolean> {
    let installed: InstalledSkillSet | null;
    try { installed = await ledger.installed(); }
    catch (error) { throw new SkillInstallError("check", `cannot read what the binding installed: ${messageOf(error)}`); }
    return installed?.sandboxId === target.sandboxId && installed.setHash === skills.setHash;
  }

  private async install(ledger: SkillInstallLedger, target: { sandboxId: string; tenantId: string }, skills: SkillSet, signal?: AbortSignal): Promise<SkillInstallReport> {
    const budgetMs = skillInstallBudgetMs(skills, this.deps);
    let report: SkillInstallReport | undefined;
    for (let attempt = 1; !report; attempt++) {
      try {
        report = await installSkillSet({ client: this.deps.client, bundles: this.deps.bundles, ...target, skills, budgetMs, signal });
      } catch (error) {
        if (attempt >= 2 || signal?.aborted) throw error;
      }
    }
    // The script reported its switch: record it even if the caller cancelled
    // meanwhile, so the record never lags a completed switch (ADR-0022,
    // Consequences). Only an exec killed before its result stays unrecorded.
    let outcome: SkillSetRecordOutcome;
    try { outcome = await ledger.record({ sandboxId: target.sandboxId, setHash: skills.setHash, generation: report.generation }); }
    catch (error) { throw new SkillInstallError("record", `cannot record the install: ${messageOf(error)}`); }
    if (outcome === "detached") throw new SkillInstallError("record", "the Sandbox binding no longer holds the Sandbox that was installed");
    signal?.throwIfAborted();
    // Superseded: another install switched /skills after this one and is
    // recorded. The Turn goes on and may see that version (ADR-0022).
    return report;
  }

  private localLedger(key: unknown): SkillInstallLedger {
    return {
      installed: async () => this.local.get(key) ?? null,
      record: async (installed) => {
        const recorded = this.local.get(key);
        if (recorded?.sandboxId === installed.sandboxId && recorded.generation >= installed.generation) return "superseded";
        this.local.set(key, { ...installed });
        return "recorded";
      },
    };
  }
}

/** `work`, rejected with the signal's reason as soon as it aborts. */
function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Wait until `work` settles, whatever its outcome, or reject when the signal aborts first. */
async function untilSettled(work: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  await cancellable(work.then(() => {}, () => {}), signal);
}
