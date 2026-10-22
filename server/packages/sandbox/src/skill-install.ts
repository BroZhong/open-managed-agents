import { readFileSync } from "node:fs";
import { EMPTY_SKILL_SET_HASH, skillSetHash, type InstalledSkillSet, type SkillBundleStore } from "@oma-server/store";
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

/** Where an install stopped: Host signing, a step of the Sandbox script, or the binding write-back. */
export type SkillInstallStage = "start" | "sign" | "download" | "verify" | "extract" | "switch" | "record";
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
}): Promise<SkillInstallReport> {
  const { client, bundles, sandboxId, tenantId, skills, budgetMs } = input;
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
      user: "root", stdin: request, signal: budget,
      timeoutSeconds: budgetSeconds + 30,
      onExit: (observed) => { seen.exit = observed; },
    })) {
      if (chunk.stream !== "stdout") continue;
      stdout += chunk.text;
      scan(false);
    }
    scan(true);
  } catch (error) {
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
  return {
    reused: result.reused === 1, skills: Number(result.skills), downloaded: Number(result.downloaded),
    bytes: Number(result.bytes), legacy: result.legacy === 1,
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
  /** Compare-and-set on the bound Sandbox; false when the binding moved on. */
  record(installed: InstalledSkillSet): Promise<boolean>;
}

export interface SkillInstallerDeps extends SkillInstallBudget {
  client: Pick<SandboxClient, "exec">;
  bundles?: Pick<SkillBundleStore, "createInstallUrl">;
}

/**
 * The Sandbox Manager's Skill Installs. Skips an install the binding already
 * recorded for the same Sandbox and Skill Set, runs at most one install per
 * binding in this process at a time (a parent and its Child Sessions each have
 * a SandboxSession but share the binding), retries a failed attempt once and
 * records the binding only after complete success.
 */
export class SkillInstaller {
  private readonly inflight = new Map<unknown, Promise<SkillInstallReport>>();
  /** Bindings without a durable ledger remember their installs per process. */
  private readonly local = new Map<unknown, InstalledSkillSet>();

  constructor(private readonly deps: SkillInstallerDeps) {}

  /**
   * Make `sandboxId` hold `skills`. Resolves undefined when nothing had to be
   * installed. `key` identifies the binding; without a `ledger` the record is
   * kept in this process.
   */
  async ensure(key: unknown, ledger: SkillInstallLedger | undefined, target: { sandboxId: string; tenantId: string }, skills: SkillSet): Promise<SkillInstallReport | undefined> {
    const book = ledger ?? this.localLedger(key);
    for (;;) {
      const running = this.inflight.get(key);
      if (running) {
        // Re-check what the finished install recorded: it may have installed this Set.
        await running.catch(() => undefined);
        continue;
      }
      const installed = await book.installed();
      if (installed?.sandboxId === target.sandboxId && installed.setHash === skills.setHash) return undefined;
      if (this.inflight.has(key)) continue;
      const install = this.install(book, target, skills).finally(() => {
        if (this.inflight.get(key) === install) this.inflight.delete(key);
      });
      this.inflight.set(key, install);
      return install;
    }
  }

  private async install(ledger: SkillInstallLedger, target: { sandboxId: string; tenantId: string }, skills: SkillSet): Promise<SkillInstallReport> {
    const budgetMs = skillInstallBudgetMs(skills, this.deps);
    let report: SkillInstallReport | undefined;
    for (let attempt = 1; !report; attempt++) {
      try {
        report = await installSkillSet({ client: this.deps.client, bundles: this.deps.bundles, ...target, skills, budgetMs });
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
    let recorded: boolean;
    try { recorded = await ledger.record({ sandboxId: target.sandboxId, setHash: skills.setHash }); }
    catch (error) { throw new SkillInstallError("record", `cannot record the install: ${messageOf(error)}`); }
    if (!recorded) throw new SkillInstallError("record", "the environment binding no longer holds the Sandbox that was installed");
    return report;
  }

  private localLedger(key: unknown): SkillInstallLedger {
    return {
      installed: async () => this.local.get(key) ?? null,
      record: async (installed) => { this.local.set(key, { ...installed }); return true; },
    };
  }
}
