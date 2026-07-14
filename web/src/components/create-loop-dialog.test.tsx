// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateLoopDialog } from "@/components/create-loop-dialog";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("CreateLoopDialog", () => {
  it("posts the configured recurring Loop for the active Agent", async () => {
    localStorage.setItem("oma_api_key", "console-token");
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          id: "loop_session_review",
          tenantId: "tenant_1",
          agentId: "agent_analyst",
          name: "Session improvement review",
          description: "Review recent Agent behavior",
          prompt: "Analyze the last seven days of Sessions and propose improvements.",
          intervalMinutes: 5,
          enabled: true,
          nextRunAt: "2026-07-14T00:05:00.000Z",
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:00:00.000Z",
        }),
      }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <CreateLoopDialog
          agentId="agent_analyst"
          open
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "New Loop" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("form", { name: "New Loop" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Loop name"), {
      target: { value: "  Session improvement review  " },
    });
    fireEvent.change(screen.getByLabelText("Loop description"), {
      target: { value: "  Review recent Agent behavior  " },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: {
        value: "  Analyze the last seven days of Sessions and propose improvements.  ",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Loop" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3000/v1/agents/agent_analyst/loops");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer console-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      name: "Session improvement review",
      description: "Review recent Agent behavior",
      prompt: "Analyze the last seven days of Sessions and propose improvements.",
      intervalMinutes: 5,
      enabled: true,
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
