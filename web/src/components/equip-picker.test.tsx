// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { EquipPicker } from "@/components/equip-picker";
import type { Agent } from "@/lib/hooks/use-agents";
import type { EquippedSkill, Skill } from "@/lib/hooks/use-skills";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const librarySkill: Skill = {
  id: "skill_library_vfs",
  name: "library-vfs",
  description: "Library instructions have changed since this Skill was equipped.",
  createdAt: "2026-08-01T01:00:00.000Z",
  updatedAt: "2026-09-06T02:00:00.000Z",
};
const agentSkill: EquippedSkill = {
  id: "skill_agent_vfs",
  name: "agent-vfs",
  description: "This Agent's private VFS instructions.",
  sourceSkillId: librarySkill.id,
  createdAt: "2026-08-04T03:00:00.000Z",
  updatedAt: "2026-08-08T04:00:00.000Z",
};
const inactiveSkill: Skill = {
  id: "skill_library_video",
  name: "video-analysis",
  description: "Analyze video files.",
  createdAt: null,
  updatedAt: "2026-09-02T05:00:00.000Z",
};
const orphanSkill: EquippedSkill = {
  ...agentSkill,
  id: "skill_agent_media",
  name: "retained-media",
  description: "An equipped Skill whose Library source was deleted.",
  sourceSkillId: "skill_deleted_library_source",
};
const agent: Agent = {
  id: "agent_storyboard",
  tenantId: "tenant_1",
  name: "Storyboard Agent",
  model: "openai-codex/gpt-5.5",
  system: "Create storyboards",
  runtime: "pi-agent",
  skills: [agentSkill.id],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};
const initialContent = "---\nname: agent-vfs\ndescription: This Agent's private VFS instructions.\n---\nOriginal instructions.\n";
const agentSkillsPath = `/v1/agents/${agent.id}/skills`;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function mockSkillApi(
  library: Skill[] = [librarySkill, inactiveSkill],
  equipped: EquippedSkill[] = [agentSkill],
) {
  const state: {
    library: Skill[];
    equipped: EquippedSkill[];
    content: string;
    savedSkill?: EquippedSkill;
    saveError?: string;
    intercept?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
  } = { library, equipped, content: initialContent };

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const intercepted = state.intercept?.(url, init);
    if (intercepted) return intercepted;
    const method = init.method ?? "GET";
    if (url.pathname === "/v1/skills" && method === "GET") {
      return response({ data: state.library, has_more: false });
    }
    if (url.pathname === agentSkillsPath) {
      if (method === "GET") return response({ data: state.equipped });
      if (method === "POST") {
        const { skillId } = JSON.parse(String(init.body)) as { skillId: string };
        const source = state.library.find((skill) => skill.id === skillId);
        if (!source) return response({ message: "Library Skill not found" }, 404);
        const fork: EquippedSkill = {
          ...source,
          id: `fork_${source.id}`,
          sourceSkillId: source.id,
        };
        state.equipped = [...state.equipped, fork];
        return response(fork);
      }
    }
    if (url.pathname.startsWith(`${agentSkillsPath}/`) && method === "DELETE") {
      const forkId = url.pathname.slice(agentSkillsPath.length + 1);
      state.equipped = state.equipped.filter((skill) => skill.id !== forkId);
      return response({ type: "skill.unequipped" });
    }
    // The fixture serves only Agent Skill files. A Library-scoped editor
    // therefore fails instead of silently passing the same assertions.
    for (const fork of state.equipped) {
      const base = `/v1/skills/${fork.id}/files`;
      if (url.pathname === base && method === "GET") {
        return response({ data: ["SKILL.md"] });
      }
      if (url.pathname === `${base}/content`) {
        if (method === "GET") {
          return response({ path: url.searchParams.get("path"), content: state.content });
        }
        if (method === "PUT") {
          if (state.saveError) return response({ message: state.saveError }, 500);
          const { content } = JSON.parse(String(init.body)) as { content: string };
          state.content = content;
          if (state.savedSkill) {
            state.equipped = state.equipped.map((skill) =>
              skill.id === fork.id ? state.savedSkill! : skill,
            );
          }
          return response({ path: "SKILL.md" });
        }
      }
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}${url.search}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { state, fetchMock };
}

function renderPicker() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><EquipPicker agent={agent} /></MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}


function chooseSkillFolder(name = "SKILL.md") {
  const file = new File([initialContent], name, { type: "text/markdown" });
  Object.defineProperty(file, "webkitRelativePath", { value: `my-skill/${name}` });
  fireEvent.change(screen.getByLabelText("Upload Skill folder"), { target: { files: [file] } });
}

async function openImport() {
  const button = screen.getByRole("button", { name: "Import Skills" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  return screen.getByRole("dialog", { name: "Import Skills" });
}

describe("Agent Skills", () => {
  it("shows only equipped cards and links to their private details without loading the Library", async () => {
    const { fetchMock } = mockSkillApi([librarySkill, inactiveSkill], [agentSkill, orphanSkill]);
    renderPicker();
    expect((await screen.findByRole("link", { name: `Open ${agentSkill.name}` })).getAttribute("href")).toBe(`/agents/${agent.id}/skills/${agentSkill.id}`);
    expect(screen.getByRole("link", { name: `Open ${orphanSkill.name}` })).toBeTruthy();
    expect(screen.queryByText(inactiveSkill.name)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/v1/skills"))).toBe(false);
  });

  it("searches and bulk equips only selected Library Skills", async () => {
    const extra = { ...inactiveSkill, id: "extra", name: "other-video" };
    const { state, fetchMock } = mockSkillApi([librarySkill, inactiveSkill, extra]);
    renderPicker();
    const dialog = await openImport();
    await within(dialog).findByRole("checkbox", { name: `Select ${inactiveSkill.name}` });
    expect(within(dialog).queryByRole("checkbox", { name: `Select ${librarySkill.name}` })).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search Skills" }), { target: { value: "video" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select all shown" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Equip selected (2)" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.equipped).toHaveLength(3);
    expect(screen.getByRole("link", { name: `Open ${extra.name}` })).toBeTruthy();
    const posts = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(agentSkillsPath) && init?.method === "POST");
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)).skillId)).toEqual([inactiveSkill.id, extra.id]);
  });

  it("offers Library Skills from subsequent pages in the batch picker", async () => {
    const { state } = mockSkillApi([librarySkill, inactiveSkill], []);
    state.intercept = (url, init) => {
      if (url.pathname === "/v1/skills" && (!init.method || init.method === "GET")) {
        return url.searchParams.has("cursor")
          ? response({ data: [inactiveSkill], has_more: false })
          : response({ data: [librarySkill], has_more: true, next_cursor: librarySkill.id });
      }
    };
    renderPicker();
    const dialog = await openImport();
    expect(await within(dialog).findByRole("checkbox", { name: `Select ${inactiveSkill.name}` })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: `Select ${librarySkill.name}` })).toBeTruthy();
  });

  it("keeps successful imports and retries only the remaining selection after partial failure", async () => {
    const { state, fetchMock } = mockSkillApi([librarySkill, inactiveSkill], []);
    state.intercept = (url, init) => url.pathname === agentSkillsPath && init.method === "POST" && JSON.parse(String(init.body)).skillId === inactiveSkill.id
      ? response({ message: "Equip unavailable" }, 503) : undefined;
    renderPicker();
    const dialog = await openImport();
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Select all shown" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Equip selected (2)" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("retry the remaining selection");
    expect(screen.getByRole("link", { name: `Open ${librarySkill.name}` })).toBeTruthy();
    state.intercept = undefined;
    fireEvent.click(within(dialog).getByRole("button", { name: "Equip selected (1)" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST" && JSON.parse(String(init.body)).skillId === librarySkill.id)).toHaveLength(1);
  });

  it("opens the folder picker and equips uploaded Skills from an empty Library", async () => {
    const { state } = mockSkillApi([], []);
    state.intercept = (url, init) => {
      if (url.pathname === "/v1/skills" && init.method === "POST") {
        expect(JSON.parse(String((init.body as FormData).get("paths")))).toEqual(["SKILL.md"]);
        state.library = [inactiveSkill];
        return response({ data: state.library });
      }
    };
    renderPicker();
    const button = screen.getByRole("button", { name: "Upload & Equip" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    const click = vi.spyOn(screen.getByLabelText("Upload Skill folder"), "click");
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
    chooseSkillFolder();
    expect(await screen.findByRole("link", { name: `Open ${inactiveSkill.name}` })).toBeTruthy();
  });

  it("rejects invalid folders before sending an upload", async () => {
    const { fetchMock } = mockSkillApi([], []);
    renderPicker();
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload & Equip" })).toHaveProperty("disabled", false));
    chooseSkillFolder("README.md");
    expect(screen.getByRole("alert").textContent).toContain("No SKILL.md found");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("confirms unequipping an orphan copy and deletes only that Agent Skill", async () => {
    const { state, fetchMock } = mockSkillApi([], [orphanSkill]);
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: `Unequip ${orphanSkill.name}` }));
    expect(state.equipped).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unequip" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: `Open ${orphanSkill.name}` })).toBeNull());
    expect(fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")?.[0]).toBe(`http://localhost:3000${agentSkillsPath}/${orphanSkill.id}`);
  });
});
