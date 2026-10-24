import type { EnvironmentBinding } from './delegation-store.js';
import type { PendingEventFence } from './pending-event-store.js';

/** A Turn's business execution identity, not an independent resource lease. */
export interface SandboxActivity {
  bindingId: string;
  sessionId: string;
  fence: PendingEventFence;
}
/**
 * A committed explicit reclamation (ADR-0023, "Release and reclamation"): the
 * binding row as it was claimed, `now` read at the claim. Until it completes
 * the binding admits no Turn and no environment transaction, so its Sandbox
 * and creation intent stay as claimed. Every Sandbox the gateway lists for the
 * binding is the reclamation's, whatever the row records: a binding without a
 * Sandbox can still have one a lost create left.
 */
export interface SandboxReclamation extends EnvironmentBinding { bindingId: string }
export interface SandboxLifecycleStore {
  /** false means committed explicit deletion must finish before admission. */
  begin(activity: SandboxActivity): Promise<boolean>;
  /** Only observed settlement can attempt idle; callback runs inside the binding lock. */
  finish(activity: SandboxActivity, idle?: (sandboxId: string) => Promise<void>): Promise<void>;
  /**
   * Explicit termination only, after rechecking shared business users and
   * inputs: null while a non-terminated Session uses the binding or has input
   * queued. A committed reclamation is claimed again with `now` read anew.
   */
  claimReclamation(bindingId: string): Promise<SandboxReclamation | null>;
  /**
   * Clear the binding to Cold once its Sandboxes are confirmed missing. Only
   * for the reclamation `ticket` claimed: an old callback cannot clear a
   * binding that moved on after it.
   */
  completeReclamation(ticket: SandboxReclamation): Promise<void>;
}
