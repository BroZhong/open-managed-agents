// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useThinkingOptions, type ThinkingOptions } from "./use-thinking-options";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const options = (model: string): ThinkingOptions => ({ model, choices: [{ value: "off", label: "off" }], resolvedLevels: { off: "off", minimal: "off", low: "off", medium: "off", high: "off", xhigh: "off", max: "off" }, defaultLevel: "off" });
it("loads on entry and model change, reuses fresh cache, and makes only metadata requests", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(options("first"))).mockResolvedValueOnce(Response.json(options("second")));
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(({ model }) => useThinkingOptions("session", model, "pi-agent"), { initialProps: { model: "first" }, wrapper });
  await waitFor(() => expect(result.current.data?.model).toBe("first"));
  rerender({ model: "second" });
  await waitFor(() => expect(result.current.data?.model).toBe("second"));
  rerender({ model: "first" });
  await waitFor(() => expect(result.current.data?.model).toBe("first"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetchMock.mock.calls) {
    expect(String(url)).toContain("/v1/sessions/session/thinking-options");
    expect(init?.method ?? "GET").toBe("GET");
  }
});
it("does not load for an absent model or another runtime", () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  renderHook(() => useThinkingOptions("session", undefined, "pi-agent"), { wrapper });
  renderHook(() => useThinkingOptions("session", "model", "mock"), { wrapper });
  expect(request).not.toHaveBeenCalled();
});
