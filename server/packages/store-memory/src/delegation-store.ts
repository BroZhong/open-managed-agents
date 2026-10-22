import { TransactionalDelegationStore, delegationFenceLost, type DelegationTransaction, type DelegationRecord, type DelegationTable, type WorkspaceMetadataStore } from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";
import type { InMemoryPendingEventStore } from "./pending-event-store.js";
import type { InMemoryEventLogStore } from "./event-log-store.js";

export class InMemoryDelegationStore extends TransactionalDelegationStore {
  private records = new Map<DelegationTable, Map<string, DelegationRecord>>();
  private queue: Promise<void> = Promise.resolve();
  private environments = new Map<string, string | null>();
  private creationPending = new Map<string, boolean>();
  private environmentQueue: Promise<void> = Promise.resolve();
  constructor(private readonly sessions: InMemorySessionStore, private readonly pending: InMemoryPendingEventStore, private readonly events: InMemoryEventLogStore, private readonly workspaces: Pick<WorkspaceMetadataStore, "getById">) { super(); }
  protected transaction<T>(work: (tx: DelegationTransaction) => Promise<T>): Promise<T> {
    const perform = async () => {
      const snapshot = { records: structuredClone(this.records), sessions: this.sessions.snapshotState(), pending: this.pending.snapshotState(), events: this.events.snapshotState() };
      // A rollback restores the stores as the transaction found them, which
      // also undoes whatever others wrote while it ran: a claim taken, an
      // input queued, a lease that lapsed. Only a transaction that wrote has
      // anything to undo; one that failed its fence first restores nothing.
      let wrote = false;
      const writing = <A extends unknown[], R>(write: (...args: A) => R) => (...args: A): R => { wrote = true; return write(...args); };
      const pending = new Proxy(this.pending, { get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        const method = (value as (...args: unknown[]) => unknown).bind(target);
        return property === "ownsClaim" ? method : writing(method);
      } });
      const tx: DelegationTransaction = {
        sessions: { create: writing((input) => this.sessions.create(input)), getById: (id) => this.sessions.getById(id) },
        pending,
        read: async <R extends DelegationRecord>(table: DelegationTable, filters: Record<string, string> = {}) => [...(this.records.get(table)?.values() ?? [])].filter((record) => Object.entries(filters).every(([key, value]) => (record as unknown as Record<string, unknown>)[key] === value)).map((record) => structuredClone(record) as R),
        put: writing(async (table, id, record) => { const values = this.records.get(table) ?? new Map(); values.set(id, structuredClone(record)); this.records.set(table, values); }),
        remove: writing(async (table, id) => { this.records.get(table)?.delete(id); }),
        removePending: writing((sessionId, eventId, onlyUnclaimed) => this.pending.removeById(sessionId, eventId, onlyUnclaimed)),
        append: writing((sessionId, event) => this.events.append(sessionId, event)),
        assertWorkspaceNotDeleted: async (tenantId, workspaceId) => {
          if ((await this.workspaces.getById(tenantId, workspaceId))?.deletedAt) throw new Error("Workspace has been deleted");
        },
        assertFence: async (sessionId, fence) => { const session = await this.sessions.getById(sessionId); if (!session || session.status === "terminated" || !await this.pending.ownsClaim(sessionId, fence.eventId, fence)) delegationFenceLost(sessionId, fence); },
      };
      try { return await work(tx); }
      catch (error) {
        if (wrote) { this.records = snapshot.records; this.sessions.restoreState(snapshot.sessions); this.pending.restoreState(snapshot.pending); this.events.restoreState(snapshot.events); }
        throw error;
      }
    };
    const result = this.queue.then(perform, perform);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  withEnvironmentLock<T>(bindingId: string, work: (sandboxId: string | null, creationPending?: boolean) => Promise<{ sandboxId: string | null; creationPending?: boolean; value: T }>): Promise<T> {
    const perform = async () => { const result = await work(this.environments.get(bindingId) ?? null, this.creationPending.get(bindingId) ?? false); this.environments.set(bindingId, result.sandboxId);
      if (result.creationPending !== undefined) this.creationPending.set(bindingId, result.creationPending); return result.value; };
    const result = this.environmentQueue.then(perform, perform);
    this.environmentQueue = result.then(() => {}, () => {});
    return result;
  }
}
export { InMemoryDelegationStore as MemoryDelegationStore };
