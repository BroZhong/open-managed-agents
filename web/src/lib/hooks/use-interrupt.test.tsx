// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useInterrupt } from "@/lib/hooks/use-interrupt";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, ok = true, status = 202) {
  const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
    Promise.resolve({
      ok,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useInterrupt", () => {
  it("posts a lone user.interrupt event for the Session", async () => {
    const fetchMock = stubFetch({ accepted: true, interrupted: true });
    const { result } = renderHook(() => useInterrupt("sess_1"));

    await result.current.interrupt();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/sessions/sess_1/events");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ type: "user.interrupt", data: {} }],
    });
  });

  it("reports true when the Host actually stopped a Turn", async () => {
    stubFetch({ accepted: true, interrupted: true });
    const { result } = renderHook(() => useInterrupt("sess_1"));

    expect(await result.current.interrupt()).toBe(true);
  });

  it("reports false when the Host stopped nothing", async () => {
    // 202 with `interrupted: false` — the request was accepted but there was no
    // running Turn to stop, and the hook must not claim otherwise (issue #113).
    stubFetch({ accepted: true, interrupted: false });
    const { result } = renderHook(() => useInterrupt("sess_1"));

    expect(await result.current.interrupt()).toBe(false);
  });
});
