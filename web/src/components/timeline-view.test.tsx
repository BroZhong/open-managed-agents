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

it("lists a Skill Install's spans on the trace as spans, with what the install did", () => {
  const events: SessionEvent[] = [
    { seq: 1, type: "span.skills_install_start", ts: "2026-10-23T00:00:00Z",
      data: { turnId: "turn_1_a1", installId: "1.1", setHash: "a".repeat(64), skills: 1 } },
    { seq: 2, type: "span.skills_install_end", ts: "2026-10-23T00:00:02Z",
      data: { turnId: "turn_1_a1", installId: "1.1", setHash: "a".repeat(64), skills: 1, outcome: "failed", durationMs: 2000, stage: "download", reason: "HTTP 503, curl exit 0" } },
  ];
  render(<TimelineView sessionId="s1" events={events} />);
  const end = screen.getByRole("button", { name: /span\.skills_install_end/ });
  expect(end.querySelector(".bg-purple-100")?.textContent).toBe("span.skills_install_end");
  fireEvent.click(end);
  expect(document.body.textContent).toContain('"stage": "download"');
  expect(document.body.textContent).toContain('"reason": "HTTP 503, curl exit 0"');
});
