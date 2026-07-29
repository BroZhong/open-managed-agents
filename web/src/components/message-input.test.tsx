// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageInput } from "@/components/message-input";

afterEach(cleanup);

const skills = [
  {
    id: "skill_fork_1",
    name: "storyboard",
    description: "Split a screenplay into storyboard shots.",
    sourceSkillId: "skill_1",
    updatedAt: "2026-07-12T00:00:00.000Z",
  },
  {
    id: "skill_fork_2",
    name: "research",
    description: "Research a topic.",
    sourceSkillId: "skill_2",
    updatedAt: "2026-07-12T00:00:00.000Z",
  },
];

it("suggests equipped Skills for /skill: and sends the selected command", () => {
  const onSend = vi.fn();
  render(<MessageInput onSend={onSend} skills={skills} />);

  const input = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(input, { target: { value: "/skill:sto" } });

  expect(screen.getByRole("listbox", { name: "Equipped Skills" })).toBeTruthy();
  expect(screen.getByRole("option", { name: /storyboard/i })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /research/i })).toBeNull();

  fireEvent.click(screen.getByRole("option", { name: /storyboard/i }));
  expect(input).toHaveProperty("value", "/skill:storyboard ");

  fireEvent.change(input, {
    target: { value: "/skill:storyboard split this scene" },
  });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
  expect(onSend).toHaveBeenCalledWith("/skill:storyboard split this scene");
});

it("opens equipped Skill commands when the user types slash", () => {
  render(<MessageInput onSend={vi.fn()} skills={skills} />);

  fireEvent.change(screen.getByPlaceholderText("Send a message..."), {
    target: { value: "/" },
  });

  expect(screen.getByRole("listbox", { name: "Equipped Skills" })).toBeTruthy();
  expect(screen.getAllByRole("option")).toHaveLength(2);
});

it("selects the highlighted Skill with Enter instead of sending an incomplete query", () => {
  const onSend = vi.fn();
  render(<MessageInput onSend={onSend} skills={skills} />);

  const input = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(input, { target: { value: "/skill:" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  expect(onSend).not.toHaveBeenCalled();
  expect(input).toHaveProperty("value", "/skill:storyboard ");
});

it("supports keyboard navigation, Tab selection, and Escape dismissal", () => {
  const onSend = vi.fn();
  render(<MessageInput onSend={onSend} skills={skills} />);

  const input = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(input, { target: { value: "/skill:" } });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Tab" });
  expect(input).toHaveProperty("value", "/skill:research ");
  expect(onSend).not.toHaveBeenCalled();

  fireEvent.change(input, { target: { value: "/skill:" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("listbox", { name: "Equipped Skills" })).toBeNull();
});

it("shows Stop while a Turn is running and stops it on click (issue #113)", () => {
  const onSend = vi.fn();
  const onInterrupt = vi.fn();
  render(<MessageInput onSend={onSend} onInterrupt={onInterrupt} running />);

  // Stop needs no typed text to be meaningful, so the button is live right away.
  const stop = screen.getByRole("button", { name: "Stop generating" });
  expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  expect(stop).toHaveProperty("disabled", false);

  fireEvent.click(stop);
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});

it("shows Send when the Session is idle, unchanged", () => {
  const onSend = vi.fn();
  const onInterrupt = vi.fn();
  render(<MessageInput onSend={onSend} onInterrupt={onInterrupt} running={false} />);

  expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toHaveProperty("disabled", true);

  fireEvent.change(screen.getByPlaceholderText("Send a message..."), {
    target: { value: "hello" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(onSend).toHaveBeenCalledWith("hello");
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("still queues typed messages while a Turn is running", () => {
  // An Interrupt ends the current Turn only; the queue keeps running, so typing
  // ahead must stay possible even though the button says Stop.
  const onSend = vi.fn();
  render(<MessageInput onSend={onSend} onInterrupt={vi.fn()} running />);

  const input = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(input, { target: { value: "next up" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  expect(onSend).toHaveBeenCalledWith("next up");
});

it("keeps the Send button when running without an interrupt handler", () => {
  render(<MessageInput onSend={vi.fn()} running />);
  expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
});

it("lists Queued Input regardless of whether a Turn is running (issue #114)", () => {
  // The strip describes the Host's queue, so an idle Session with input waiting
  // — the gap an Interrupt opens — must still show it.
  const queuedInput = [
    { id: "pending_1", text: "first in line" },
    { id: "pending_2", text: "second in line" },
  ];
  const { rerender } = render(
    <MessageInput onSend={vi.fn()} queuedInput={queuedInput} running={false} />,
  );

  expect(screen.getByLabelText("Queued input")).toBeTruthy();
  expect(screen.getByText("first in line")).toBeTruthy();
  expect(screen.getByText("second in line")).toBeTruthy();
  expect(screen.getAllByText("queued")).toHaveLength(2);

  rerender(
    <MessageInput
      onSend={vi.fn()}
      queuedInput={queuedInput}
      running
      onInterrupt={vi.fn()}
    />,
  );
  expect(screen.getAllByText("queued")).toHaveLength(2);
});

it("notes that more Queued Input exists than it lists", () => {
  render(
    <MessageInput
      onSend={vi.fn()}
      queuedInput={[{ id: "pending_1", text: "shown" }]}
      hasMoreQueuedInput
    />,
  );

  expect(screen.getByText("More input is queued")).toBeTruthy();
});

it("renders no queued strip when nothing is waiting", () => {
  render(<MessageInput onSend={vi.fn()} queuedInput={[]} running />);

  expect(screen.queryByLabelText("Queued input")).toBeNull();
  expect(screen.queryByText("queued")).toBeNull();
  expect(screen.queryByText("More input is queued")).toBeNull();
});

it("preserves Shift+Enter and IME composition behavior", () => {
  const onSend = vi.fn();
  render(<MessageInput onSend={onSend} skills={skills} />);

  const input = screen.getByPlaceholderText("Send a message...");
  fireEvent.change(input, { target: { value: "draft" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });

  expect(onSend).not.toHaveBeenCalled();
  expect(input).toHaveProperty("value", "draft");
});
