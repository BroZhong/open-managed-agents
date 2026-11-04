import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { createPgStores, PgRunnerDemandStore, type RunnerDemand } from "@oma-server/store";
import { createApp } from "../src/app.js";
import { RUNNER_DEMAND_PATH, runnerDemandRoutes } from "../src/lib/runner-demand.js";
import type { ApiKeyStore } from "../src/types.js";
import { createPgTestHarness, type PgTestHarness } from "../../store/test/pg-harness.js";

/**
 * The internal endpoint KEDA's Metrics API scaler reads the Runner demand
 * from (ADR-0026). A failed read must reach KEDA as a failure: a zero would
 * scale the Runners down under load.
 */
const token = "demand-token_0123456789";
const auth = { authorization: `Bearer ${token}` };
const observedAt = new Date("2026-11-05T00:00:00.000Z");
const reading: RunnerDemand = { demand: 7, executing: 4, syncWaiting: 2, ready: 3, observedAt };
const reader = (read: () => Promise<RunnerDemand> = async () => reading) => {
  const calls: number[] = [];
  return { calls, read: (timeoutMs: number) => { calls.push(timeoutMs); return read(); } };
};
const noKeys: ApiKeyStore = { findByKeyHash: async () => null };

/** The API process as bootstrap composes it: the demand ahead of the console routes. */
function apiProcess(demand: Hono | undefined): Hono {
  const app = new Hono();
  if (demand) app.route("/", demand);
  app.route("/", createApp({ apiKeyStore: noKeys }));
  return app;
}

describe("GET /internal/runner-demand", () => {
  const originalBasePath = process.env.API_BASE_PATH;
  afterEach(() => {
    if (originalBasePath === undefined) delete process.env.API_BASE_PATH;
    else process.env.API_BASE_PATH = originalBasePath;
  });

  it("serves the demand read afresh for each request, with its bearer token", async () => {
    const store = reader();
    const app = runnerDemandRoutes({ token, reader: store })!;
    for (let i = 0; i < 2; i++) {
      const res = await app.request(RUNNER_DEMAND_PATH, { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ demand: 7, executing: 4, syncWaiting: 2, ready: 3, observedAt: "2026-11-05T00:00:00.000Z" });
    }
    expect(store.calls).toEqual([5_000, 5_000]);
  });

  it("refuses a request without the token or with another one, unread", async () => {
    const store = reader();
    const app = runnerDemandRoutes({ token, reader: store })!;
    expect((await app.request(RUNNER_DEMAND_PATH)).status).toBe(401);
    expect((await app.request(RUNNER_DEMAND_PATH, { headers: { authorization: "Bearer another-token" } })).status).toBe(401);
    expect(store.calls).toEqual([]);
  });

  it("answers 503, never a zero demand, when the read fails", async () => {
    const app = runnerDemandRoutes({ token, reader: reader(async () => { throw new Error("connection terminated"); }) })!;
    const res = await app.request(RUNNER_DEMAND_PATH, { headers: auth });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "Runner demand unavailable" });
    expect(body).not.toHaveProperty("demand");
  });

  it("is not served at all without RUNNER_DEMAND_TOKEN", async () => {
    for (const unset of [undefined, ""]) {
      expect(runnerDemandRoutes({ token: unset, reader: reader() })).toBeUndefined();
    }
    delete process.env.API_BASE_PATH;
    expect((await apiProcess(undefined).request(RUNNER_DEMAND_PATH, { headers: auth })).status).toBe(404);
  });

  it("refuses at startup a token Bearer authentication cannot carry", () => {
    expect(() => runnerDemandRoutes({ token: "two words", reader: reader() })).toThrow(/RUNNER_DEMAND_TOKEN/);
  });

  it("is reachable only outside the public API prefix", async () => {
    process.env.API_BASE_PATH = "/api";
    const app = apiProcess(runnerDemandRoutes({ token, reader: reader() }));
    expect((await app.request(`/api${RUNNER_DEMAND_PATH}`, { headers: auth })).status).toBe(404);
    expect((await app.request(RUNNER_DEMAND_PATH, { headers: auth })).status).toBe(200);
    // The console routes are unaffected.
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("precedes the console middleware when the API has no prefix", async () => {
    delete process.env.API_BASE_PATH;
    const app = apiProcess(runnerDemandRoutes({ token, reader: reader() }));
    expect((await app.request(RUNNER_DEMAND_PATH, { headers: auth })).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);
  });
});

describe.skipIf(!process.env.PG_TEST_URL)("GET /internal/runner-demand on real PostgreSQL", () => {
  let harness: PgTestHarness;
  beforeEach(async () => {
    if (!harness) harness = await createPgTestHarness(); else await harness.reset();
  });
  afterAll(async () => { await harness?.close(); });

  it("reads the queue, and answers 503 once a stalled read passes its timeout", async () => {
    const stores = await createPgStores(harness.pool, { ensureSchema: false });
    const agent = await stores.agentStore.create({ tenantId: "tenant", name: "agent", system: "", model: "model", runtime: "pi-agent" });
    const session = await stores.sessionStore.create({ tenantId: "tenant", agentId: agent.id, agent, workspaceId: "workspace" });
    await stores.pendingEventStore.enqueue(session.id, { type: "user.message", data: {}, sessionThreadId: "sthr_primary" });
    const app = runnerDemandRoutes({ token, reader: new PgRunnerDemandStore(harness.pool), timeoutMs: 300 })!;

    const res = await app.request(RUNNER_DEMAND_PATH, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ demand: 1, executing: 0, syncWaiting: 0, ready: 1 });

    const locker = await harness.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE pending_events IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      expect((await app.request(RUNNER_DEMAND_PATH, { headers: auth })).status).toBe(503);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });
});
