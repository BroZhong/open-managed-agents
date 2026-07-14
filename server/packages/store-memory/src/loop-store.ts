import type {
  AgentStore,
  Loop,
  LoopDispatch,
  LoopStore,
  LoopStoreCreateInput,
  LoopStoreUpdateInput,
  PendingEventIngressStore,
} from "@oma-server/store";
import type { InMemorySessionStore } from "./session-store.js";
import type { InMemoryWorkspaceMetadataStore } from "./workspace-metadata-store.js";

function validateInterval(intervalMinutes: number): void {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5) {
    throw new RangeError("Loop intervalMinutes must be an integer of at least 5");
  }
}

function nextRun(now: Date, intervalMinutes: number): Date {
  return new Date(now.getTime() + intervalMinutes * 60_000);
}

export class InMemoryLoopStore implements LoopStore {
  private readonly loops: Loop[] = [];
  private nextId = 1;
  private dispatchQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentStore: AgentStore,
    private readonly sessionStore: InMemorySessionStore,
    private readonly workspaceStore: InMemoryWorkspaceMetadataStore,
    private readonly pendingEventStore: PendingEventIngressStore,
  ) {}

  async create(input: LoopStoreCreateInput): Promise<Loop> {
    validateInterval(input.intervalMinutes);
    const loop: Loop = {
      id: `loop_${this.nextId++}`,
      tenantId: input.tenantId,
      agentId: input.agentId,
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled,
      nextRunAt: nextRun(input.now, input.intervalMinutes),
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    };
    this.loops.push(loop);
    return loop;
  }

  async getById(id: string): Promise<Loop | null> {
    return this.loops.find((loop) => loop.id === id) ?? null;
  }

  async list(tenantId: string, agentId: string): Promise<Loop[]> {
    return this.loops.filter(
      (loop) => loop.tenantId === tenantId && loop.agentId === agentId,
    );
  }

  async update(
    id: string,
    tenantId: string,
    input: LoopStoreUpdateInput,
  ): Promise<Loop | null> {
    if (input.intervalMinutes !== undefined) validateInterval(input.intervalMinutes);
    return this.withDispatchLock(async () => {
      const loop = this.loops.find(
        (candidate) => candidate.id === id && candidate.tenantId === tenantId,
      );
      if (!loop) return null;
      const wasEnabled = loop.enabled;
      if (input.name !== undefined) loop.name = input.name;
      if (input.description !== undefined) loop.description = input.description;
      if (input.prompt !== undefined) loop.prompt = input.prompt;
      if (input.intervalMinutes !== undefined) loop.intervalMinutes = input.intervalMinutes;
      if (input.enabled !== undefined) loop.enabled = input.enabled;
      if (input.intervalMinutes !== undefined || (input.enabled === true && !wasEnabled)) {
        loop.nextRunAt = nextRun(input.now, loop.intervalMinutes);
      }
      loop.updatedAt = new Date(input.now);
      return loop;
    });
  }

  dispatchDue(now: Date, limit: number): Promise<LoopDispatch[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      return Promise.reject(new RangeError("Loop dispatch limit must be a positive integer"));
    }
    return this.withDispatchLock(async () => {
      const due = this.loops
        .filter((loop) => loop.enabled && loop.nextRunAt <= now)
        .sort((a, b) =>
          a.nextRunAt.getTime() - b.nextRunAt.getTime() ||
          a.id.localeCompare(b.id))
        .slice(0, limit);
      const snapshots = due.map((loop) => structuredClone(loop));
      const dispatched: LoopDispatch[] = [];
      try {
        for (const loop of due) {
          const result = await this.dispatch(loop, now);
          if (!result) continue;
          loop.lastRunAt = new Date(now);
          loop.nextRunAt = nextRun(now, loop.intervalMinutes);
          loop.updatedAt = new Date(now);
          result.loop = loop;
          dispatched.push(result);
        }
        return dispatched;
      } catch (error) {
        for (const result of dispatched.reverse()) {
          await this.rollbackDispatch(
            result.session.tenantId,
            result.session.id,
            result.session.workspaceId,
          );
        }
        for (const snapshot of snapshots) {
          const target = this.loops.find((loop) => loop.id === snapshot.id);
          if (!target) continue;
          Object.assign(target, snapshot);
          if (snapshot.description === undefined) delete target.description;
          if (snapshot.lastRunAt === undefined) delete target.lastRunAt;
        }
        throw error;
      }
    });
  }

  dispatchNow(id: string, tenantId: string, now: Date): Promise<LoopDispatch | null> {
    return this.withDispatchLock(async () => {
      const loop = this.loops.find(
        (candidate) => candidate.id === id && candidate.tenantId === tenantId,
      );
      return loop ? this.dispatch(loop, now) : null;
    });
  }

  private async dispatch(loop: Loop, now: Date): Promise<LoopDispatch | null> {
    const agent = await this.agentStore.getById(loop.agentId);
    if (!agent || agent.tenantId !== loop.tenantId) {
      loop.enabled = false;
      loop.updatedAt = new Date(now);
      return null;
    }
    const workspace = await this.workspaceStore.create({ tenantId: loop.tenantId });
    let sessionId: string | undefined;
    try {
      const session = await this.sessionStore.create({
        tenantId: loop.tenantId,
        agentId: loop.agentId,
        agent,
        workspaceId: workspace.id,
        loopId: loop.id,
      });
      sessionId = session.id;
      const titled = await this.sessionStore.setTitle(session.id, loop.name);
      if (!titled) throw new Error(`Loop dispatch Session ${session.id} disappeared`);
      await this.pendingEventStore.enqueue(session.id, {
        type: "user.message",
        data: { content: [{ type: "text", text: loop.prompt }] },
        sessionThreadId: "sthr_primary",
      });
      const committed = await this.sessionStore.getById(session.id);
      if (!committed) throw new Error(`Loop dispatch Session ${session.id} disappeared`);
      return { loop, session: committed };
    } catch (error) {
      // These stores are process-local and dispatches are serialized by
      // withDispatchLock, so reverse-order compensation restores the state the
      // caller observed before this dispatch attempt.
      if (sessionId) {
        await this.rollbackDispatch(loop.tenantId, sessionId, workspace.id);
      } else {
        await this.workspaceStore.delete(loop.tenantId, workspace.id);
      }
      throw error;
    }
  }

  private async rollbackDispatch(
    tenantId: string,
    sessionId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.pendingEventStore.clear(sessionId);
    await this.sessionStore.delete(sessionId);
    await this.workspaceStore.delete(tenantId, workspaceId);
  }

  private withDispatchLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.dispatchQueue.then(work, work);
    this.dispatchQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
