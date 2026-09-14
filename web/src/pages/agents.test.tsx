// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import AgentsPage from "@/pages/agents";
import type { Agent } from "@/lib/hooks/use-agents";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const firstAgent: Agent = {
  id: "agent_storyboard",
  tenantId: "tenant_1",
  name: "Storyboard Agent",
  description: "Create storyboards",
  model: "openai-codex/gpt-5.5",
  system: "Create storyboards",
  runtime: "pi-agent",
  sandbox: { enabled: true },
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
};
const secondAgent: Agent = {
  ...firstAgent,
  id: "agent_review",
  name: "Review Agent",
};

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function CurrentPath() {
  return <output aria-label="Current path">{useLocation().pathname}</output>;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/agents"]}>
        <CurrentPath />
        <Routes>
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<div>Agent details</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Agent list deletion", () => {
  it("opens a named confirmation without navigating and lets the user cancel", async () => {
    const fetchMock = vi.fn(async () =>
      response({ data: [firstAgent, secondAgent], has_more: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const deleteButton = await screen.findByRole("button", {
      name: `Delete ${firstAgent.name}`,
    });
    expect(deleteButton.closest("a")).toBeNull();
    expect(deleteButton.parentElement?.closest("button")).toBeNull();
    fireEvent.click(deleteButton);

    expect(screen.getByRole("heading", { name: "Delete Agent" })).toBeTruthy();
    expect(screen.getByText(
      `Are you sure you want to delete "${firstAgent.name}"? This action cannot be undone.`,
    )).toBeTruthy();
    expect(screen.getByLabelText("Current path").textContent).toBe("/agents");
    expect(fetchMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("heading", { name: "Delete Agent" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: `Open ${firstAgent.name}` })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: `Open ${firstAgent.name}` }));
    expect(screen.getByLabelText("Current path").textContent).toBe(
      `/agents/${firstAgent.id}`,
    );
  });

  it("deletes only the confirmed Agent and refreshes the list after the request completes", async () => {
    let agents = [firstAgent, secondAgent];
    let finishDelete!: (value: Response) => void;
    const deletion = new Promise<Response>((resolve) => { finishDelete = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return deletion;
      return response({ data: agents, has_more: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole("button", {
      name: `Delete ${secondAgent.name}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://localhost:3000/v1/agents/${secondAgent.id}`,
        expect.objectContaining({ method: "DELETE" }),
      );
      expect((screen.getByRole("button", {
        name: `Delete ${secondAgent.name}`,
      }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect(screen.getByRole("button", {
      name: `Delete ${secondAgent.name}`,
    }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", {
      name: `Delete ${firstAgent.name}`,
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: `Open ${secondAgent.name}` })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Delete Agent" })).toBeNull();

    agents = [firstAgent];
    finishDelete(response({ type: "agent.deleted", id: secondAgent.id }));

    await waitFor(() => expect(screen.queryByRole("link", {
      name: `Open ${secondAgent.name}`,
    })).toBeNull());
    expect(screen.getByRole("link", { name: `Open ${firstAgent.name}` })).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith("Agent deleted");
    expect(screen.getByLabelText("Current path").textContent).toBe("/agents");
  });

  it("keeps an Agent when deletion fails, reports the error, and allows retry", async () => {
    let agents = [firstAgent];
    let deletionAttempts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletionAttempts += 1;
        if (deletionAttempts === 1) {
          return response({ message: "Agent has an active Turn" }, 409);
        }
        agents = [];
        return response({ type: "agent.deleted", id: firstAgent.id });
      }
      return response({ data: agents, has_more: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    fireEvent.click(await screen.findByRole("button", {
      name: `Delete ${firstAgent.name}`,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      "Agent has an active Turn",
    ));
    expect(screen.getByRole("link", { name: `Open ${firstAgent.name}` })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", {
      name: `Delete ${firstAgent.name}`,
    }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: `Delete ${firstAgent.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await screen.findByText("No agents yet. Create your first agent to get started.");
    expect(deletionAttempts).toBe(2);
    expect(toast.success).toHaveBeenCalledWith("Agent deleted");
  });
});
