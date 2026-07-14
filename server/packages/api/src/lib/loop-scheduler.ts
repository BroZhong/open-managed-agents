import type { LoopStore } from "@oma-server/store";
import type { SessionRouter } from "@oma-server/session-router";

type SchedulerLogger = Pick<Console, "error">;

export interface LoopSchedulerDeps {
  loopStore: LoopStore;
  sessionRouter: SessionRouter;
  now?: () => Date;
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: SchedulerLogger;
}

/**
 * Thin poller around LoopStore's transactional dispatch boundary. The store
 * commits every Session + pending Turn before this class asks SessionRouter to
 * recover retained input. Scanning on every tick also covers an ambiguous
 * commit response or a previous routing failure without a second dispatch.
 */
export class LoopScheduler {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly logger: SchedulerLogger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;

  constructor(private readonly deps: LoopSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollIntervalMs = deps.pollIntervalMs ?? 15_000;
    this.batchSize = deps.batchSize ?? 25;
    this.logger = deps.logger ?? console;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new RangeError("Loop scheduler pollIntervalMs must be positive");
    }
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1) {
      throw new RangeError("Loop scheduler batchSize must be a positive integer");
    }
  }

  runDue(at: Date = this.now()): Promise<number> {
    if (this.inFlight) return this.inFlight;
    const work = this.dispatch(at);
    this.inFlight = work;
    const clear = () => {
      if (this.inFlight === work) this.inFlight = undefined;
    };
    // Handle both outcomes on this derived branch. `finally()` would create a
    // second rejecting Promise and can surface an unhandled rejection even
    // when the tick caller correctly catches the original `work` Promise.
    void work.then(clear, clear);
    return work;
  }

  start(): void {
    if (this.timer) return;
    void this.runDue().catch((error) => this.logger.error("Loop scheduler tick failed:", error));
    this.timer = setInterval(() => {
      void this.runDue().catch((error) => this.logger.error("Loop scheduler tick failed:", error));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  private async dispatch(at: Date): Promise<number> {
    let dispatchedCount = 0;
    let dispatchFailed = false;
    let dispatchError: unknown;
    try {
      dispatchedCount = (await this.deps.loopStore.dispatchDue(at, this.batchSize)).length;
    } catch (error) {
      // A database/client error does not prove the transaction rolled back. A
      // committed occurrence is discoverable through its retained pending
      // input, so always run the recovery scan before surfacing the tick error.
      dispatchFailed = true;
      dispatchError = error;
    }

    try {
      await this.deps.sessionRouter.recoverPendingEvents(({ sessionId, error }) => {
        this.logger.error(
          `SessionRouter failed while recovering retained Session ${sessionId}:`,
          error,
        );
      });
    } catch (error) {
      if (dispatchFailed) {
        this.logger.error("Loop pending recovery scan failed after dispatch failure:", error);
      } else {
        throw error;
      }
    }

    if (dispatchFailed) throw dispatchError;
    return dispatchedCount;
  }
}
