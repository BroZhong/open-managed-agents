import { describe, it, expect } from "vitest";
import {
  deriveTitleFromEventData,
  deriveTitleFromContent,
} from "../src/lib/derive-title.js";

describe("deriveTitleFromEventData", () => {
  it("derives from the first text block of a content array", () => {
    expect(
      deriveTitleFromEventData({ content: [{ type: "text", text: "Hello" }] }),
    ).toBe("Hello");
  });

  it("derives from the flat { text } shape", () => {
    expect(deriveTitleFromEventData({ text: "你好你是谁" })).toBe("你好你是谁");
  });

  it("skips non-text leading blocks and uses the first text block", () => {
    expect(
      deriveTitleFromEventData({
        content: [
          { type: "image", url: "x" },
          { type: "text", text: "real title" },
        ],
      }),
    ).toBe("real title");
  });

  it("collapses whitespace and trims", () => {
    expect(
      deriveTitleFromEventData({ content: [{ type: "text", text: "  a\n\n  b  " }] }),
    ).toBe("a b");
  });

  it("truncates to 60 chars with an ellipsis", () => {
    expect(
      deriveTitleFromEventData({ content: [{ type: "text", text: "x".repeat(100) }] }),
    ).toBe("x".repeat(60) + "…");
  });

  it("returns null for empty / whitespace-only text", () => {
    expect(deriveTitleFromEventData({ content: [{ type: "text", text: "   " }] })).toBeNull();
    expect(deriveTitleFromEventData({ text: "" })).toBeNull();
  });

  it("returns null when there is no text block", () => {
    expect(deriveTitleFromEventData({ content: [{ type: "image", url: "x" }] })).toBeNull();
    expect(deriveTitleFromEventData({})).toBeNull();
    expect(deriveTitleFromEventData(null)).toBeNull();
    expect(deriveTitleFromEventData("nope")).toBeNull();
  });

  it("deriveTitleFromContent is a thin wrapper over the content shape", () => {
    expect(deriveTitleFromContent([{ type: "text", text: "Hi there" }])).toBe("Hi there");
    expect(deriveTitleFromContent([])).toBeNull();
  });
});
