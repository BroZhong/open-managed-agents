import { afterEach, expect, it, vi } from "vitest";
import { createMemoryStores } from "@oma-server/store-memory";
import { PgSessionShareStore } from "@oma-server/store";
import { createPgTestHarness } from "../../store/test/pg-harness.js";
import { createApp } from "../src/app.js";
import { signSessionToken } from "../src/auth/tokens.js";

afterEach(() => vi.unstubAllEnvs());

it("persists one share through concurrent HTTP requests and reconstruction of the PostgreSQL store", async () => {
  vi.stubEnv("AUTH_DISABLED", "false");
  vi.stubEnv("AUTH_JWT_SECRET", "share-test-only");
  const database = await createPgTestHarness();
  try {
    const stores = createMemoryStores();
    const app = createApp({ ...stores, sessionShareStore: new PgSessionShareStore(database.pool) });
    const headers = { Authorization: `Bearer ${await signSessionToken("owner")}`, "Content-Type": "application/json" };
    const agent = await stores.agentStore.create({ tenantId: "owner", name: "Test", model: "test", system: "private", runtime: "mock" });
    const session = await (await app.request("/v1/sessions", { method: "POST", headers, body: JSON.stringify({ agent: agent.id }) })).json();
    const path = `/v1/sessions/${session.id}/share`;
    const shares = await Promise.all(Array.from({ length: 16 }, async () => {
      const response = await app.request(path, { method: "POST", headers });
      expect(response.status).toBe(200);
      return response.json();
    }));
    expect(new Set(shares.map((share) => share.id)).size).toBe(1);
    const restarted = createApp({ ...stores, sessionShareStore: new PgSessionShareStore(database.pool) });
    const newLogin = { Authorization: `Bearer ${await signSessionToken("owner")}` };
    expect(await (await restarted.request(path, { method: "POST", headers: newLogin })).json()).toEqual(shares[0]);
    const shared = await restarted.request(`/v1/sessions/${session.id}`, { headers: { ...newLogin, "x-session-share": shares[0].id } });
    expect((await shared.json()).agent).toEqual({ name: "Test" });
  } finally { await database.close(); }
});
