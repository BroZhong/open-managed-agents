// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
const editedContent = "---\nname: updated-agent-vfs\ndescription: Updated private instructions.\n---\nUse the revised workflow.\n";
const updatedAgentSkill: EquippedSkill = {
  ...agentSkill,
  name: "updated-agent-vfs",
  description: "Updated private instructions.",
  updatedAt: "2026-09-08T06:30:00.000Z",
};
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
      <EquipPicker agent={agent} />
    </QueryClientProvider>,
  );
  return queryClient;
}

function cardContent(name: string): HTMLElement {
  return screen.getByRole("heading", { name }).parentElement!.parentElement!;
}

function metadata(card: HTMLElement, label: string): HTMLElement {
  return within(card).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

async function openAgentSkillEditor() {
  fireEvent.click(await screen.findByRole("button", { name: `Update ${agentSkill.name}` }));
  fireEvent.click(await screen.findByText("SKILL.md"));
  const editor = await screen.findByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(editor.value).toBe(initialContent));
  return editor;
}

describe("Agent Skill metadata and status", () => {
  it("shows the Agent's fork metadata and all requested fields, with Unknown for a missing upload time", async () => {
    mockSkillApi();
    renderPicker();
    await screen.findByRole("heading", { name: agentSkill.name });

    const equipped = cardContent(agentSkill.name);
    expect(within(equipped).getByText(agentSkill.description)).toBeTruthy();
    expect(metadata(equipped, "ID").textContent).toBe(agentSkill.id);
    expect(metadata(equipped, "Uploaded").querySelector("time")?.dateTime).toBe(agentSkill.createdAt);
    expect(metadata(equipped, "Updated").querySelector("time")?.dateTime).toBe(agentSkill.updatedAt);
    expect((within(equipped).getByRole("checkbox", {
      name: `Enable ${agentSkill.name}`,
    }) as HTMLInputElement).checked).toBe(true);
    expect(within(equipped).getByText("Enabled")).toBeTruthy();
    expect((within(equipped).getByRole("button", {
      name: `Update ${agentSkill.name}`,
    }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(librarySkill.id)).toBeNull();
    expect(screen.queryByText(librarySkill.description)).toBeNull();
    expect(screen.queryByRole("heading", { name: librarySkill.name })).toBeNull();

    const disabled = cardContent(inactiveSkill.name);
    expect(metadata(disabled, "ID").textContent).toBe(inactiveSkill.id);
    expect(within(disabled).getByText(inactiveSkill.description)).toBeTruthy();
    expect(metadata(disabled, "Uploaded").textContent).toBe("Unknown");
    expect(metadata(disabled, "Updated").querySelector("time")?.dateTime).toBe(inactiveSkill.updatedAt);
    expect((within(disabled).getByRole("checkbox", {
      name: `Enable ${inactiveSkill.name}`,
    }) as HTMLInputElement).checked).toBe(false);
    expect(within(disabled).getByText("Disabled")).toBeTruthy();
    expect((within(disabled).getByRole("button", {
      name: `Update ${inactiveSkill.name}`,
    }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retains an equipped Skill after its Library source was deleted and edits its fork", async () => {
    const { fetchMock } = mockSkillApi([], [orphanSkill]);
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: `Update ${orphanSkill.name}` }));

    expect(metadata(cardContent(orphanSkill.name), "ID").textContent).toBe(orphanSkill.id);
    expect(screen.getByText(orphanSkill.description)).toBeTruthy();
    expect((screen.getByRole("checkbox", {
      name: `Enable ${orphanSkill.name}`,
    }) as HTMLInputElement).checked).toBe(true);
    await screen.findByText("SKILL.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000/v1/skills/${orphanSkill.id}/files`,
      expect.any(Object),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: `Enable ${orphanSkill.name}` }));
    expect(screen.getByText(/Its Library source is no longer available, so it cannot be enabled again from this page/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: `Close editor for ${orphanSkill.name}` })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("enables with a Library Skill id, then disables using the newly created fork id", async () => {
    const { fetchMock } = mockSkillApi([inactiveSkill], []);
    renderPicker();
    fireEvent.click(await screen.findByRole("checkbox", { name: `Enable ${inactiveSkill.name}` }));

    await waitFor(() => expect((screen.getByRole("checkbox", {
      name: `Enable ${inactiveSkill.name}`,
    }) as HTMLInputElement).checked).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`http://localhost:3000${agentSkillsPath}`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ skillId: inactiveSkill.id });
    const forkId = `fork_${inactiveSkill.id}`;
    expect(metadata(cardContent(inactiveSkill.name), "ID").textContent).toBe(forkId);
    await waitFor(() => expect((screen.getByRole("checkbox", {
      name: `Enable ${inactiveSkill.name}`,
    }) as HTMLInputElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("checkbox", { name: `Enable ${inactiveSkill.name}` }));

    expect(screen.getByRole("heading", { name: "Disable Skill" })).toBeTruthy();
    expect(screen.getByText(/Enabling it again creates a new copy from the Skill Library/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByRole("checkbox", {
      name: `Enable ${inactiveSkill.name}`,
    }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: `Enable ${inactiveSkill.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Disable and remove copy" }));

    await waitFor(() => expect((screen.getByRole("checkbox", {
      name: `Enable ${inactiveSkill.name}`,
    }) as HTMLInputElement).checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3000${agentSkillsPath}/${forkId}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(metadata(cardContent(inactiveSkill.name), "ID").textContent).toBe(inactiveSkill.id);
  });

  it("withholds equip controls while the Agent's fork list is still loading", async () => {
    let finishLoading!: (value: Response) => void;
    const pendingForks = new Promise<Response>((resolve) => { finishLoading = resolve; });
    const { state, fetchMock } = mockSkillApi();
    state.intercept = (url) => url.pathname === agentSkillsPath ? pendingForks : undefined;
    const queryClient = renderPicker();

    await waitFor(() => expect(queryClient.getQueryData(["skills"])).toEqual(state.library));
    expect(screen.getByText("Loading Skills…")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Update / })).toBeNull();

    finishLoading(response({ data: [agentSkill] }));

    const checkbox = await screen.findByRole("checkbox", { name: `Enable ${agentSkill.name}` });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows a loading failure without offering to equip Skills whose fork status is unknown", async () => {
    const { state, fetchMock } = mockSkillApi();
    state.intercept = (url) => url.pathname === agentSkillsPath
      ? response({ message: "Agent Skills are unavailable" }, 503)
      : undefined;
    renderPicker();

    expect((await screen.findByRole("alert")).textContent).toContain("Agent Skills are unavailable");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Update / })).toBeNull();
    expect(screen.queryByText(/No Skills yet/)).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("Agent Skill online editing", () => {
  it("saves the fork's SKILL.md and refreshes its name, description and update time", async () => {
    const { state, fetchMock } = mockSkillApi();
    state.savedSkill = updatedAgentSkill;
    renderPicker();
    const editor = await openAgentSkillEditor();
    expect(screen.getByText("Editing this Agent's private copy. Changes do not affect the Library Skill.")).toBeTruthy();

    fireEvent.change(editor, { target: { value: editedContent } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved");
    await screen.findByRole("heading", { name: updatedAgentSkill.name });
    const card = cardContent(updatedAgentSkill.name);
    expect(within(card).getByText(updatedAgentSkill.description)).toBeTruthy();
    expect(metadata(card, "ID").textContent).toBe(agentSkill.id);
    expect(metadata(card, "Uploaded").querySelector("time")?.dateTime).toBe(agentSkill.createdAt);
    expect(metadata(card, "Updated").querySelector("time")?.dateTime).toBe(updatedAgentSkill.updatedAt);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(editedContent);
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[0]).toBe(`http://localhost:3000/v1/skills/${agentSkill.id}/files/content`);
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ path: "SKILL.md", content: editedContent });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(agentSkillsPath)).length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`/skills/${librarySkill.id}/files`))).toBe(false);
    expect(state.library).toEqual([librarySkill, inactiveSkill]);
  });

  it("preserves unsaved edits and the previous metadata on a failed save, then allows retry", async () => {
    const { state, fetchMock } = mockSkillApi();
    state.saveError = "Could not save Skill files";
    state.savedSkill = updatedAgentSkill;
    renderPicker();
    const editor = await openAgentSkillEditor();

    fireEvent.change(editor, { target: { value: editedContent } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(state.saveError);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(editedContent);
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByRole("heading", { name: updatedAgentSkill.name })).toBeNull();
    const card = cardContent(agentSkill.name);
    expect(within(card).getByText(agentSkill.description)).toBeTruthy();
    expect(metadata(card, "Updated").querySelector("time")?.dateTime).toBe(agentSkill.updatedAt);
    expect(state.content).toBe(initialContent);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(agentSkillsPath))).toHaveLength(1);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false));

    state.saveError = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved");
    await screen.findByRole("heading", { name: updatedAgentSkill.name });
    expect(metadata(cardContent(updatedAgentSkill.name), "Updated").querySelector("time")?.dateTime).toBe(updatedAgentSkill.updatedAt);
  });
});
