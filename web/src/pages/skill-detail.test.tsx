// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import SkillDetailPage from "./skill-detail";
import SkillsPage from "./skills";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each([false, true])("opens a Skill card in a workbench and saves to its own files (Agent copy: %s)", async (agentCopy) => {
  const skill = { id: agentCopy ? "fork" : "library", name: "research", description: "Research workflow", ownerType: agentCopy ? "agent" : "library", ownerId: agentCopy ? "agent" : "tenant", createdAt: null, updatedAt: "2026-09-16", files: ["SKILL.md", "references/guide.md"] };
  let content = "# Research\n\nOriginal instructions.";
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/skills") return new Response(JSON.stringify({ data: [skill], has_more: false }));
    if (url.pathname === `/v1/skills/${skill.id}`) return new Response(JSON.stringify(skill));
    if (url.pathname === `/v1/skills/${skill.id}/files`) return new Response(JSON.stringify({ data: skill.files }));
    if (url.pathname === `/v1/skills/${skill.id}/files/content`) {
      if (init.method === "PUT") content = JSON.parse(String(init.body)).content;
      return new Response(JSON.stringify({ path: "SKILL.md", content }));
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[agentCopy ? "/agents/agent/skills/fork" : "/skills"]}><Routes>
    <Route path="/skills" element={<SkillsPage />} />
    <Route path="/skills/:skillId" element={<SkillDetailPage />} />
    <Route path="/agents/:id/skills/:skillId" element={<SkillDetailPage />} />
  </Routes></MemoryRouter></QueryClientProvider>);
  if (!agentCopy) fireEvent.click(await screen.findByRole("link", { name: "Open research" }));
  fireEvent.click(await screen.findByText("SKILL.md"));
  expect(await screen.findByRole("heading", { name: "Research" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Search files" })).toBeTruthy();
  expect(screen.queryByText(/alongside the Session/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "File content" }), { target: { value: "# Revised\n\nPrivate edits." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(content).toBe("# Revised\n\nPrivate edits."));
  expect(fetch.mock.calls.find(([, init]) => init?.method === "PUT")?.[0]).toBe(`http://localhost:3000/v1/skills/${skill.id}/files/content`);
  expect(screen.getByRole("link", { name: agentCopy ? "Back to Agent" : "Back to Skills" }).getAttribute("href")).toBe(agentCopy ? "/agents/agent" : "/skills");
});
