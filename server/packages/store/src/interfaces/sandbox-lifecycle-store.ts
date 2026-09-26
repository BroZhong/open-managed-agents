import type { PendingEventFence } from './pending-event-store.js';

export const SANDBOX_IDLE_MS = 30 * 60 * 1000;
export interface SandboxActivity {
  bindingId: string;
  sessionId: string;
  fence: PendingEventFence;
}
export interface SandboxReclamation { bindingId: string; sandboxId: string }
/** No activity expires. Only observed execution settlement releases its exact token. */
export interface SandboxLifecycleStore {
  /** false means a committed reclamation must finish before starting work. */
  begin(activity: SandboxActivity): Promise<boolean>;
  finish(activity: SandboxActivity): Promise<void>;
  /** Return every durable binding that currently owns a Sandbox. */
  listManagedBindings(): Promise<readonly string[]>;
  /** Atomically recheck all inputs and uses, then durably fence a deletion. */
  claimReclamation(bindingId: string, explicit?: boolean): Promise<SandboxReclamation | null>;
  completeReclamation(ticket: SandboxReclamation): Promise<void>;
}
