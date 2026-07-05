import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PgUserStore } from "../src/postgres/user-store.js";
import { createPgTestHarness, type PgTestHarness } from "./pg-harness.js";

describe("PgUserStore", () => {
  let harness: PgTestHarness;
  let store: PgUserStore;

  beforeAll(async () => {
    harness = await createPgTestHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    store = new PgUserStore(harness.pool);
  });

  it("creates a user with a user_ id and echoes fields", async () => {
    const user = await store.create({
      username: "Alice",
      passwordHash: "hash1",
      tenantId: "tenant1",
    });

    expect(user.id).toMatch(/^user_/);
    expect(user.username).toBe("Alice");
    expect(user.passwordHash).toBe("hash1");
    expect(user.tenantId).toBe("tenant1");
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it("finds a user by exact username", async () => {
    await store.create({ username: "bob", passwordHash: "h", tenantId: "t" });

    const found = await store.findByUsername("bob");
    expect(found).not.toBeNull();
    expect(found!.username).toBe("bob");
  });

  it("finds a user case-insensitively", async () => {
    await store.create({ username: "Charlie", passwordHash: "h", tenantId: "t" });

    const lower = await store.findByUsername("charlie");
    const upper = await store.findByUsername("CHARLIE");
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(lower!.username).toBe("Charlie");
    expect(upper!.username).toBe("Charlie");
  });

  it("returns null for an unknown username", async () => {
    const found = await store.findByUsername("nobody");
    expect(found).toBeNull();
  });

  it("enforces case-insensitive uniqueness", async () => {
    await store.create({ username: "Dave", passwordHash: "h", tenantId: "t" });

    await expect(
      store.create({ username: "dave", passwordHash: "h2", tenantId: "t2" }),
    ).rejects.toThrow();
  });
});
