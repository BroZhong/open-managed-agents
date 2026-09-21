import { expect, it } from "vitest";
import { EventPayloadCodec, BIG_RESULT_BYTES } from "../src/event-payload.js";
import { OSSEventPayloadStore } from "../src/oss/event-payload-store.js";
import { createOSSHTTPHarness } from "./oss-http-harness.js";
import { ossTestOptions } from "./oss-harness.js";

it("round-trips big results through the actual OSS SDK using a Host-only immutable key", async () => {
  const fixture = await createOSSHTTPHarness();
  try {
    const store = new OSSEventPayloadStore({ ...ossTestOptions, endpoint: fixture.endpoint });
    const codec = new EventPayloadCodec(store);
    const original = { content: [{ type: "text", text: "你好".repeat(BIG_RESULT_BYTES) }], toolUseId: "t1", isError: false };
    const encoded = await codec.encode("sess_test", "agent.tool_result", original);
    expect(JSON.stringify(encoded).length).toBeLessThan(1024);
    expect(await codec.decode("sess_test", encoded)).toEqual(original);
    expect(fixture.requests.map(r => r.method)).toEqual(["PUT", "GET"]);
    await expect(store.get("../escape", "a".repeat(64))).rejects.toThrow("identity");
    await expect(store.get("sess_test", "../escape")).rejects.toThrow("identity");
  } finally { await fixture.close(); }
});
