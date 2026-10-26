import { SandboxBindingChanged, type SandboxBindingRow, type BindingLockResult, type InstalledSkillSet } from "@oma-server/store";
import type { SandboxBinding } from "../src/sandbox-manager.js";
import type { SandboxSignals } from "../src/sandbox-signals.js";

/**
 * A binding row (ADR-0023): Ready while `sandboxId` is set, Creating while
 * `creatingSince` is; what the Sandbox was created with (ADR-0024) is set with it.
 */
export type BindingRow = Omit<SandboxBindingRow, "now">;

/** A controllable database clock. */
export function databaseClock(start = new Date("2026-10-22T13:20:00Z")) {
  let now = start.getTime();
  return { now: () => new Date(now), elapse: (seconds: number) => { now += seconds * 1000; }, set: (to: Date) => { now = to.getTime(); } };
}

/**
 * A durable binding row and its Skill Install record, as the stores keep
 * them: callers serialized, moves applied by compare-and-set, intents written
 * with the database clock `clock`.
 */
export function durableBinding(id = "root", clock: () => Date = () => new Date()) {
  let row: BindingRow = { sandboxId: null, environmentId: null, image: null, creatingSince: null };
  let installed: InstalledSkillSet | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const binding = {
    id,
    withLock<T>(work: (binding: SandboxBindingRow) => Promise<BindingLockResult<T>>): Promise<T> {
      const result = queue.then(async () => {
        const read = row;
        const { value, next } = await work({ ...read, now: clock() });
        // A write committed elsewhere while `work` ran fails the move.
        if (row !== read) throw new SandboxBindingChanged(id);
        if (next) {
          const ready = typeof next === "object" ? next : undefined;
          row = { sandboxId: ready?.ready ?? null, environmentId: ready?.environmentId ?? null, image: ready?.image ?? null,
            creatingSince: next === "creating" ? clock() : null };
        }
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
    installedSkills: async () => installed,
    recordSkillsInstalled: async (next: InstalledSkillSet) => {
      if (next.sandboxId !== row.sandboxId) return "detached" as const;
      if (installed?.sandboxId === next.sandboxId && installed.generation >= next.generation) return "superseded" as const;
      installed = next;
      return "recorded" as const;
    },
    forgetSkills: () => { installed = null; },
    installed: () => installed,
    row: () => row,
    /** A write committed elsewhere: another Runner, a reclamation, a migration. */
    write: (next: Pick<BindingRow, "sandboxId" | "creatingSince"> & Partial<BindingRow>) => {
      row = Object.assign(next, { environmentId: next.environmentId ?? null, image: next.image ?? null });
    },
  };
  return binding satisfies SandboxBinding;
}

/**
 * The `sandbox` hints of Runners sharing one Redis: every subscriber, the
 * publisher's own Runner included, hears each publish a moment later. While
 * `losing`, hints are published and never delivered.
 */
export function signalBus() {
  const listeners = new Set<(bindingId: string) => void>();
  const bus = {
    losing: false,
    published: [] as string[],
    publish(bindingId: string) {
      bus.published.push(bindingId);
      if (!bus.losing) queueMicrotask(() => { for (const listener of [...listeners]) listener(bindingId); });
    },
    subscribe(listener: (bindingId: string) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribers: () => listeners.size,
  };
  return bus satisfies SandboxSignals;
}
