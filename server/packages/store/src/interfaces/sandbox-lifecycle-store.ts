import type { PendingEventFence } from './pending-event-store.js';

/** A Turn's business execution identity, not an independent resource lease. */
export interface SandboxActivity {
  bindingId: string;
  sessionId: string;
  fence: PendingEventFence;
}
export interface SandboxReclamation { bindingId: string; sandboxId: string }
export interface SandboxLifecycleStore {
  /** false means committed explicit deletion must finish before admission. */
  begin(activity: SandboxActivity): Promise<boolean>;
  /** Only observed settlement can attempt idle; callback runs inside the binding lock. */
  finish(activity: SandboxActivity, idle?: (sandboxId: string) => Promise<void>): Promise<void>;
  /** Explicit termination only, after rechecking shared business users and inputs. */
  claimReclamation(bindingId: string): Promise<SandboxReclamation | null>;
  completeReclamation(ticket: SandboxReclamation): Promise<void>;
}
