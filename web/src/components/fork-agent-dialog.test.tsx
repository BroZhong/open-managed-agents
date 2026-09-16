// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { ForkAgentDialog } from "./fork-agent-dialog";
import type { Agent } from "@/lib/hooks/use-agents";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agent: Agent = { id: "source", tenantId: "dev", name: "Research", model: "m", system: "s", runtime: "mock", createdAt: "2026-09-16", updatedAt: "2026-09-16" };

it("forks through the server and navigates to the new Agent", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ...agent, id: "copy", name: "Research copy", skills: ["new-skill"] })));
  vi.stubGlobal("fetch", fetch);
  const onClose = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/agents/source"]}><Routes>
    <Route path="/agents/source" element={<ForkAgentDialog agent={agent} onClose={onClose} />} />
    <Route path="/agents/copy" element={<p>Copied Agent</p>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Research copy" } });
  fireEvent.click(screen.getByRole("button", { name: "Fork Agent" }));
  expect(await screen.findByText("Copied Agent")).toBeTruthy();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]).toEqual(["http://localhost:3000/v1/agents/source/fork", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Research copy" }) })]);
  expect(onClose).toHaveBeenCalledOnce();
  expect(client.getQueryData(["agents", "copy"])).toMatchObject({ skills: ["new-skill"] });
});
