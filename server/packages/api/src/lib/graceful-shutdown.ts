import type { ServerType } from "@hono/node-server";

type ShutdownLogger = Pick<Console, "info" | "warn" | "error">;

export interface GracefulShutdownDeps {
  server: ServerType;
  /** Returns true when every active Session drainer has settled. */
  waitForIdle: (timeoutMs: number) => Promise<boolean>;
  /** Close durable/transient stores after no Turn can use them. */
  closeResources: () => Promise<void>;
  timeoutMs?: number;
  logger?: ShutdownLogger;
}

// Kubernetes commonly grants 30s before SIGKILL. Keep 10s in reserve for
// forced socket teardown and store/client cleanup after active Turns drain.
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_HTTP_CLOSE_WAIT_MS = 5_000;

function bounded<T>(promise: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(timeoutValue), timeoutMs);
    void promise.then(finish, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Build one idempotent signal handler lifecycle.
 *
 * Ordering matters: `server.close` first refuses new HTTP connections; active
 * Session Turns then get a bounded grace period; only after that are remaining
 * sockets forced closed and PostgreSQL/Redis resources released.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("shutdown timeoutMs must be a finite non-negative number");
  }
  const logger = deps.logger ?? console;
  let shutdownPromise: Promise<void> | undefined;

  return (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info(`Received ${signal}; stopping HTTP and draining active Turns`);

      // Calling close immediately stops the listener from accepting new work.
      // The callback may wait for long-lived SSE connections, so it is not the
      // gate for draining the router.
      const serverClosed = new Promise<boolean>((resolve) => {
        try {
          deps.server.close(() => resolve(true));
        } catch (error) {
          logger.error("Failed to stop HTTP listener:", error);
          resolve(false);
        }
      });

      let drained = false;
      try {
        drained = await bounded(deps.waitForIdle(timeoutMs), timeoutMs, false);
      } catch (error) {
        logger.error("Failed while waiting for active Turns to drain:", error);
      }
      if (!drained) {
        logger.warn(
          `Graceful shutdown timed out waiting for active Turns after ${timeoutMs}ms`,
        );
      }

      // `/events` SSE subscriptions can intentionally remain open while idle;
      // terminate them only after Turns have drained (or exhausted their grace).
      const forceClosable = deps.server as ServerType & {
        closeAllConnections?: () => void;
      };
      forceClosable.closeAllConnections?.();
      await bounded(serverClosed, Math.min(timeoutMs, MAX_HTTP_CLOSE_WAIT_MS), false);

      await deps.closeResources();
    })();

    return shutdownPromise;
  };
}
