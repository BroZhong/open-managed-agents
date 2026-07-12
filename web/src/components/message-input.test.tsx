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
