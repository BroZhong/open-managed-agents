import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { RunnerDemand } from "@oma-server/store";

/**
 * Outside API_BASE_PATH: the public Ingress routes only the prefix to the API,
 * so the demand is reachable through the in-cluster Service alone.
 */
export const RUNNER_DEMAND_PATH = "/internal/runner-demand";
/** The database timeout of one read, the pool checkout included (ADR-0026). */
export const RUNNER_DEMAND_TIMEOUT_MS = 5_000;
/** The token characters a Bearer credential carries (RFC 6750 b64token), as `bearerAuth` matches them. */
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

export interface RunnerDemandRoutesOptions {
  /** `RUNNER_DEMAND_TOKEN`, the Secret KEDA's TriggerAuthentication presents. Unset ⇒ not served. */
  token: string | undefined;
  reader: { read(timeoutMs: number): Promise<RunnerDemand> };
  timeoutMs?: number;
  log?: Pick<Console, "error">;
}

/**
 * The Runner demand KEDA's Metrics API scaler reads (ADR-0026): demand for the
 * Runners' Deployment to scale on, plus the counts it is made of. Each request
 * reads PostgreSQL afresh. A read that fails or times out answers 503, never
 * a demand of 0: KEDA counts the failure toward its fallback and keeps the
 * current replicas, where a 0 would scale the Runners down under load.
 *
 * Undefined without a token: an environment that has not provisioned the
 * Secret does not serve the demand at all. Nor does one whose token no
 * request can present, which would fail every scrape: it is logged, and the
 * API starts regardless, since KEDA keeps the replicas it has when the demand
 * is not served. A Secret's surrounding whitespace (a trailing newline) is
 * not part of the token.
 */
export function runnerDemandRoutes(options: RunnerDemandRoutesOptions): Hono | undefined {
  const { reader, timeoutMs = RUNNER_DEMAND_TIMEOUT_MS, log = console } = options;
  const token = options.token?.trim();
  if (!token) return undefined;
  if (!BEARER_TOKEN.test(token)) {
    log.error("RUNNER_DEMAND_TOKEN is not a Bearer token (letters, digits and -._~+/ only): the Runner demand is not served");
    return undefined;
  }
  const app = new Hono();
  app.get(RUNNER_DEMAND_PATH, bearerAuth({ token }), async (c) => {
    try {
      const { observedAt, ...counts } = await reader.read(timeoutMs);
      return c.json({ ...counts, observedAt: observedAt.toISOString() }, 200, { "cache-control": "no-store" });
    } catch (error) {
      console.error("Runner demand unavailable:", error instanceof Error ? error.message : error);
      return c.json({ error: "Runner demand unavailable" }, 503, { "cache-control": "no-store" });
    }
  });
  return app;
}
