// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConversationView } from "@/components/conversation-view";
import type { SessionDelta, SessionEvent } from "@/lib/types";

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

const userMessage: SessionEvent = {
  seq: 10,
  type: "user.message",
  data: { content: [{ type: "text", text: "Explain" }] },
  ts: "2026-07-11T00:00:00.000Z",
};

const deltas: SessionDelta[] = [
  {
    type: "agent.message_stream_start",
    data: {},
    ts: "2026-07-11T00:00:01.000Z",
    turnId: "turn_10",
    blockIndex: 0,
    deltaId: "1-0",
  },
  {
    type: "agent.message_chunk",
    data: { text: "Stable bubble" },
    ts: "2026-07-11T00:00:01.100Z",
    turnId: "turn_10",
    blockIndex: 0,
    deltaId: "1-1",
  },
];

it("preserves the assistant bubble DOM node across Delta to Complete replacement", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const view = render(
    <ConversationView
      events={[userMessage]}
      activeDeltas={deltas}
      sessionStatus="running"
    />,
  );
  const streamingTextNode = screen.getByText("Stable bubble");

  const complete: SessionEvent = {
    seq: 11,
    type: "agent.message",
    data: {
      content: [{ type: "text", text: "Stable bubble" }],
      turnId: "turn_10",
      blockIndex: 0,
    },
    ts: "2026-07-11T00:00:02.000Z",
  };
  view.rerender(
    <ConversationView
      events={[userMessage, complete]}
      activeDeltas={[]}
      sessionStatus="running"
    />,
  );

  expect(screen.getByText("Stable bubble")).toBe(streamingTextNode);
});

it("shows an interrupted message's text with a stopped marker (issue #110)", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const aborted: SessionEvent = {
    seq: 11,
    type: "agent.message",
    data: {
      content: [{ type: "text", text: "Half a th" }],
      turnId: "turn_10",
      blockIndex: 0,
      stopReason: "aborted",
    },
    ts: "2026-07-11T00:00:02.000Z",
  };
  render(
    <ConversationView
      events={[userMessage, aborted]}
      activeDeltas={[]}
      sessionStatus="idle"
    />,
  );

  expect(screen.getByText("Half a th")).toBeTruthy();
  expect(screen.getByText("Stopped by you")).toBeTruthy();
});

it("renders a completed message without the stopped marker", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const done: SessionEvent = {
    seq: 11,
    type: "agent.message",
    data: { content: [{ type: "text", text: "All done" }] },
    ts: "2026-07-11T00:00:02.000Z",
  };
  render(
    <ConversationView events={[userMessage, done]} activeDeltas={[]} sessionStatus="idle" />,
  );

  expect(screen.queryByText("Stopped by you")).toBeNull();
});
