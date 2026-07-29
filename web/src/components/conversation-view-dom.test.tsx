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

// Verbatim from issue #117 (production oma.events sess_YpxzAYyUZ_HaaavMOvVjc
// seq 45), so the fixture is the exact shape that rendered unstyled.
const gfmTable = [
  "| 编号 | 分镜组 | 景别/机位 | 内容简述 |",
  "|---|---|---|---|",
  "| EP01-001 | 分镜组1 | 大特写 / 微俯 / 轻推 | ... |",
].join("\n");

function renderTableMessage() {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const tableMessage: SessionEvent = {
    seq: 45,
    type: "agent.message",
    data: { content: [{ type: "text", text: gfmTable }] },
    ts: "2026-07-11T00:00:02.000Z",
  };
  return render(
    <ConversationView
      events={[userMessage, tableMessage]}
      activeDeltas={[]}
      sessionStatus="idle"
    />,
  );
}

it("renders a GFM table in an agent.message as real table elements (issue #117)", () => {
  const { container } = renderTableMessage();

  const table = container.querySelector("table");
  expect(table).not.toBeNull();
  // remarkGfm must produce a real header row, not a plain paragraph of pipes.
  expect(table!.querySelector("thead")).not.toBeNull();
  expect([...table!.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual([
    "编号",
    "分镜组",
    "景别/机位",
    "内容简述",
  ]);
  expect([...table!.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual([
    "EP01-001",
    "分镜组1",
    "大特写 / 微俯 / 轻推",
    "...",
  ]);
  // The raw markdown must not survive as literal text anywhere in the bubble.
  expect(container.textContent).not.toContain("|---|");
});

it("puts the markdown table inside the scrollable prose container (issue #117)", () => {
  const { container } = renderTableMessage();

  const table = container.querySelector("table")!;
  const prose = table.closest(".prose");
  expect(prose).not.toBeNull();

  // These are what actually make a wide table scroll itself instead of
  // bursting the max-w-[85%] bubble. Asserting the class names is the only
  // jsdom-visible proxy for the visual fix, but it does catch the whole
  // regression class: dropping any of them silently restores the overflow.
  const classes = prose!.className.split(/\s+/);
  for (const required of [
    "prose",
    "prose-sm",
    "[&_table]:block",
    "[&_table]:overflow-x-auto",
    "[&_table]:w-max",
    "[&_table]:max-w-full",
  ]) {
    expect(classes).toContain(required);
  }

  // The bubble itself must stay width-capped; an uncapped bubble would let a
  // wide table overlap neighbouring messages even with the scroll box.
  expect(prose!.parentElement!.className).toContain("max-w-[85%]");
});

it("keeps the bubble's own prose overrides that the typography plugin would otherwise win (issue #117)", () => {
  const { container } = renderTableMessage();

  const classes = container.querySelector(".prose")!.className.split(/\s+/);
  // The plugin ships its own p margins, pre background and code sizing. These
  // three were the pre-existing design and must survive installing it.
  expect(classes).toContain("[&_p]:my-1.5");
  expect(classes).toContain("[&_pre]:bg-[var(--color-bg-muted)]");
  expect(classes).toContain("[&_code]:text-[13px]");
  // The plugin also adds backtick pseudo-quotes and font-weight:600 to inline
  // code, neither of which was part of the design.
  expect(classes).toContain("[&_code]:before:content-none");
  expect(classes).toContain("[&_code]:after:content-none");
  expect(classes).toContain("[&_code]:font-normal");
});
