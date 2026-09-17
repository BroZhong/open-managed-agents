// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import SharedSessionPage from "./shared-session";

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reads all pages without owner credentials, opens Workspace links read-only and refreshes current content", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("oma_api_key", "owner-secret");
  const downloads: Array<{ href: string; filename: string }> = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download });
  });
  let version = 1;
  const event = (seq: number, text: string) => ({ seq, type: "agent.message", data: { content: [{ type: "text", text }] }, ts: "2026-09-17T00:00:00Z" });
  const fetcher = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    expect(options?.credentials).toBe("omit");
    if (url.hostname === "storage.example.test") {
      expect(new Headers(options?.headers).has("x-session-share")).toBe(false);
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return new Response(`Report v${version}`);
    }
    expect(new Headers(options?.headers).get("x-session-share")).toBe("share-one");
    expect(new Headers(options?.headers).has("authorization")).toBe(false);
    expect(new Headers(options?.headers).get("accept")).not.toBe("text/event-stream");
    if (url.pathname === "/v1/shares/share-one") return Response.json({ sessionId: "s1", workspaceId: "w1" });
    if (url.pathname === "/v1/sessions/s1") return Response.json({ id: "s1", title: "Shared work", workspaceId: "w1", agent: { name: "Writer" }, status: "idle" });
    if (url.pathname.endsWith("/events")) return Response.json(url.searchParams.has("after_seq") ? { data: [event(2, `Last page ${version}\n\n[Report](/home/user/workspace/report.txt) [Child](/sessions/child) [Skill](/skills/private/SKILL.md) [Missing](/home/user/workspace/missing.txt)`)], has_more: false } : { data: [event(1, "[Report](/home/user/workspace/report.txt) [Child](/sessions/child) [Skill](/skills/private/SKILL.md)")], has_more: true });
    if (url.pathname.endsWith("/files")) return Response.json({ data: [{ path: "report.txt", size: 9 }] });
    if (url.pathname.endsWith("/files/report.txt")) return Response.json({ path: "report.txt", url: "https://storage.example.test/report.txt", size: 9, contentType: "text/plain", expiresIn: 600, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    if (url.pathname.endsWith("/files/missing.txt")) return Response.json({ error: "File not found" }, { status: 404 });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  render(<MemoryRouter initialEntries={["/share/share-one"]}><Routes><Route path="/share/:shareId" element={<SharedSessionPage />} /></Routes></MemoryRouter>);
  await screen.findByText("Last page 1");
  expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
  expect(screen.queryByRole("link", { name: "Child" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Skill" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Report" }));
  await screen.findByText("Report v1");
  expect(screen.queryByRole("textbox", { name: "File content" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New file" })).toBeNull();
  version = 2;
  fireEvent.click(screen.getByRole("button", { name: "Refresh share" }));
  await screen.findByText("Last page 2");
  await screen.findByText("Report v2");
  fireEvent.click(screen.getByRole("button", { name: "Download file" }));
  await waitFor(() => expect(downloads).toEqual([{ href: "https://storage.example.test/report.txt", filename: "report.txt" }]));
  fireEvent.click(screen.getByRole("link", { name: "Missing" }));
  await screen.findByText("File not found");
  expect(screen.queryByRole("heading", { name: "分享已失效" })).toBeNull();
  expect(localStorage.getItem("oma_api_key")).toBe("owner-secret");
});

it("shows an unavailable page without clearing ordinary login state or redirecting", async () => {
  localStorage.setItem("oma_api_key", "owner-secret");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Share unavailable" }, { status: 404 })));
  render(<MemoryRouter initialEntries={["/share/missing"]}><Routes><Route path="/share/:shareId" element={<SharedSessionPage />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("heading", { name: "分享已失效" })).toBeTruthy());
  expect(localStorage.getItem("oma_api_key")).toBe("owner-secret");
});
