// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ConversationView } from "./conversation-view";
import { FileManager } from "./file-manager";
import type { FileSource } from "@/lib/file-source";
import type { SessionEvent } from "@/lib/types";

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; });
const skill = { id: "agent-skill", name: "research", description: "", sourceSkillId: "library", createdAt: null, updatedAt: "2026-09-16" };
function Harness({ source, text }: { source: FileSource; text: string }) {
  const [openPath, setOpenPath] = useState<{ path: string; nonce: number }>();
  const events: SessionEvent[] = [{ seq: 1, type: "agent.message", ts: "2026-09-16", data: { content: [{ type: "text", text }] } }];
  return <><FileManager source={source} presentation="workbench" turnStatus="idle" fileSelection={openPath} /><ConversationView resources={{ agentId: "agent", skills: [skill], onOpenWorkspacePath: (path) => setOpenPath((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 })) }} events={events} sessionStatus="idle" /></>;
}
function setup(text: string, read: FileSource["read"] = vi.fn(async (path: string) => ({ path, text: "Chapter content", contentType: "text/plain", size: 15, isBinary: false }))) {
  const source: FileSource = { capabilities: { hierarchy: "nested", idleGated: false }, list: vi.fn(async () => [{ path: "novels/73995/chapters/EP1.txt", isDir: false }, { path: "empty", isDir: true }]), read };
  render(<MemoryRouter><Routes><Route path="/" element={<Harness source={source} text={text} />} /><Route path="/agents/agent/skills/agent-skill" element={<p>Private Skill detail</p>} /></Routes></MemoryRouter>);
  return { source, read };
}
it.each(["novels/73995/chapters", "/home/user/workspace/novels/73995/chapters/", "empty/"])("opens directory %s without reading it as a file", async (path) => {
  const { read } = setup(`[Open directory](${path})`);
  fireEvent.click(screen.getByRole("link", { name: "Open directory" }));
  const folder = path.startsWith("empty") ? "empty" : "chapters";
  await waitFor(() => expect(screen.getByRole("button", { name: folder })).toHaveProperty("ariaExpanded", "true"));
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByText(/Failed to load file/)).toBeNull();
});
it("opens a real file from a conversation link", async () => {
  const { read } = setup("[Chapter](novels/73995/chapters/EP1.txt)");
  fireEvent.click(screen.getByRole("link", { name: "Chapter" }));
  expect(await screen.findByText("Chapter content")).toBeTruthy();
  expect(read).toHaveBeenCalledWith("novels/73995/chapters/EP1.txt", { signal: expect.any(AbortSignal) });
});
it("links Skill directories and inline Skill paths to the Agent copy, keeping code blocks literal", () => {
  const { read } = setup("[Skill](/skills/research/) and `/skills/research/SKILL.md`\n\n```\n/skills/research/SKILL.md\n```\n\n[Missing](/skills/missing)");
  expect(screen.getByRole("link", { name: "/skills/research/SKILL.md" }).getAttribute("href")).toBe("/agents/agent/skills/agent-skill");
  expect(screen.queryByRole("link", { name: "Missing" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Skill" }));
  expect(screen.getByText("Private Skill detail")).toBeTruthy();
  expect(read).not.toHaveBeenCalled();
});
it("ignores an old file response after switching to a directory", async () => {
  let finish!: (value: Awaited<ReturnType<FileSource["read"]>>) => void;
  const read = vi.fn(() => new Promise<Awaited<ReturnType<FileSource["read"]>>>((resolve) => { finish = resolve; }));
  setup("[Chapter](novels/73995/chapters/EP1.txt) [Folder](novels/73995/chapters)", read);
  fireEvent.click(screen.getByRole("link", { name: "Chapter" }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("link", { name: "Folder" }));
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  await act(async () => finish({ path: "novels/73995/chapters/EP1.txt", text: "Stale file", contentType: "text/plain", size: 10, isBinary: false }));
  expect(screen.queryByText("Stale file")).toBeNull();
});
