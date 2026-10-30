import { describe, expect, it } from "vitest";
import type { ListedSandbox } from "../src/sandbox-client.js";
import {
  SANDBOX_BINDING_LABEL,
  SANDBOX_ENVIRONMENT_LABEL,
  selectSweep,
  type SweepBinding,
  type SweepDecision,
  type SweepOptions,
} from "../src/sandbox-sweep.js";

const now = new Date("2026-10-24T04:00:00Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
const options: SweepOptions = { environment: "production", now, intentDeadlineSeconds: 180, idleSeconds: 900, maxKills: 50 };

interface SandboxShape extends Partial<Omit<ListedSandbox, "metadata">> {
  /** `oma.dev/environment`; null leaves the label off (a Sandbox from before ADR-0023). */
  environment?: string | null;
}
function sandbox(sandboxId: string, binding: string | null, shape: SandboxShape = {}): ListedSandbox {
  const { environment = "production", ...rest } = shape;
  return {
    sandboxId, startedAt: at(-60), endAt: at(24 * 60),
    metadata: {
      ...(binding === null ? {} : { [SANDBOX_BINDING_LABEL]: binding }),
      ...(environment === null ? {} : { [SANDBOX_ENVIRONMENT_LABEL]: environment }),
      "oma.dev/tenant": "tenant_1",
    },
    ...rest,
  };
}
const live = { reclaiming: false, inUse: false, allSessionsTerminated: false };
const ready = (sandboxId: string, facts: Partial<SweepBinding> = {}): SweepBinding =>
  ({ ...live, sandboxId, creatingSince: null, ...facts });
const creating = (since: Date, facts: Partial<SweepBinding> = {}): SweepBinding =>
  ({ ...live, sandboxId: null, creatingSince: since, ...facts });
const cold = (facts: Partial<SweepBinding> = {}): SweepBinding =>
  ({ ...live, sandboxId: null, creatingSince: null, ...facts });

function sweep(sandboxes: ListedSandbox[], bindings: Record<string, SweepBinding>, overrides: Partial<SweepOptions> = {}) {
  return selectSweep(sandboxes, new Map(Object.entries(bindings)), { ...options, ...overrides });
}
function decisionOf(sandboxes: ListedSandbox[], bindings: Record<string, SweepBinding>, overrides: Partial<SweepOptions> = {}): SweepDecision {
  const { decisions } = sweep(sandboxes, bindings, overrides);
  expect(decisions).toHaveLength(sandboxes.length);
  return decisions[0];
}
const byId = (decisions: SweepDecision[]) => Object.fromEntries(decisions.map((d) => [d.sandboxId, d]));

describe("sandbox sweep selection (ADR-0023 sweeper table)", () => {
  describe("B's row is Ready(S)", () => {
    it("keeps S while B has a user or queued input, even with a long deadline or none", () => {
      for (const endAt of [at(24 * 60), null]) {
        expect(decisionOf([sandbox("s", "b", { endAt })], { b: ready("s", { inUse: true }) }))
          .toEqual({ sandboxId: "s", bindingId: "b", action: "keep", reason: "in-use" });
      }
    });

    it("shortens an unused S whose deadline is later than 15 minutes", () => {
      expect(decisionOf([sandbox("s", "b", { endAt: at(16) })], { b: ready("s") }))
        .toEqual({ sandboxId: "s", bindingId: "b", action: "shorten" });
    });

    it("leaves an unused S whose deadline is already within 15 minutes", () => {
      for (const endAt of [at(15), at(5), at(-1)]) {
        expect(decisionOf([sandbox("s", "b", { endAt })], { b: ready("s") }))
          .toMatchObject({ action: "keep", reason: "short-deadline" });
      }
    });

    it("kills an unused S with no deadline at all, because setTimeout is a no-op for it", () => {
      expect(decisionOf([sandbox("s", "b", { endAt: null })], { b: ready("s") }))
        .toEqual({ sandboxId: "s", bindingId: "b", action: "kill", reason: "no-deadline", deferred: false });
    });
  });

  it("kills S when B's row is Ready(S2) with S2 ≠ S, whether or not B is in use, and keeps S2", () => {
    for (const inUse of [false, true]) {
      const decisions = byId(sweep([sandbox("s", "b"), sandbox("s2", "b", { endAt: at(10) })], { b: ready("s2", { inUse }) }).decisions);
      expect(decisions.s).toEqual({ sandboxId: "s", bindingId: "b", action: "kill", reason: "superseded", deferred: false });
      expect(decisions.s2.action).toBe("keep");
    }
  });

  it("kills S when B's row is Cold: nothing would ever adopt it", () => {
    expect(decisionOf([sandbox("s", "b")], { b: cold() }))
      .toEqual({ sandboxId: "s", bindingId: "b", action: "kill", reason: "cold", deferred: false });
  });

  it("keeps S while B's row is Creating before its deadline: the creator may be producing S", () => {
    for (const since of [at(-2), at(-3).getTime() + 1, now.getTime()]) {
      expect(decisionOf([sandbox("s", "b")], { b: creating(new Date(since)) }))
        .toMatchObject({ action: "keep", reason: "creating" });
    }
  });

  describe("B's row is Creating after its deadline", () => {
    it("adopts S from the deadline on, and shortens it to 15 minutes when B has no user", () => {
      for (const since of [at(-3), at(-60), new Date(0)]) {
        expect(decisionOf([sandbox("s", "b")], { b: creating(since) }))
          .toEqual({ sandboxId: "s", bindingId: "b", action: "adopt", shorten: true });
      }
    });

    it("adopts without shortening when B is in use or S already has a short deadline", () => {
      expect(decisionOf([sandbox("s", "b")], { b: creating(new Date(0), { inUse: true }) }))
        .toMatchObject({ action: "adopt", shorten: false });
      expect(decisionOf([sandbox("s", "b", { endAt: at(10) })], { b: creating(new Date(0)) }))
        .toMatchObject({ action: "adopt", shorten: false });
    });

    it("adopts a Sandbox with no deadline without shortening; the Ready row decides it next round", () => {
      expect(decisionOf([sandbox("s", "b", { endAt: null })], { b: creating(new Date(0)) }))
        .toMatchObject({ action: "adopt", shorten: false });
    });

    it("adopts the earliest claimed of several Sandboxes, then the lowest id, whatever the listing order, and kills the others as duplicates", () => {
      const listed = [
        sandbox("c", "b", { startedAt: at(-30) }),
        sandbox("b2", "b", { startedAt: at(-60) }),
        sandbox("a", "b", { startedAt: at(-60) }),
      ];
      for (const order of [listed, [...listed].reverse()]) {
        const decisions = byId(sweep(order, { b: creating(new Date(0)) }).decisions);
        expect(decisions.a).toMatchObject({ action: "adopt", shorten: true });
        expect(decisions.b2).toMatchObject({ action: "kill", reason: "duplicate", deferred: false });
        expect(decisions.c).toMatchObject({ action: "kill", reason: "duplicate", deferred: false });
      }
    });
  });

  it("kills S when B has no row in this environment", () => {
    expect(decisionOf([sandbox("s", "b")], {}))
      .toEqual({ sandboxId: "s", bindingId: "b", action: "kill", reason: "no-row", deferred: false });
  });

  it("kills S when all of B's Sessions are terminated, whatever the row's state", () => {
    for (const row of [ready("s"), ready("other"), creating(at(-1)), creating(new Date(0)), cold()]) {
      expect(decisionOf([sandbox("s", "b")], { b: { ...row, allSessionsTerminated: true } }))
        .toMatchObject({ action: "kill", reason: "terminated" });
    }
  });

  it("leaves every Sandbox of a reclaiming binding to termination, which reclaims by binding", () => {
    const listed = [sandbox("s", "b"), sandbox("s2", "b", { endAt: null })];
    for (const allSessionsTerminated of [false, true]) {
      const { decisions } = sweep(listed, { b: ready("s", { reclaiming: true, allSessionsTerminated }) });
      expect(decisions.map((d) => [d.action, d.action === "keep" && d.reason])).toEqual([["keep", "reclaiming"], ["keep", "reclaiming"]]);
    }
  });
});

describe("environment isolation", () => {
  it("never acts on a Sandbox labelled with another environment, even when the binding has a row here", () => {
    const listed = [sandbox("t1", "b-test", { environment: "test" }), sandbox("t2", "b", { environment: "test" })];
    const { decisions, counts } = sweep(listed, { b: cold() });
    expect(decisions.map((d) => [d.sandboxId, d.action, d.action === "keep" && d.reason]))
      .toEqual([["t1", "keep", "other-environment"], ["t2", "keep", "other-environment"]]);
    expect(counts).toEqual({ orphans: 0, unresolved: 0, unusedRunning: 0, noDeadline: 0, killed: 0, adopted: 0 });
  });

  it("acts on the test environment's own Sandboxes and leaves production's alone", () => {
    const listed = [sandbox("p", "b-prod"), sandbox("t", "b-test", { environment: "test" })];
    const decisions = byId(sweep(listed, {}, { environment: "test" }).decisions);
    expect(decisions.p).toMatchObject({ action: "keep", reason: "other-environment" });
    expect(decisions.t).toMatchObject({ action: "kill", reason: "no-row" });
  });

  it("keeps a Sandbox labelled with this environment but no binding: it is outside the binding protocol", () => {
    expect(decisionOf([sandbox("probe", null)], {})).toEqual({ sandboxId: "probe", bindingId: null, action: "keep", reason: "unbound" });
  });
});

describe("unlabelled Sandboxes from before ADR-0023", () => {
  it("acts on one whose binding has a row in this environment's schema, by the same table", () => {
    const legacy = { environment: null };
    const decisions = byId(sweep([
      sandbox("ready-unused", "b1", legacy),
      sandbox("superseded", "b2", legacy),
      sandbox("cold", "b3", legacy),
      sandbox("unresolved", "b4", legacy),
      sandbox("terminated", "b5", legacy),
      sandbox("no-deadline", "b6", { ...legacy, endAt: null }),
    ], {
      b1: ready("ready-unused"), b2: ready("other"), b3: cold(), b4: creating(new Date(0)),
      b5: ready("terminated", { allSessionsTerminated: true }), b6: ready("no-deadline"),
    }).decisions);
    expect(decisions["ready-unused"].action).toBe("shorten");
    expect(decisions.superseded).toMatchObject({ action: "kill", reason: "superseded" });
    expect(decisions.cold).toMatchObject({ action: "kill", reason: "cold" });
    expect(decisions.unresolved).toMatchObject({ action: "adopt", shorten: true });
    expect(decisions.terminated).toMatchObject({ action: "kill", reason: "terminated" });
    expect(decisions["no-deadline"]).toMatchObject({ action: "kill", reason: "no-deadline" });
  });

  it("leaves one without a row here to its platform deadline, also when it has none or no binding label", () => {
    const listed = [
      sandbox("other-env", "b-elsewhere", { environment: null }),
      sandbox("forever", "b-elsewhere-2", { environment: null, endAt: null }),
      sandbox("anonymous", null, { environment: null }),
    ];
    const { decisions, counts } = sweep(listed, {});
    expect(decisions.map((d) => [d.sandboxId, d.action, d.action === "keep" && d.reason])).toEqual([
      ["other-env", "keep", "unlabelled"], ["forever", "keep", "unlabelled"], ["anonymous", "keep", "unlabelled"],
    ]);
    expect(counts.killed).toBe(0);
  });
});

describe("the kill cap", () => {
  const orphan = (i: number, shape: SandboxShape = {}) =>
    sandbox(`o${String(i).padStart(2, "0")}`, `gone-${i}`, { startedAt: at(-100 + i), ...shape });

  it("kills at most maxKills per round and reports the rest as deferred", () => {
    const listed = Array.from({ length: 60 }, (_, i) => orphan(i));
    const { decisions, counts } = sweep(listed, {});
    expect(decisions.filter((d) => d.action === "kill" && !d.deferred)).toHaveLength(50);
    expect(decisions.filter((d) => d.action === "kill" && d.deferred).map((d) => d.sandboxId))
      .toEqual(Array.from({ length: 10 }, (_, i) => `o${50 + i}`));
    expect(counts).toMatchObject({ orphans: 60, killed: 50 });
  });

  it("chooses the same kills in any listing order: no deadline first, then the earliest claimed", () => {
    const listed = [
      orphan(1),
      orphan(2),
      orphan(3),
      orphan(4),
      sandbox("nd-late", "b-nd-late", { endAt: null, startedAt: at(-5) }),
      sandbox("nd-early", "b-nd-early", { endAt: null, startedAt: at(-500) }),
      orphan(0),
    ];
    const bindings = { "b-nd-late": ready("nd-late"), "b-nd-early": ready("nd-early") };
    const killed = (order: ListedSandbox[]) => sweep(order, bindings, { maxKills: 4 }).decisions
      .filter((d) => d.action === "kill" && !d.deferred).map((d) => d.sandboxId).sort();
    expect(killed(listed)).toEqual(["nd-early", "nd-late", "o00", "o01"].sort());
    expect(killed([...listed].reverse())).toEqual(killed(listed));
    expect(sweep(listed, bindings, { maxKills: 0 }).counts).toMatchObject({ orphans: 5, noDeadline: 2, killed: 0 });
  });

  it("caps duplicates of an unresolved binding like other kills and still adopts one", () => {
    const listed = Array.from({ length: 4 }, (_, i) => sandbox(`d${i}`, "b", { startedAt: at(-10 + i) }));
    const decisions = byId(sweep(listed, { b: creating(new Date(0)) }, { maxKills: 2 }).decisions);
    expect(decisions.d0).toMatchObject({ action: "adopt" });
    expect([decisions.d1, decisions.d2, decisions.d3].map((d) => d.action === "kill" && d.deferred)).toEqual([false, false, true]);
  });
});

describe("one round", () => {
  it("gives one decision per Sandbox in listing order, also when a page boundary listed one twice", () => {
    const s = sandbox("s", "b");
    const { decisions } = sweep([s, sandbox("t", "gone"), s], { b: creating(new Date(0)) });
    expect(decisions.map((d) => [d.sandboxId, d.action])).toEqual([["s", "adopt"], ["t", "kill"]]);
  });

  it("counts what the sandbox_sweep log line reports", () => {
    const { counts } = sweep([
      sandbox("in-use", "b-in-use"),
      sandbox("idle", "b-idle"),
      sandbox("forever", "b-forever", { endAt: null }),
      sandbox("orphan", "b-gone"),
      sandbox("cold", "b-cold"),
      sandbox("adopted", "b-unresolved"),
      sandbox("duplicate", "b-unresolved"),
      sandbox("adopted-in-use", "b-unresolved-in-use"),
      sandbox("foreign", "b-test", { environment: "test" }),
    ], {
      "b-in-use": ready("in-use", { inUse: true }),
      "b-idle": ready("idle"),
      "b-forever": ready("forever"),
      "b-cold": cold(),
      "b-unresolved": creating(new Date(0)),
      "b-unresolved-in-use": creating(new Date(0), { inUse: true }),
    });
    expect(counts).toEqual({ orphans: 3, unresolved: 2, unusedRunning: 2, noDeadline: 1, killed: 4, adopted: 2 });
  });
});
