import type { ServerType } from "@hono/node-server";

type ShutdownLogger = Pick<Console, "info" | "warn" | "error">;

export interface GracefulShutdownDeps {
  server: ServerType;
  /**
   * Hand every running Turn to the other Runners (#254): claiming stops at
   * once, and Turns still running after `timeoutMs` are detached. Resolves
   * once their claims are released, true when no Turn needed detaching.
   */
  handOff: (timeoutMs: number) => Promise<boolean>;
  /** Stop schedulers and scans so no new work is created. */
  stopBackgroundWork?: () => Promise<void>;
  /** Close durable/transient stores after no Turn can use them. */
  closeResources: () => Promise<void>;
  timeoutMs?: number;
  logger?: ShutdownLogger;
}

// Kubernetes commonly grants 30s before SIGKILL. Keep 10s in reserve for
// releasing the claims of Turns detached at the deadline, forced socket
// teardown and store/client cleanup.
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_HANDOFF_RELEASE_WAIT_MS = 5_000;
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
 * Ordering matters: `server.close` first refuses new HTTP connections; the
 * handoff stops claiming and asks running Turns to stop before background
 * producers stop, all within one shared grace deadline, at which Turns still
 * running are detached; only once their claims are released are remaining
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
      logger.info(`Received ${signal}; stopping HTTP and handing active Turns to other Runners`);
      const deadline = Date.now() + timeoutMs;
      const remainingMs = () => Math.max(0, deadline - Date.now());

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

      // First: from now on nothing is claimed, and each running Turn stops
      // before its next model request, while background work winds down.
      const handedOff = deps.handOff(remainingMs());
      // Observed below, after background work stops.
      handedOff.catch(() => {});

      if (deps.stopBackgroundWork) {
        let stopped = false;
        try {
          stopped = await bounded(
            deps.stopBackgroundWork().then(() => true),
            remainingMs(),
            false,
          );
        } catch (error) {
          logger.error("Failed to stop background work:", error);
          stopped = true;
        }
        if (!stopped) {
          logger.warn(
            `Graceful shutdown timed out stopping background work after ${timeoutMs}ms`,
          );
        }
      }

      let handoff: boolean | "timeout" = "timeout";
      try {
        handoff = await bounded<boolean | "timeout">(
          handedOff,
          remainingMs() + MAX_HANDOFF_RELEASE_WAIT_MS,
          "timeout",
        );
      } catch (error) {
        logger.error("Failed while handing active Turns over:", error);
      }
      if (handoff === "timeout") {
        logger.warn(
          `Graceful shutdown timed out handing active Turns over after ${timeoutMs}ms`,
        );
      } else if (!handoff) {
        logger.warn(
          `Graceful shutdown detached the Turns still running after ${timeoutMs}ms`,
        );
      }

      // `/events` SSE subscriptions can intentionally remain open while idle;
      // terminate them only after Turns have been handed over.
      const forceClosable = deps.server as ServerType & {
        closeAllConnections?: () => void;
      };
      forceClosable.closeAllConnections?.();
      await bounded(
        serverClosed,
        Math.min(remainingMs(), MAX_HTTP_CLOSE_WAIT_MS),
        false,
      );

      await deps.closeResources();
    })();

    return shutdownPromise;
  };
}
