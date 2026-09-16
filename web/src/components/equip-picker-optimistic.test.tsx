// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { EquipPicker } from "@/components/equip-picker";
import type { Agent } from "@/lib/hooks/use-agents";
import { useEquipSkill, useUnequipSkill } from "@/lib/hooks/use-skills";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const agent: Agent = { id: "agent", tenantId: "dev", name: "Writer", model: "m", system: "s", runtime: "mock", createdAt: "2026-09-16", updatedAt: "2026-09-16" };
const fork = { id: "fork", name: "Research", description: "Research workflow", sourceSkillId: "library", createdAt: null, updatedAt: "2026-09-16" };
const key = ["agents", agent.id, "skills"];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  return { client, wrapper };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("waits for equipped Skills before allowing imports and retries load failures", async () => {
  const { wrapper } = setup();
  const request = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ error: "Load failed" }, 503)).mockReturnValueOnce(request.promise));
  render(<EquipPicker agent={agent} />, { wrapper });
  expect(screen.getByRole("button", { name: "Import Skills" })).toHaveProperty("disabled", true);
  expect((await screen.findByRole("alert")).textContent).toContain("Load failed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(async () => request.resolve(response({ data: [] })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Import Skills" })).toHaveProperty("disabled", false));
});

it("keeps imports disabled across remounts until an equip completes and uses its returned copy", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(key, []);
  const request = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(() => request.promise));
  const { result } = renderHook(() => useEquipSkill(agent.id), { wrapper });
  act(() => result.current.mutate("library"));
  await waitFor(() => expect(result.current.isPending).toBe(true));
  const view = render(<EquipPicker agent={agent} />, { wrapper });
  expect(screen.getByRole("button", { name: "Import Skills" })).toHaveProperty("disabled", true);
  view.unmount();
  render(<EquipPicker agent={agent} />, { wrapper });
  expect(screen.getByRole("button", { name: "Upload & Equip" })).toHaveProperty("disabled", true);
  await act(async () => request.resolve(response(fork)));
  await screen.findByRole("link", { name: "Open Research" });
  expect(client.getQueryData(key)).toEqual([fork]);
  expect(screen.getByRole("button", { name: "Import Skills" })).toHaveProperty("disabled", false);
});

it.each([true, false])("removes an equipped card only after a successful deletion: %s", async (success) => {
  const { client, wrapper } = setup();
  client.setQueryData(key, [fork]);
  const request = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(() => request.promise));
  const { result } = renderHook(() => useUnequipSkill(agent.id), { wrapper });
  render(<EquipPicker agent={agent} />, { wrapper });
  act(() => result.current.mutate(fork.id));
  await waitFor(() => expect(screen.getByRole("button", { name: "Unequip Research" })).toHaveProperty("disabled", true));
  expect(screen.getByRole("link", { name: "Open Research" })).toBeTruthy();
  await act(async () => request.resolve(response(success ? { type: "skill_unequipped" } : { error: "Write failed" }, success ? 200 : 500)));
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(client.getQueryData(key)).toEqual(success ? [] : [fork]);
});

it("a failed equip leaves the Agent's existing copies intact", async () => {
  const { client, wrapper } = setup();
  client.setQueryData(key, [fork]);
  vi.stubGlobal("fetch", vi.fn(async () => response({ error: "Write failed" }, 500)));
  const { result } = renderHook(() => useEquipSkill(agent.id), { wrapper });
  act(() => result.current.mutate("another"));
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(client.getQueryData(key)).toEqual([fork]);
});
