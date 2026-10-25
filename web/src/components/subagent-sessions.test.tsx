// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubagentSessions } from "./subagent-sessions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const open = vi.fn();
  render(<QueryClientProvider client={client}><SubagentSessions sessionId="parent" onOpenExecution={open} /></QueryClientProvider>);
  return { client, open };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const execution = (id: string, childId: string, prompt: string) => ({ id, childId, prompt, status: "completed" });

it("loads more children without duplicating resumed Sessions or replacing their latest task", async () => {
  const latest = execution("new", "child-a", "Latest task\nWith context");
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw);
    expect(url.pathname).toBe("/v1/sessions/parent/delegations");
    return json(url.searchParams.has("after_id")
      ? { data: [execution("old", "child-a", "Original task"), execution("other", "child-b", "Second child")], has_more: false }
      : { data: [latest], has_more: true, next_cursor: "new" });
  }));
  const { open } = setup();
  await screen.findByRole("button", { name: /Open SubAgent: Latest task\s+With context/ });
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("button", { name: "Open SubAgent: Second child" });
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.queryByText("Original task")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Open SubAgent: Latest task\s+With context/ }));
  expect(open).toHaveBeenCalledWith(latest);
});

it("distinguishes loading and failed requests from an empty list and supports retry", async () => {
  let resolve!: (response: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }))
    .mockResolvedValue(json({ data: [], has_more: false }));
  vi.stubGlobal("fetch", fetch);
  setup();
  expect(screen.getByRole("status", { name: "Loading Session" })).toBeTruthy();
  expect(screen.queryByText("No SubAgent Sessions yet.")).toBeNull();
  resolve(json({ error: "Unavailable" }, 503));
  await screen.findByRole("alert");
  expect(screen.queryByText("No SubAgent Sessions yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("No SubAgent Sessions yet.");
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
