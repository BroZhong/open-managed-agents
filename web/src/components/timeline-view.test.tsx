// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TimelineView } from "./timeline-view";
import type { SessionEvent } from "@/lib/types";

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => cleanup());

it("shows a Resumed Turn's takeover marker on the trace, with why and which calls it found dangling", () => {
  const events: SessionEvent[] = [
    { seq: 1, type: "user.message", ts: "2026-10-22T00:00:00Z", data: { content: [{ type: "text", text: "run it" }] } },
    { seq: 2, type: "session.turn_resumed", ts: "2026-10-22T00:00:35Z",
      data: { turnId: "turn_1_a1", generation: 2, reason: "expired", danglingToolUseIds: ["call_1"] } },
  ];
  render(<TimelineView sessionId="s1" events={events} />);
  fireEvent.click(screen.getByRole("button", { name: /session\.turn_resumed/ }));
  expect(document.body.textContent).toContain('"reason": "expired"');
  expect(document.body.textContent).toContain('"call_1"');
});
