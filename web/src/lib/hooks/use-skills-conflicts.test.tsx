// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useEquipSkill, useUploadSkills } from "./use-skills";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{children}</QueryClientProvider>;
const conflict = () => new Response(JSON.stringify({ error: 'Skill "greeter" exists', code: "skill_name_conflict" }), { status: 409 });

it.each([false, true])("upload conflict asks for confirmation, overwrite=%s", async (confirmed) => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(confirmed);
  const calls: (FormDataEntryValue | null)[] = [];
  const fetch = vi.fn(async (_url, init: RequestInit) => {
    calls.push((init.body as FormData).get("overwrite"));
    return calls.length === 1 ? conflict() : new Response(JSON.stringify({ data: [] }));
  });
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useUploadSkills(), { wrapper });
  await act(() => result.current.mutateAsync([{ path: "SKILL.md", file: new File(["name: greeter"], "SKILL.md") }]));
  expect(confirm).toHaveBeenCalledOnce();
  expect(calls).toEqual(confirmed ? [null, "true"] : [null]);
});

it("Agent equip retries only after confirmation with overwrite enabled", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const fetch = vi.fn().mockResolvedValueOnce(conflict()).mockResolvedValueOnce(new Response(JSON.stringify({ id: "fork", name: "greeter", sourceSkillId: "library" })));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useEquipSkill("agent"), { wrapper });
  await act(() => result.current.mutateAsync("library"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ skillId: "library", overwrite: true });
});
