import { EnvironmentBindingChanged, type EnvironmentBinding, type EnvironmentLockResult, type InstalledSkillSet } from "@oma-server/store";
import type { SandboxEnvironmentBinding } from "../src/sandbox-manager.js";

/** A binding row (ADR-0023): Ready while `sandboxId` is set, Creating while `creatingSince` is. */
export interface BindingRow { sandboxId: string | null; creatingSince: Date | null }

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
  let row: BindingRow = { sandboxId: null, creatingSince: null };
  let installed: InstalledSkillSet | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const binding = {
    id,
    withLock<T>(work: (binding: EnvironmentBinding) => Promise<EnvironmentLockResult<T>>): Promise<T> {
      const result = queue.then(async () => {
        const read = row;
        const { value, next } = await work({ ...read, now: clock() });
        // A write committed elsewhere while `work` ran fails the move.
        if (row !== read) throw new EnvironmentBindingChanged(id);
        if (next) row = next === "creating" ? { sandboxId: null, creatingSince: clock() } : { sandboxId: next === "cold" ? null : next.ready, creatingSince: null };
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
    write: (next: BindingRow) => { row = next; },
  };
  return binding satisfies SandboxEnvironmentBinding;
}
