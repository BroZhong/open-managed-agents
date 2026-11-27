// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TrajectoryView } from "./trajectory-view";
import type { SessionEvent } from "@/lib/types";

const events: SessionEvent[] = [
  { seq: 1, type: "agent.tool_use", ts: "2026-11-27T00:00:00Z", data: { name: "read", toolUseId: "r1" } },
  { seq: 2, type: "agent.tool_use", ts: "2026-11-27T00:00:01Z", data: { name: "bash", toolUseId: "b1" } },
  { seq: 3, type: "agent.thinking", ts: "2026-11-27T00:00:02Z", data: { text: "Plan" } },
  { seq: 4, type: "agent.message", ts: "2026-11-27T00:00:03Z", data: { content: [{ type: "text", text: "Done" }] } },
  { seq: 5, type: "agent.tool_result", ts: "2026-11-27T00:00:04Z", data: { toolUseId: "r1", payloadRef: { bytes: 1000000 } } },
];

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows action and tool proportions with their own denominators, updating when actions arrive", () => {
  const { rerender } = render(<TrajectoryView sessionId="s1" events={events} />);
  expect(screen.getByText("4 recorded actions")).toBeTruthy();
  const mix = within(screen.getByRole("region", { name: "Behavior mix" }));
  expect(mix.getByRole("group").getAttribute("aria-label")).toBe("Behavior mix: Tool calls 50%, Thinking 25%, Output 25%");
  const usage = within(screen.getByRole("region", { name: "Tool usage" }));
  expect(usage.getByRole("group").getAttribute("aria-label")).toBe("Tool usage: bash 50%, read 50%");
  const initialReadColor = usage.getByText("read").previousElementSibling?.getAttribute("style");
  rerender(<TrajectoryView sessionId="s1" events={[...events, { ...events[0], seq: 6, data: { name: "read", toolUseId: "r2" } }]} />);
  expect(screen.getByText("5 recorded actions")).toBeTruthy();
  expect(mix.getByRole("group").getAttribute("aria-label")).toBe("Behavior mix: Tool calls 60%, Thinking 20%, Output 20%");
  expect(usage.getByRole("group").getAttribute("aria-label")).toBe("Tool usage: read 66.7%, bash 33.3%");
  expect(usage.getByText("read").previousElementSibling?.getAttribute("style")).toBe(initialReadColor);
});

it("links chart selection to its item, keeps it through live updates, and allows clearing or selecting from the item", () => {
  const { rerender } = render(<TrajectoryView sessionId="s1" events={events} />);
  const usage = within(screen.getByRole("region", { name: "Tool usage" }));
  const chart = within(usage.getByRole("group"));
  const read = chart.getByRole("button", { name: "read: 1 (50%)" });
  const readItem = document.getElementById(read.getAttribute("aria-controls")!);
  fireEvent.click(read);
  expect(read.getAttribute("aria-pressed")).toBe("true");
  expect(usage.getByRole("button", { name: "Highlight read" }).getAttribute("aria-pressed")).toBe("true");
  expect(readItem?.className).toContain("bg-[var(--color-accent-muted)]");
  expect(vi.mocked(HTMLElement.prototype.scrollIntoView).mock.instances.at(-1)).toBe(readItem);
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });

  rerender(<TrajectoryView sessionId="s1" events={[...events, { ...events[0], seq: 6 }]} />);
  expect(chart.getByRole("button", { name: "read: 2 (66.7%)" }).getAttribute("aria-pressed")).toBe("true");
  expect(document.getElementById(read.getAttribute("aria-controls")!)).toBe(readItem);

  fireEvent.click(usage.getByRole("button", { name: "Highlight bash" }));
  expect(read.getAttribute("aria-pressed")).toBe("false");
  const bash = chart.getByRole("button", { name: "bash: 1 (33.3%)" });
  expect(bash.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(bash);
  expect(usage.getAllByRole("button").every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);

  const mix = within(screen.getByRole("region", { name: "Behavior mix" }));
  fireEvent.click(within(mix.getByRole("group")).getByRole("button", { name: "Thinking: 1 (20%)" }));
  expect(mix.getByRole("button", { name: "Highlight Thinking" }).getAttribute("aria-pressed")).toBe("true");
  expect(usage.getAllByRole("button").every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
});

it("keeps shared event details lazy when switching between summary and the event log", async () => {
  const ownerFetch = vi.fn();
  vi.stubGlobal("fetch", ownerFetch);
  const load = vi.fn().mockResolvedValue({ content: "Full shared result" });
  render(<TrajectoryView sessionId="shared" events={events} loadEventData={load} />);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Event log" }));
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /agent.tool_result/ }));
  expect(await screen.findByText(/Full shared result/)).toBeTruthy();
  expect(load).toHaveBeenCalledWith(5, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "Behavior" }));
  expect(screen.getByText("4 recorded actions")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  expect(ownerFetch).not.toHaveBeenCalled();
});

it("gives the six displayed tools distinct colors instead of colliding by name hash", () => {
  const tools = ["read", "bash", "edit", "search", "Agent", "write"];
  render(<TrajectoryView sessionId="s1" events={tools.map((name, index) => ({
    seq: index + 1,
    type: name === "search" ? "agent.mcp_tool_use" : "agent.tool_use",
    data: { name, ...(name === "search" ? { serverName: "docs" } : {}) },
    ts: "2026-11-27T00:00:00Z",
  }))} />);
  const usage = within(screen.getByRole("region", { name: "Tool usage" }));
  const colors = tools.map((name) => usage.getByText(name === "search" ? "MCP · docs / search" : name)
    .previousElementSibling?.getAttribute("style"));
  expect(colors.every(Boolean)).toBe(true);
  expect(new Set(colors).size).toBe(tools.length);
});

it("shows clear empty and no-tool states without invalid percentages", () => {
  const { rerender } = render(<TrajectoryView sessionId="s1" events={[]} />);
  expect(screen.getByText("No recorded agent actions yet.")).toBeTruthy();
  expect(screen.queryByRole("group")).toBeNull();
  rerender(<TrajectoryView sessionId="s1" events={[events[3]]} />);
  expect(screen.getByText("No tool calls recorded.")).toBeTruthy();
  expect(screen.getByRole("group").getAttribute("aria-label")).toBe("Behavior mix: Output 100%");
});
