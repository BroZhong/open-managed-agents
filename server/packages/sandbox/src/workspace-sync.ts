import { createHash } from "node:crypto";

/**
 * Result of one workspace sync-back (ADR-0002 §4). Reports which
 * workspace-relative paths were pushed to / deleted from the S3 Workspace so
 * the Host can emit a single `workspace.file_change` event.
 */
export interface WorkspaceSyncResult {
  /** Tenant that owns the synced Workspace. */
  tenantId: string;
  /** The Workspace that was synced. */
  workspaceId: string;
  /** Workspace-relative paths pushed to S3 (new or content-changed). */
  changed: string[];
  /** Workspace-relative paths deleted from S3 (baseline-diff deletion). */
  deleted: string[];
}

/** True when the sync touched S3 at all (a delta the Host should announce). */
export function syncHasChanges(result: WorkspaceSyncResult): boolean {
  return result.changed.length > 0 || result.deleted.length > 0;
}

/**
 * Content hash used for the sync's change comparison. We hash **content**, not
 * size, so a same-size edit (e.g. flipping one byte) is still detected and
 * pushed — the acceptance criterion the size-only approach would miss.
 */
export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
