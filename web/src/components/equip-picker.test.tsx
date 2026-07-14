// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EquipPicker } from "@/components/equip-picker";
import type { Agent } from "@/lib/hooks/use-agents";
import type { EquippedSkill, Skill } from "@/lib/hooks/use-skills";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("EquipPicker", () => {
  it("waits for the Agent's equipped Skills before enabling toggles", async () => {
    const agent: Agent = {
      id: "agent_loading",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_loading",
      name: "Loading Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const fork: EquippedSkill = {
      ...librarySkill,
      id: "fork_loading",
      sourceSkillId: librarySkill.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    const request = deferred<Response>();
    const fetchMock = vi.fn(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Loading Skill/ });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    request.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [fork] }),
    } as Response);
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers a retry when the Agent's equipped Skills fail to load", async () => {
    const agent: Agent = {
      id: "agent_retry",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_retry",
      name: "Retry Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    const retry = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "load failed" }),
      } as Response)
      .mockImplementationOnce(() => retry.promise);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Retry Skill/ });
    expect(await screen.findByText("Could not load equipped Skills.")).toBeTruthy();
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    retry.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    } as Response);

    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  });

  it("keeps toggles disabled across a remount while a Skill write is pending", async () => {
    const agent: Agent = {
      id: "agent_remount",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_remount",
      name: "Remount Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const fork: EquippedSkill = {
      ...librarySkill,
      id: "fork_remount",
      sourceSkillId: librarySkill.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);
    const request = deferred<Response>();
    const fetchMock = vi.fn(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const first = render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Remount Skill/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    first.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const remountedToggle = screen.getByRole("button", { name: /Remount Skill/ });
    try {
      expect(remountedToggle.hasAttribute("disabled")).toBe(true);
    } finally {
      request.resolve({
        ok: true,
        status: 201,
        text: async () => JSON.stringify(fork),
      } as Response);
    }
    await waitFor(() =>
      expect(remountedToggle.hasAttribute("disabled")).toBe(false),
    );
  });

  it("shows a Skill as equipped before its fork request finishes", async () => {
    const agent: Agent = {
      id: "agent_1",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_library",
      name: "Fast Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const fork: EquippedSkill = {
      ...librarySkill,
      id: "skill_fork",
      sourceSkillId: librarySkill.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);
    queryClient.setQueryData(["agents", agent.id], agent);

    const post = deferred<Response>();
    const staleGet = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return post.promise;
      return staleGet.promise;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Fast Skill/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    try {
      expect(toggle.getAttribute("aria-pressed")).toBe("true");
      expect(
        queryClient.getQueryData(["agents", agent.id, "skills"]),
      ).toEqual([]);
      void queryClient.refetchQueries({
        queryKey: ["agents", agent.id, "skills"],
        exact: true,
      });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    } finally {
      post.resolve({
        ok: true,
        status: 201,
        text: async () => JSON.stringify(fork),
      } as Response);
    }

    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    staleGet.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [] }),
    } as Response);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      queryClient.getQueryState(["agents", agent.id])?.isInvalidated,
    ).toBe(true);
  });

  it("rolls back the optimistic check when the fork request fails", async () => {
    const agent: Agent = {
      id: "agent_rollback",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_rollback",
      name: "Rollback Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    queryClient.setQueryData(["agents", agent.id, "skills"], []);

    const post = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => post.promise));
    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Rollback Skill/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-pressed")).toBe("true"),
    );
    post.resolve({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "fork failed" }),
    } as Response);

    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a Skill as unequipped before its delete request finishes", async () => {
    const agent: Agent = {
      id: "agent_unequip",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_library_unequip",
      name: "Unequip Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const fork: EquippedSkill = {
      ...librarySkill,
      id: "skill_fork_unequip",
      sourceSkillId: librarySkill.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    queryClient.setQueryData(["agents", agent.id, "skills"], [fork]);

    const request = deferred<Response>();
    const fetchMock = vi.fn(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Unequip Skill/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    try {
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      expect(
        queryClient.getQueryData(["agents", agent.id, "skills"]),
      ).toEqual([fork]);
    } finally {
      request.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ type: "skill_unequipped" }),
      } as Response);
    }

    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      queryClient.getQueryData(["agents", agent.id, "skills"]),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back the optimistic uncheck when the delete request fails", async () => {
    const agent: Agent = {
      id: "agent_unequip_rollback",
      tenantId: "tenant_1",
      name: "Writer",
      model: "test/model",
      system: "test",
      runtime: "pi-agent",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const librarySkill: Skill = {
      id: "skill_unequip_rollback",
      name: "Unequip Rollback Skill",
      description: "Reusable capability",
      updatedAt: "2026-07-14T00:00:00.000Z",
    };
    const fork: EquippedSkill = {
      ...librarySkill,
      id: "fork_unequip_rollback",
      sourceSkillId: librarySkill.id,
    };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["skills"], [librarySkill]);
    queryClient.setQueryData(["agents", agent.id, "skills"], [fork]);
    const request = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => request.promise));
    render(
      <QueryClientProvider client={queryClient}>
        <EquipPicker agent={agent} />
      </QueryClientProvider>,
    );

    const toggle = screen.getByRole("button", { name: /Unequip Rollback Skill/ });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-pressed")).toBe("false"),
    );
    request.resolve({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "delete failed" }),
    } as Response);

    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      queryClient.getQueryData(["agents", agent.id, "skills"]),
    ).toEqual([fork]);
  });
});
