import type { Loop, LoopDispatch } from "../types.js";

export interface LoopStoreCreateInput {
  tenantId: string;
  agentId: string;
  name: string;
  description?: string;
  prompt: string;
  intervalMinutes: number;
  enabled: boolean;
  now: Date;
}

export interface LoopStoreUpdateInput {
  name?: string;
  description?: string;
  prompt?: string;
  intervalMinutes?: number;
  enabled?: boolean;
  now: Date;
}

export interface LoopStore {
  create(input: LoopStoreCreateInput): Promise<Loop>;
  getById(id: string): Promise<Loop | null>;
  list(tenantId: string, agentId: string): Promise<Loop[]>;
  /** Update one tenant-owned Loop under the same boundary used to read it. */
  update(
    id: string,
    tenantId: string,
    input: LoopStoreUpdateInput,
  ): Promise<Loop | null>;
  /**
   * Atomically claims due Loops and, for each, creates a Workspace, linked
   * Session, and first pending user Turn before advancing its schedule.
   */
  dispatchDue(now: Date, limit: number): Promise<LoopDispatch[]>;
  /** Create one Session immediately without changing the recurring cadence. */
  dispatchNow(id: string, tenantId: string, now: Date): Promise<LoopDispatch | null>;
}
