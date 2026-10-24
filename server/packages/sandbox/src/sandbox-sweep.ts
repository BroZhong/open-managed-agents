import type { GatewayListEntry, ListedSandbox } from "./sandbox-client.js";

/**
 * Which listed Sandboxes the sweeper (ADR-0023, "The sweeper") keeps, kills,
 * adopts or shortens. Pure: the caller lists the gateway, reads the bindings,
 * and before each action decides it again under the binding's row lock.
 *
 * Also the package's `./sweep` entry, which loads without the rest of the
 * package (the report bundles it), hence the re-exports.
 */
export type { ListedSandbox, GatewayListEntry };
export { SANDBOX_IDLE_SECONDS, listedSandbox } from "./sandbox-client.js";

/** The binding (root Session id) a Sandbox was created for. */
export const SANDBOX_BINDING_LABEL = "oma.dev/binding";
/** The environment whose sweeper may act on a Sandbox. */
export const SANDBOX_ENVIRONMENT_LABEL = "oma.dev/environment";
export const SWEEP_MAX_KILLS = 50;

export type SandboxEnvironment = "production" | "test";

/** What one row of this environment's `delegation_environments` says, with its Sessions. */
export interface SweepBinding {
  /** Ready when set; it takes precedence over `creatingSince`. */
  sandboxId: string | null;
  /** Creating since then (database clock) when set; Cold when both are null. */
  creatingSince: Date | null;
  /** Termination claimed the reclamation and has not completed it. */
  reclaiming: boolean;
  /** A resource user or queued input of a non-terminated Session. */
  inUse: boolean;
  /** No Session of the binding is alive (also true when none is left). */
  allSessionsTerminated: boolean;
}

export interface SweepOptions {
  environment: SandboxEnvironment;
  now: Date;
  /** After `creatingSince` + this, no create of the attempt can still be in flight. */
  intentDeadlineSeconds: number;
  /** The deadline an unused running Sandbox is shortened to. */
  idleSeconds: number;
  maxKills: number;
}

/** Every kill but `no-deadline` removes an orphan: a Sandbox no binding will use. */
export type SweepKillReason = "no-row" | "terminated" | "superseded" | "cold" | "duplicate" | "no-deadline";
export type SweepKeepReason =
  | "other-environment" // labelled with another environment
  | "unlabelled" // no environment label and no binding row here: left to its platform deadline
  | "unbound" // this environment's label but no binding label: outside the binding protocol
  | "in-use"
  | "paused" // Ready, unused and paused: bounded by platform retention, resumed by the next Turn
  | "short-deadline" // Ready, unused, running, deadline within idleSeconds already
  | "creating" // the creator may still be producing it
  | "reclaiming"; // termination's outbox kills it and retries until it confirms

export type SweepDecision = { sandboxId: string; bindingId: string | null } & (
  | { action: "keep"; reason: SweepKeepReason }
  /** `deferred`: over this round's cap, left to the next round. */
  | { action: "kill"; reason: SweepKillReason; deferred: boolean }
  /** Record the Sandbox as the binding's; `shorten` sets its deadline to idleSeconds too. */
  | { action: "adopt"; shorten: boolean }
  /** `setTimeout(idleSeconds)`. */
  | { action: "shorten" }
);

/** The `sandbox_sweep` log line's counts as planned; the sweeper logs the kills and adoptions it made. */
export interface SweepCounts {
  orphans: number;
  /** Bindings Creating past their deadline that have a listed Sandbox. */
  unresolved: number;
  /** Unused running Sandboxes shortened, adopted ones included. */
  unusedRunning: number;
  noDeadline: number;
  killed: number;
  adopted: number;
}

export interface SweepSelection {
  /** One per listed Sandbox, in listing order. */
  decisions: SweepDecision[];
  counts: SweepCounts;
}

type Kill = Extract<SweepDecision, { action: "kill" }>;

/** An unknown claim time (the gateway reports one it cannot parse) sorts last. */
const claimedAt = ({ startedAt }: ListedSandbox) => Number.isNaN(startedAt.getTime()) ? Number.POSITIVE_INFINITY : startedAt.getTime();
const byClaimThenId = (a: ListedSandbox, b: ListedSandbox) =>
  claimedAt(a) - claimedAt(b) || (a.sandboxId < b.sandboxId ? -1 : a.sandboxId > b.sandboxId ? 1 : 0);
const runningFirst = (a: ListedSandbox, b: ListedSandbox) =>
  Number(a.state === "paused") - Number(b.state === "paused");
/**
 * The order in which reconciliation keeps one binding's Sandboxes, ensure's
 * and the sweeper's alike (ADR-0023): a running one, else the earliest
 * claimed; it keeps the first and kills the rest.
 */
export const byKeepPreference = (a: ListedSandbox, b: ListedSandbox) => runningFirst(a, b) || byClaimThenId(a, b);

export function selectSweep(
  listed: readonly ListedSandbox[],
  bindings: ReadonlyMap<string, SweepBinding>,
  options: SweepOptions,
): SweepSelection {
  const now = options.now.getTime();
  const idleDeadline = now + options.idleSeconds * 1000;
  const longDeadline = (sandbox: ListedSandbox) =>
    sandbox.state === "running" && sandbox.endAt !== null && sandbox.endAt.getTime() > idleDeadline;

  // A page boundary that moves while listing can return a Sandbox twice.
  const seen = new Set<string>();
  const sandboxes = listed.filter((sandbox) => !seen.has(sandbox.sandboxId) && seen.add(sandbox.sandboxId));
  const decisions = new Map<string, SweepDecision>();
  const unresolved = new Map<string, ListedSandbox[]>();
  for (const sandbox of sandboxes) {
    const { sandboxId } = sandbox;
    const bindingId = sandbox.metadata[SANDBOX_BINDING_LABEL] ?? null;
    const keep = (reason: SweepKeepReason) => decisions.set(sandboxId, { sandboxId, bindingId, action: "keep", reason });
    const kill = (reason: SweepKillReason) => decisions.set(sandboxId, { sandboxId, bindingId, action: "kill", reason, deferred: false });
    const environment = sandbox.metadata[SANDBOX_ENVIRONMENT_LABEL];
    if (environment !== undefined && environment !== options.environment) { keep("other-environment"); continue; }
    if (bindingId === null) { keep(environment === undefined ? "unlabelled" : "unbound"); continue; }
    const row = bindings.get(bindingId);
    // A Sandbox without the label predates ADR-0023: it is ours only if its binding is.
    if (!row && environment === undefined) keep("unlabelled");
    else if (!row) kill("no-row");
    else if (row.reclaiming) keep("reclaiming");
    else if (row.allSessionsTerminated) kill("terminated");
    else if (row.sandboxId !== null) {
      if (row.sandboxId !== sandboxId) kill("superseded");
      else if (row.inUse) keep("in-use");
      else if (sandbox.state === "paused") keep("paused");
      else if (sandbox.endAt === null) kill("no-deadline");
      else if (longDeadline(sandbox)) decisions.set(sandboxId, { sandboxId, bindingId, action: "shorten" });
      else keep("short-deadline");
    } else if (row.creatingSince !== null) {
      if (now < row.creatingSince.getTime() + options.intentDeadlineSeconds * 1000) keep("creating");
      else unresolved.set(bindingId, [...(unresolved.get(bindingId) ?? []), sandbox]);
    } else kill("cold");
  }

  // Reconcile as ensure does: keep a running one, else the earliest claimed. An
  // adopted Sandbox without a deadline is not shortened (a no-op); unused, the
  // next round kills it by the Ready row.
  for (const [bindingId, group] of unresolved) {
    const [adopted, ...duplicates] = [...group].sort(byKeepPreference);
    const shorten = !bindings.get(bindingId)!.inUse && longDeadline(adopted);
    decisions.set(adopted.sandboxId, { sandboxId: adopted.sandboxId, bindingId, action: "adopt", shorten });
    for (const { sandboxId } of duplicates) decisions.set(sandboxId, { sandboxId, bindingId, action: "kill", reason: "duplicate", deferred: false });
  }

  // The cap takes the costliest first: a Sandbox without a deadline would run
  // forever, a running one until its deadline, a paused one only holds storage.
  // Every Runner computes the same order, so the fleet converges on one set.
  const kills = sandboxes.flatMap((sandbox) => {
    const decision = decisions.get(sandbox.sandboxId)!;
    return decision.action === "kill" ? [{ sandbox, decision }] : [];
  });
  const cost = ({ sandbox, decision }: { sandbox: ListedSandbox; decision: Kill }) =>
    decision.reason === "no-deadline" ? 0 : sandbox.state === "running" ? 1 : 2;
  kills.sort((a, b) => cost(a) - cost(b) || byClaimThenId(a.sandbox, b.sandbox));
  for (const { decision } of kills.slice(Math.max(0, options.maxKills))) decision.deferred = true;

  const ordered = sandboxes.map((sandbox) => decisions.get(sandbox.sandboxId)!);
  const count = (predicate: (decision: SweepDecision) => boolean) => ordered.filter(predicate).length;
  return {
    decisions: ordered,
    counts: {
      orphans: count((d) => d.action === "kill" && d.reason !== "no-deadline"),
      unresolved: unresolved.size,
      unusedRunning: count((d) => d.action === "shorten" || (d.action === "adopt" && d.shorten)),
      noDeadline: count((d) => d.action === "kill" && d.reason === "no-deadline"),
      killed: count((d) => d.action === "kill" && !d.deferred),
      adopted: count((d) => d.action === "adopt"),
    },
  };
}
