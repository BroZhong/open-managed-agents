import type { SandboxBinding } from "./sandbox-manager.js";

/**
 * The binding's `sandbox` hint (ADR-0023): its row left Creating, for
 * Ready or Cold, or its reclamation finished. A Turn waiting for either reads
 * the row again when the hint arrives and every {@link BINDING_REREAD_MS}
 * regardless, and acts on the row alone: a lost or late hint costs a wait at
 * most one period, and the intent deadline still bounds it.
 */
export interface SandboxSignals {
  /** Tell every Runner's waiters, once the change committed. */
  publish(bindingId: string): void;
  /** Hear of every binding's changes until the returned function is called. */
  subscribe(listener: (bindingId: string) => void): () => void;
}

/** How often a Turn waiting for its binding reads the row without a hint. */
export const BINDING_REREAD_MS = 2000;

/** What node:timers/promises rejects an aborted timer with: an AbortError caused by the signal's reason. */
const abortedWait = (signal: AbortSignal) =>
  Object.assign(new Error("The operation was aborted", { cause: signal.reason }), { name: "AbortError", code: "ABORT_ERR" });

/**
 * One waiter's hints for one binding, heard from before its first read of the
 * row: a change committed after a read ends the wait that read decided, even
 * when its hint arrived before the wait began.
 */
export class BindingChanges {
  private changed = false;
  private wake?: () => void;
  private readonly unsubscribe: () => void;
  constructor(signals: SandboxSignals | undefined, bindingId: string) {
    this.unsubscribe = signals?.subscribe((id) => {
      if (id !== bindingId) return;
      this.changed = true;
      this.wake?.();
    }) ?? (() => {});
  }
  /**
   * Resolve once the binding changed since the last wait ended, or after
   * `ms`; once `signal` aborts, reject as an aborted timer does, its reason
   * the cause.
   */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortedWait(signal));
    if (this.changed) {
      this.changed = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const end = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.wake = undefined;
        this.changed = false;
      };
      const aborted = () => { end(); reject(abortedWait(signal!)); };
      const timer = setTimeout(() => { end(); resolve(); }, ms);
      this.wake = () => { end(); resolve(); };
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }
  close(): void {
    this.wake = undefined;
    this.unsubscribe();
  }
}

/**
 * `binding`, whose every committed move out of Creating (the creator's
 * Ready, a reconciler's Ready or Cold, a failed create's Cold) tells the
 * binding's waiters on every Runner. A move that lost its compare-and-set
 * rejects and tells no one.
 */
export function signallingBinding(binding: SandboxBinding, signals: SandboxSignals | undefined): SandboxBinding {
  if (!signals) return binding;
  return {
    ...binding,
    withLock: async (work) => {
      let leftCreating = false;
      const value = await binding.withLock(async (row) => {
        const result = await work(row);
        leftCreating = row.creatingSince !== null && result.next !== undefined && result.next !== "creating";
        return result;
      });
      if (leftCreating) signals.publish(binding.id);
      return value;
    },
  };
}
