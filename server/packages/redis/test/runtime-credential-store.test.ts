import { describe, expect, it } from "vitest";
import { RedisRuntimeCredentialStore } from "../src/runtime-credential-store.js";
import { FakeRedis } from "./fake-redis.js";

describe("RedisRuntimeCredentialStore", () => {
  it("keeps a credential outside pending/event payloads and deletes it explicitly", async () => {
    const store = new RedisRuntimeCredentialStore(new FakeRedis());
    await store.put("pending_1", { vfsToken: "token-1" });

    expect(await store.get("pending_1")).toEqual({ vfsToken: "token-1" });

    await store.delete("pending_1");
    expect(await store.get("pending_1")).toBeNull();
  });

  it("expires credentials", async () => {
    const store = new RedisRuntimeCredentialStore(new FakeRedis());
    await store.put("pending_1", { vfsToken: "token-1" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await store.get("pending_1")).toBeNull();
  });
});
