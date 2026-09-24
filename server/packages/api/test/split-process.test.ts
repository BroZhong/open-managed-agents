import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgPool, createPgStores, PgSandboxLifecycleStore, type PgStores, type Pool } from "@oma-server/store";

// Explicit opt-in, guarded before any DDL. Never use PG_URL from a developer shell.
const pgUrl = process.env.SPLIT_TEST_PG_URL;
const redisUrl = process.env.SPLIT_TEST_REDIS_URL;
const redisContainer = process.env.SPLIT_TEST_REDIS_CONTAINER;
const suite = pgUrl && redisUrl ? describe : describe.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await delay(50);
  }
}

suite("independent API / Runner processes with PostgreSQL and Redis", () => {
  const schema = `split_${randomUUID().replaceAll("-", "")}`;
  const children: ChildProcess[] = [];
  const logs: string[] = [];
  const api1 = "http://127.0.0.1:53170";
  const api2 = "http://127.0.0.1:53171";
  let pool: Pool;
  let stores: PgStores;
  let headers: Record<string, string>;
  let runner: ChildProcess;
  let firstApi: ChildProcess;
  const require = createRequire(import.meta.url);
  async function start(role: "api" | "runner" | "combined", port: number, overrides: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", require.resolve("tsx"), `src/${role === "combined" ? "dev" : role}-server.ts`], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OMA_LOCAL_INFRA: "true", AUTH_DISABLED: "false",
        PG_URL: pgUrl!, PG_SCHEMA: schema, PG_ENSURE_SCHEMA: "false", REDIS_URL: redisUrl!,
        REDIS_NAMESPACE: schema, PORT: String(port), PENDING_SCAN_INTERVAL_MS: "500", LOOP_POLL_INTERVAL_MS: "700",
        SSE_CATCHUP_INTERVAL_MS: "100", MOCK_DELAY_MS: "200", SHUTDOWN_GRACE_MS: "1000", ...overrides },
    });
    children.push(child);
    child.stdout!.on("data", data => logs.push(String(data)));
    child.stderr!.on("data", data => logs.push(String(data)));
    await until(async () => {
      if (child.exitCode !== null) throw new Error(logs.join(""));
      try { return (await fetch(`http://127.0.0.1:${port}/ready`)).ok; } catch { return false; }
    }, Boolean);
    return child;
  }
  async function fixture(overrides: Record<string, string> = {}) {
    const child = spawn(process.execPath, ["--import", require.resolve("tsx"), "test/fixtures/delegation-process.ts"], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
        PATH: process.env.PATH, HOME: process.env.HOME, PG_URL: pgUrl!, PG_SCHEMA: schema,
        REDIS_URL: redisUrl!, REDIS_NAMESPACE: schema, PENDING_SCAN_INTERVAL_MS: "100",
        LOOP_POLL_INTERVAL_MS: "60000", ...overrides,
      },
    });
    children.push(child);
    let output = "";
    child.stdout!.on("data", data => { output += String(data); logs.push(String(data)); });
    child.stderr!.on("data", data => { output += String(data); logs.push(String(data)); });
    if (!overrides.PARENT_SESSION_ID) await until(async () => {
      if (child.exitCode !== null) throw new Error(output);
      return output.includes("fixture runner ready");
    }, Boolean);
    return child;
  }
  async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGKILL") {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill(signal); await exited;
  }
  async function request(base: string, path: string, body?: unknown, method = body ? "POST" : "GET") {
    const response = await fetch(`${base}/v1/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
    return data;
  }
  async function newSession() {
    const agent = await stores.agentStore.create({ tenantId: "test", name: "Mock", runtime: "mock", model: "mock-model", system: "Test Agent", sandbox: { enabled: false } });
    return request(api2, "sessions", { agent: agent.id });
  }
  function input(base: string, id: string, text = "hello") { return request(base, `sessions/${id}/events`, { events: [{ type: "user.message", data: { text } }] }); }
  async function events(id: string) { return (await request(api2, `sessions/${id}/events?limit=1000`)).data as Array<{ seq: number; type: string; data: any }>; }
  async function complete(id: string, turns = 1) { return until(() => events(id), data => data.filter(e => e.type === "session.turn_completed").length === turns); }
  async function stream(base: string, id: string, after?: number) {
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/sessions/${id}/events?replay=1&include=chunks`, {
      headers: { ...headers, accept: "text/event-stream", ...(after === undefined ? {} : { "last-event-id": String(after) }) }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const frames: Array<{ type: string; seq?: number; data: any }> = [];
    const reading = (async () => {
      const reader = response.body!.getReader(); let buffer = ""; const decoder = new TextDecoder();
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const type = /^event: (.*)$/m.exec(raw)?.[1];
            if (!type) continue;
            const seq = /^id: (\d+)$/m.exec(raw)?.[1];
            frames.push({ type, ...(seq ? { seq: Number(seq) } : {}), data: JSON.parse(/^data: (.*)$/m.exec(raw)![1]) });
          }
        }
      } catch { /* expected abort */ } finally { reader.releaseLock(); }
    })();
    return { frames, close: async () => { controller.abort(); await reading; } };
  }
  beforeAll(async () => {
    const pg = new URL(pgUrl!); const redis = new URL(redisUrl!);
    for (const url of [pg, redis]) if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Split tests require loopback infrastructure");
    if (!pg.pathname.startsWith("/oma_local")) throw new Error("Split tests require an oma_local database");
    pool = createPgPool({ connectionString: pgUrl, schema });
    stores = await createPgStores(pool, { schema });
    const key = await stores.apiKeyStore.create("test", "split-tests");
    headers = { "x-api-key": key.rawKey, "content-type": "application/json" };
    firstApi = await start("api", 53170);
    await start("api", 53171);
  }, 30_000);
  afterAll(async () => {
    for (const child of children) await stop(child);
    if (pool) { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
  });

  it("accepts durable queued input with Runner absent; two APIs stream one competing execution and reconnect without duplicates", async () => {
    const session = await newSession();
    expect(await input(api1, session.id)).toMatchObject({ accepted: true });
    expect((await request(api2, `sessions/${session.id}/pending`)).count).toBe(1);
    expect((await events(session.id)).filter(e => e.type === "user.message")).toHaveLength(0);
    const a = await stream(api1, session.id); const b = await stream(api2, session.id);
    try {
      runner = await start("runner", 53172);
      const other = await start("runner", 53173);
      await complete(session.id);
      await until(async () => [a.frames, b.frames], streams => streams.every(f => f.some(e => e.type === "session.status_idle")));
      for (const frames of [a.frames, b.frames]) {
        expect(frames.filter(e => e.type === "agent.message_chunk").length).toBeGreaterThan(0);
        expect(frames.filter(e => e.type === "agent.message")).toHaveLength(1);
        const seqs = frames.flatMap(e => e.seq === undefined ? [] : [e.seq]);
        expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
      }
      const last = Math.max(...a.frames.map(e => e.seq ?? 0));
      const resumed = await stream(api2, session.id, last);
      await delay(250); expect(resumed.frames.filter(e => e.seq !== undefined)).toEqual([]); await resumed.close();
      expect((await events(session.id)).filter(e => e.type === "user.message")).toHaveLength(1);
      await stop(other);
    } finally { await a.close(); await b.close(); }
  }, 30_000);

  it("API exit does not stop Runner and a missed wake is found by PG scanning", async () => {
    const session = await newSession();
    await input(api1, session.id);
    await until(() => events(session.id), data => data.some(e => e.type === "session.status_running"));
    await stop(firstApi);
    const result = await complete(session.id);
    expect(result.filter(e => e.type === "agent.message")).toHaveLength(1);
    // Store acceptance deliberately emits no Redis wake, reproducing commit→crash.
    await stores.pendingEventStore.enqueueBatchIfSessionActive(session.id, [{ type: "user.message", data: { text: "lost wake" }, sessionThreadId: "sthr_primary" }]);
    await complete(session.id, 2);
    firstApi = await start("api", 53170);
  });

  it("Interrupt from a different API affects only the active Turn and preserves queued input", async () => {
    const session = await newSession(); await input(api1, session.id, "first");
    await until(() => events(session.id), data => data.some(e => e.type === "session.status_running"));
    await input(api1, session.id, "second");
    expect(await request(api2, `sessions/${session.id}/events`, { events: [{ type: "user.interrupt", data: {} }] })).toMatchObject({ requested: true, interrupted: false });
    const result = await complete(session.id, 2);
    expect(result.filter(e => e.type === "user.message")).toHaveLength(2);
    expect(result.some(e => e.type === "session.turn_aborted")).toBe(true);
    expect((await request(api2, `sessions/${session.id}`)).status).toBe("idle");
  });

  it("termination is durable for active and idle Sessions, without API execution objects", async () => {
    for (const active of [true, false]) {
      const session = await newSession();
      if (active) { await input(api1, session.id); await until(() => events(session.id), data => data.some(e => e.type === "session.status_running")); }
      await request(api2, `sessions/${session.id}`, undefined, "DELETE");
      await until(() => events(session.id), data => data.some(e => e.type === "session.status_terminated"));
      expect((await request(api1, `sessions/${session.id}`)).status).toBe("terminated");
      expect((await request(api1, `sessions/${session.id}/pending`)).count).toBe(0);
      const response = await fetch(`${api1}/v1/sessions/${session.id}/events`, { method: "POST", headers, body: JSON.stringify({ events: [{ type: "user.message", data: { text: "late" } }] }) });
      expect(response.status).toBe(410);
    }
  });

  it("Loop dispatch continues with both APIs down and manual dispatch retains its cadence", async () => {
    const agent = await stores.agentStore.create({ tenantId: "test", name: "Loop", runtime: "mock", model: "mock-model", system: "Test Agent", sandbox: { enabled: false } });
    const loop = await stores.loopStore.create({ tenantId: "test", agentId: agent.id, name: "once due", prompt: "scheduled", intervalMinutes: 5, enabled: true, now: new Date(Date.now() - 301_000) });
    const apiChild2 = children.find(child => child !== firstApi && child.spawnargs.includes("src/api-server.ts") && !child.signalCode)!;
    await stop(firstApi); await stop(apiChild2);
    const found = await until(() => stores.sessionStore.list("test", { loopId: loop.id }), result => result.data.length === 1);
    await until(() => stores.eventLogStore.getEvents(found.data[0].id), result => result.data.some(e => e.type === "session.turn_completed"));
    expect((await stores.sessionStore.list("test", { loopId: loop.id })).data).toHaveLength(1);
    firstApi = await start("api", 53170); await start("api", 53171);
    const before = await stores.loopStore.getById(loop.id);
    const manual = await request(api1, `loops/${loop.id}/run`, {});
    await complete(manual.id);
    expect((await stores.loopStore.getById(loop.id))?.nextRunAt).toEqual(before?.nextRunAt);
  }, 30_000);

  it.skipIf(!redisContainer)("Redis startup outage, mid-Turn loss and recovery preserve execution and open-page completion", async () => {
    // The container name is explicit test infrastructure, never discovered from production.
    if (!/^oma-split-/.test(redisContainer!)) throw new Error("Expected dedicated oma-split- Redis container");
    execFileSync("docker", ["stop", redisContainer!]);
    try {
      await stop(runner);
      runner = await start("runner", 53172);
      const session = await newSession(); const live = await stream(api2, session.id);
      try {
        await input(api1, session.id); await complete(session.id);
        await until(async () => live.frames, data => data.some(e => e.type === "session.status_idle"));
        expect(live.frames.filter(e => e.type === "agent.message")).toHaveLength(1);
      } finally { await live.close(); }
      const interrupted = await newSession();
      await input(api1, interrupted.id, "interrupt while Redis is down");
      await until(() => events(interrupted.id), data => data.some(e => e.type === "session.status_running"));
      await input(api1, interrupted.id, "preserved tail");
      expect(await request(api2, `sessions/${interrupted.id}/events`, { events: [{ type: "user.interrupt", data: {} }] }))
        .toMatchObject({ requested: true, interrupted: false });
      const result = await complete(interrupted.id, 2);
      expect(result.filter(e => e.type === "session.turn_aborted")).toHaveLength(1);
      expect(result.filter(e => e.type === "user.message")).toHaveLength(2);
      expect(await request(api2, `sessions/${interrupted.id}/events`, { events: [{ type: "user.interrupt", data: {} }] }))
        .toMatchObject({ requested: false, interrupted: false });
    } finally { execFileSync("docker", ["start", redisContainer!]); }
    await delay(1500);
    const session = await newSession(); const live = await stream(api1, session.id);
    try {
      await input(api2, session.id);
      await until(async () => live.frames, data => data.some(e => e.type === "agent.message_chunk"));
      execFileSync("docker", ["stop", redisContainer!]);
      await complete(session.id);
      await until(async () => live.frames, data => data.some(e => e.type === "session.status_idle"));
      expect(live.frames.filter(e => e.type === "agent.message")).toHaveLength(1);
    } finally { execFileSync("docker", ["start", redisContainer!]); await live.close(); }
    await delay(1500);
    const resumed = await stream(api2, session.id);
    try {
      await input(api1, session.id);
      await until(async () => resumed.frames, data => data.some(e => e.type === "agent.message_chunk"));
      await complete(session.id, 2);
    } finally { await resumed.close(); }
  }, 40_000);
  it("compatible combined entrypoint and split API overlap; a healthy wake beats the fallback scan", async () => {
    await stop(runner);
    const bridge = await start("combined", 53174, { PENDING_SCAN_INTERVAL_MS: "10000", LOOP_POLL_INTERVAL_MS: "60000", AUTH_DISABLED: "true" });
    try {
      // Wait past startup recovery/Loop dispatch; only Redis can wake promptly.
      await delay(300);
      const session = await newSession();
      const watching = await stream(api1, session.id);
      try {
        const started = Date.now(); await input(api2, session.id);
        await until(() => events(session.id), data => data.some(e => e.type === "session.status_running"), 1200);
        expect(Date.now() - started).toBeLessThan(1200);
        await complete(session.id);
        await until(async () => watching.frames, data => data.some(e => e.type === "session.status_idle"));
        expect(watching.frames.filter(e => e.type === "agent.message")).toHaveLength(1);
      } finally { await watching.close(); }
    } finally { await stop(bridge); }
  }, 15_000);

  it.each(["sync", "async"])("delivers %s Child Session results between separate Runner processes", async mode => {
    await stop(runner);
    const agent = await stores.agentStore.create({ tenantId: "test", name: "Delegate", runtime: "pi-agent", model: "pinned-model", system: "Test", sandbox: { enabled: true } });
    const session = await request(api2, "sessions", { agent: agent.id });
    await input(api1, session.id);
    const parent = await fixture({ PARENT_SESSION_ID: session.id, DELEGATION_MODE: mode });
    let childRunner: ChildProcess | undefined;
    try {
      const executions = await until(() => stores.delegationStore.listExecutions("test", { callerSessionId: session.id }), result => result.length === 1);
      const childId = executions[0].childId;
      childRunner = await fixture();
      const result = await complete(session.id, mode === "sync" ? 1 : 2);
      const child = await events(childId);
      expect(JSON.stringify(child)).toContain(`child PID ${childRunner.pid}; model pinned-model; budget 500`);
      expect(JSON.stringify(result)).toContain(`parent PID ${parent.pid}`);
      expect(result.filter(e => e.type === "subagent.result")).toHaveLength(1);
      expect(result.filter(e => e.type === "subagent.result_claimed")).toHaveLength(mode === "sync" ? 0 : 1);
      expect((await stores.delegationStore.listExecutions("test", { callerSessionId: session.id }))[0].status).toBe("completed");
    } finally {
      await stop(parent); if (childRunner) await stop(childRunner);
    }
  }, 30_000);

  it("two Runners retry cleanup after owner exit and retain shared or unknown execution resources", async () => {
    const deletes = new Map<string, number>();
    const gateway = createServer((req, res) => {
      const id = req.url!.slice(1); const count = (deletes.get(id) ?? 0) + 1; deletes.set(id, count);
      res.writeHead(id === "retry-sandbox" && count === 1 ? 503 : 204); res.end();
    });
    await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
    const address = gateway.address() as { port: number };
    const override = { TEST_DELETE_URL: `http://127.0.0.1:${address.port}` };
    const workers: ChildProcess[] = [];
    try {
      const agent = await stores.agentStore.create({ tenantId: "test", name: "Cleanup", runtime: "mock", model: "mock", system: "test", sandbox: { enabled: true } });
      const session = await request(api2, "sessions", { agent: agent.id });
      await stores.delegationStore.withEnvironmentLock(session.id, async () => ({ sandboxId: "retry-sandbox", value: undefined }));
      await request(api1, `sessions/${session.id}`, undefined, "DELETE");
      workers.push(await fixture(override), await fixture(override));
      await until(async () => stores.delegationStore.withEnvironmentLock(session.id, async id => ({ sandboxId: id, value: id })), id => id === null);
      expect(deletes.get("retry-sandbox")).toBe(2);
      expect((await request(api2, `sessions/${session.id}`)).status).toBe("terminated");

      const retained = await request(api2, "sessions", { agent: agent.id });
      const accepted = await stores.pendingEventStore.enqueueBatchIfSessionActive(retained.id, [{ type: "user.message", data: { text: "unknown" }, sessionThreadId: "sthr_primary" }]);
      const claim = (await stores.pendingEventStore.claim(retained.id, "departed-owner", 30_000))!;
      const activities = new PgSandboxLifecycleStore(pool);
      const activity = { bindingId: retained.id, sessionId: retained.id, fence: { eventId: accepted![0].id, ownerId: claim.ownerId, generation: claim.generation } };
      await activities.begin(activity);
      const child = await stores.delegationStore.accept({ tenantId: "test", callerSessionId: retained.id,
        callerTurnId: "parent-turn", callerToolUseId: "shared", prompt: "shared resource", mode: "async",
        parentModel: "mock", maxSteps: 500, sandboxSessionId: retained.id }, activity.fence);
      const childClaim = (await stores.pendingEventStore.claim(child.childId, "child-owner", 30_000))!;
      const childActivity = { bindingId: retained.id, sessionId: child.childId,
        fence: { eventId: child.pendingEventId, ownerId: childClaim.ownerId, generation: childClaim.generation } };
      await activities.begin(childActivity);
      await stores.delegationStore.withEnvironmentLock(retained.id, async () => ({ sandboxId: "unknown-sandbox", value: undefined }));
      await request(api1, `sessions/${retained.id}`, undefined, "DELETE");
      await delay(600);
      expect(deletes.has("unknown-sandbox")).toBe(false);
      // Concrete settlement evidence can release only this exact activity.
      await activities.finish(activity);
      await delay(600); expect(deletes.has("unknown-sandbox")).toBe(false);
      await request(api2, `sessions/${child.childId}`, undefined, "DELETE");
      await delay(600); expect(deletes.has("unknown-sandbox")).toBe(false);
      await activities.finish(childActivity);
      await until(async () => deletes.get("unknown-sandbox"), count => count === 1);
      await delay(300); expect(deletes.get("unknown-sandbox")).toBe(1);
    } finally {
      for (const worker of workers) await stop(worker);
      await new Promise<void>(resolve => gateway.close(() => resolve()));
    }
  }, 30_000);

});
