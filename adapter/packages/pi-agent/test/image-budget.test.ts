import { describe, expect, it } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_IMAGE_BUDGET_BYTES, fitImageBudget, imageBudgetBytes } from "../src/image-budget.js";

type Messages = ContextEvent["messages"];
const image = (bytes: number, seed = "A") => ({ type: "image" as const, mimeType: "image/png", data: seed.repeat(bytes) });
// One `read` round trip per image, in the shape Pi stores it.
function reads(count: number, bytes = 300): Messages {
  return Array.from({ length: count }, (_, i) => [
    { role: "assistant", api: "openai-completions", provider: "test", model: "test", content: [{ type: "toolCall", id: `call_${i}`, name: "read", arguments: { path: `/home/user/workspace/n${i}.png` } }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: i },
    { role: "toolResult", toolCallId: `call_${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image(bytes, String.fromCharCode(65 + i))], isError: false, timestamp: i },
  ] as Messages).flat();
}
const imageBytes = (messages: Messages) => messages.reduce((sum, message) =>
  sum + ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)
    ? message.content.reduce((total, block) => total + (block.type === "image" ? block.data.length : 0), 0) : 0), 0);
const texts = (messages: Messages) => messages.flatMap(message => message.role === "toolResult" ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []);

describe("request image budget", () => {
  it("passes a history within budget through unchanged", () => {
    const messages = reads(3);
    expect(fitImageBudget(messages, 900)).toBe(messages);
  });

  it("omits the oldest images down to the low watermark once over budget, keeping text and naming the path", () => {
    const messages = reads(4);
    const original = structuredClone(messages);
    const fitted = fitImageBudget(messages, 1000);
    // 4 x 300 = 1200 > 1000: omit oldest until <= 500, leaving only the newest.
    expect(imageBytes(fitted)).toBe(300);
    expect(texts(fitted)).toEqual([
      "Read image file [image/png]", "[image omitted to fit request size: /home/user/workspace/n0.png; read it again if needed]",
      "Read image file [image/png]", "[image omitted to fit request size: /home/user/workspace/n1.png; read it again if needed]",
      "Read image file [image/png]", "[image omitted to fit request size: /home/user/workspace/n2.png; read it again if needed]",
      "Read image file [image/png]",
    ]);
    expect(fitted.at(-1)).toBe(messages.at(-1));
    expect(messages).toEqual(original);
  });

  it("treats the high watermark as inclusive", () => {
    expect(imageBytes(fitImageBudget(reads(4, 250), 1000))).toBe(1000);
    expect(imageBytes(fitImageBudget(reads(4, 250), 999))).toBe(250);
  });

  it("is deterministic and keeps the request prefix stable until the next omission", () => {
    const history = reads(12);
    let changes = 0;
    for (let n = 2; n < history.length; n += 2) {
      const before = fitImageBudget(history.slice(0, n), 1000);
      const after = fitImageBudget(history.slice(0, n + 2), 1000);
      expect(fitImageBudget(history.slice(0, n + 2), 1000)).toEqual(after);
      expect(imageBytes(after)).toBeLessThanOrEqual(1000);
      if (JSON.stringify(after.slice(0, n)) !== JSON.stringify(before)) changes++;
    }
    // 12 images of 300 bytes cross the 1000-byte watermark at images 4, 7 and 10.
    expect(changes).toBe(3);
  });

  it("omits user-attached images without a path and ignores string content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "look" }, image(800)], timestamp: 0 },
      { role: "user", content: "plain", timestamp: 1 },
      { role: "user", content: [image(400)], timestamp: 2 },
    ] as Messages;
    const fitted = fitImageBudget(messages, 1000);
    expect(fitted[0]).toMatchObject({ content: [{ type: "text", text: "look" }, { type: "text", text: "[image omitted to fit request size]" }] });
    expect(fitted.slice(1)).toEqual(messages.slice(1));
  });

  it("reads an override from OMA_PI_IMAGE_BUDGET_BYTES", () => {
    expect(imageBudgetBytes({})).toBe(DEFAULT_IMAGE_BUDGET_BYTES);
    expect(imageBudgetBytes({ OMA_PI_IMAGE_BUDGET_BYTES: "6000000" })).toBe(6_000_000);
    for (const invalid of ["", "0", "-1", "1.5", "20MB"]) expect(imageBudgetBytes({ OMA_PI_IMAGE_BUDGET_BYTES: invalid })).toBe(DEFAULT_IMAGE_BUDGET_BYTES);
  });
});
