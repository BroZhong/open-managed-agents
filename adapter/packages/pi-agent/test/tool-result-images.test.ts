import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentToolResultEvent } from "@open-managed-agents/adapter-core";
import { PiEventTranslator } from "../src/translator.js";
import { eventLogToAgentMessages } from "../src/event-log-to-messages.js";

describe("image tool results across durable history", () => {
  it("preserves mixed text/image blocks through JSON storage and the next turn", () => {
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfCgAAAAASUVORK5CYII=" };
    const content = [{ type: "text", text: "参考图 👀" }, image, { type: "text", text: "下一镜头" }];
    const event = new PiEventTranslator().processEvent({
      type: "tool_execution_end", toolCallId: "read_image", toolName: "read",
      result: { content, details: {} }, isError: false,
    } as AgentSessionEvent)[0] as AgentToolResultEvent;
    expect(event.content).toEqual([
      content[0], { type: "image", source: { type: "base64", mediaType: image.mimeType, data: image.data } }, content[2],
    ]);
    const stored = JSON.parse(JSON.stringify(event));
    const result = eventLogToAgentMessages([stored])[0];
    expect(result.role).toBe("toolResult");
    expect(result.content).toEqual(content);
  });

  it("keeps an image-only result as an image instead of serialized JSON text", () => {
    const event = new PiEventTranslator().processEvent({
      type: "tool_execution_end", toolCallId: "read_image", toolName: "read",
      result: { content: [{ type: "image", mimeType: "image/jpeg", data: "/9j/2Q==" }] }, isError: false,
    } as AgentSessionEvent)[0] as AgentToolResultEvent;
    expect(event.content).toHaveLength(1);
    expect(event.content[0].type).toBe("image");
    expect(event.isError).toBe(false);
  });
});
