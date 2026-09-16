// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  // Full-width answers must still shrink to the conversation column so wide
  // tables scroll inside the prose container rather than widening the page.
  expect(prose!.parentElement!.className).toContain("max-w-full");
  expect(prose!.parentElement!.className).toContain("min-w-0");
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

const activityEvents: SessionEvent[] = [
  userMessage,
  { seq: 11, type: "agent.thinking", data: { text: "Check the source first" }, ts: userMessage.ts },
  { seq: 12, type: "agent.tool_use", data: { toolUseId: "read-1", name: "read", input: { path: "draft.md" } }, ts: userMessage.ts },
  { seq: 13, type: "agent.tool_result", data: { toolUseId: "read-1", content: "File content" }, ts: userMessage.ts },
  { seq: 14, type: "agent.message", data: { content: [{ type: "text", text: "Here is the answer" }] }, ts: userMessage.ts },
];

it("folds process details for the latest completed turn while keeping the answer visible", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(<ConversationView events={activityEvents} sessionStatus="idle" />);
  const summary = screen.getByRole("button", { name: /Explored · reasoning · 1 tool call/ });
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("Here is the answer").closest("[hidden]")).toBeNull();
  fireEvent.click(summary);
  const tool = screen.getByRole("button", { name: /Read file/ });
  fireEvent.click(tool);
  expect(screen.getByText("File content").closest("[hidden]")).toBeNull();
  fireEvent.click(summary);
  expect(screen.getByText("File content").closest("[hidden]")).not.toBeNull();
});

it("keeps process expansion across new output and exposes failures", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const view = render(<ConversationView events={activityEvents.slice(0, 3)} sessionStatus="running" />);
  const summary = screen.getByRole("button", { name: /Working · reasoning/ });
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(summary);
  fireEvent.click(summary);
  view.rerender(<ConversationView events={activityEvents} sessionStatus="idle" />);
  expect(screen.getByRole("button", { name: /Explored · reasoning/ }).getAttribute("aria-expanded")).toBe("true");
  const failed = activityEvents.map((event) => event.type === "agent.tool_result" ? { ...event, data: { toolUseId: "read-1", content: "Access denied", isError: true } } : event);
  view.rerender(<ConversationView events={failed} sessionStatus="idle" />);
  expect(screen.getByRole("button", { name: /Needs attention/ })).toBeTruthy();
  expect(screen.getByText("Access denied").closest("[hidden]")).toBeNull();
});

it("does not label an interrupted tool as still running", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(<ConversationView events={activityEvents.slice(0, 3)} sessionStatus="idle" />);
  fireEvent.click(screen.getByRole("button", { name: /Incomplete/ }));
  expect(screen.getByLabelText("No result")).toBeTruthy();
  expect(screen.queryByLabelText("Running")).toBeNull();
});

it("follows growing deltas but leaves the scroll position alone when reading history", () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  const view = render(<ConversationView events={[userMessage]} activeDeltas={deltas} sessionStatus="running" />);
  scroll.mockClear();
  const grown = deltas.map((delta) => delta.type === "agent.message_chunk" ? { ...delta, data: { text: "Stable bubble growing" } } : delta);
  view.rerender(<ConversationView events={[userMessage]} activeDeltas={grown} sessionStatus="running" />);
  expect(scroll).toHaveBeenCalled();
  const container = view.container.querySelector(".conversation-scroll")!;
  Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 }, scrollTop: { value: 0 } });
  fireEvent.scroll(container);
  scroll.mockClear();
  view.rerender(<ConversationView events={activityEvents} sessionStatus="idle" />);
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
  expect(scroll).toHaveBeenCalled();
});

it("shows a persisted subagent notification once without presenting it as human input", () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  render(<ConversationView sessionStatus="waiting" events={[
    { seq: 1, type: "subagent.result", ts: "2026-09-16", data: { source: "subagent_result", childId: "child", executionId: "exec", result: { status: "failed", reason: "Child provider error", output: "Partial child output" } } },
    { seq: 2, type: "subagent.result_claimed", ts: "2026-09-16", data: { source: "subagent_result", notificationSeq: 1 } },
  ]} />);
  expect(screen.getAllByText("Subagent result")).toHaveLength(1);
  expect(screen.getByText(/Child provider error/)).toBeTruthy();
});


it("reveals the process group targeted by a delegated tool deep link", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(<ConversationView events={activityEvents} sessionStatus="idle" focusToolUseId="read-1" />);
  expect(screen.getByRole("button", { name: /Explored · reasoning/ }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /Read file/ }).closest("[hidden]")).toBeNull();
});

it("keeps successive process groups between the text messages that separate them", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const later: SessionEvent[] = [
    { seq: 15, type: "agent.thinking", data: { text: "Now verify" }, ts: userMessage.ts },
    { seq: 16, type: "agent.tool_use", data: { toolUseId: "read-2", name: "read", input: { path: "result.md" } }, ts: userMessage.ts },
    { seq: 17, type: "agent.tool_result", data: { toolUseId: "read-2", content: "Verified" }, ts: userMessage.ts },
  ];
  const view = render(<ConversationView events={[...activityEvents, ...later]} sessionStatus="running" />);
  const groups = view.container.querySelectorAll(".session-process");
  expect(groups).toHaveLength(2);
  expect(groups[0].querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(groups[1].querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  const firstAnswer = screen.getByText("Here is the answer");
  expect(groups[0].compareDocumentPosition(firstAnswer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(firstAnswer.compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  view.rerender(<ConversationView events={[...activityEvents, ...later]} activeDeltas={deltas} sessionStatus="running" />);
  expect(groups[1].querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("Stable bubble").closest("[hidden]")).toBeNull();
  view.rerender(<ConversationView events={[...activityEvents, ...later, { seq: 18, type: "agent.message", data: { content: [{ type: "text", text: "All verified" }] }, ts: userMessage.ts }]} sessionStatus="idle" />);
  expect(view.container.querySelectorAll(".session-process")[1]).toBe(groups[1]);
  expect(groups[1].compareDocumentPosition(screen.getByText("All verified")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("opens absolute and relative file links in Workspace while preserving external links", () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const open = vi.fn();
  render(<ConversationView onOpenWorkspaceFile={open} sessionStatus="idle" events={[{
    seq: 1, type: "agent.message", ts: userMessage.ts,
    data: { content: [{ type: "text", text: "[旁白稿](/home/user/workspace/novel/narration.txt) [场面草案](novel/scenes.md) [文件](file:///home/user/workspace/novel/production.json) [文档](https://example.com/docs) [技能](/skills/story/SKILL.md)" }] },
  }]} />);
  for (const name of ["旁白稿", "场面草案", "文件"]) fireEvent.click(screen.getByRole("link", { name }));
  expect(open.mock.calls).toEqual([["novel/narration.txt"], ["novel/scenes.md"], ["novel/production.json"]]);
  expect(screen.getByRole("link", { name: "文档" }).getAttribute("href")).toBe("https://example.com/docs");
  expect(screen.getByRole("link", { name: "技能" }).getAttribute("title")).toBeNull();
});

it("updates live process elapsed time and freezes it when the next answer arrives", () => {
  vi.useFakeTimers();
  try {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.setSystemTime(new Date("2026-09-16T00:02:16Z"));
    const events: SessionEvent[] = [
      { seq: 1, type: "span.model_request_start", data: {}, ts: "2026-09-16T00:00:00Z" },
      { seq: 2, type: "agent.tool_use", data: { toolUseId: "timed", name: "bash", input: { command: "work" } }, ts: "2026-09-16T00:00:10Z" },
    ];
    const view = render(<ConversationView events={events} sessionStatus="running" />);
    expect(screen.getByRole("button", { name: /Working.*2m 16s/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("button", { name: /Working.*2m 17s/ })).toBeTruthy();
    view.rerender(<ConversationView events={[...events,
      { seq: 3, type: "agent.tool_result", data: { toolUseId: "timed", content: "Done" }, ts: "2026-09-16T00:02:17Z" },
      { seq: 4, type: "agent.message", data: { content: [{ type: "text", text: "Finished" }] }, ts: "2026-09-16T00:02:18Z" },
    ]} sessionStatus="idle" />);
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByRole("button", { name: /Explored.*2m 18s/ }).getAttribute("aria-expanded")).toBe("false");
  } finally { vi.useRealTimers(); }
});
