// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "@/lib/hooks/use-session-events";
import type { SessionEvent } from "@/lib/types";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function historicalEvent(seq: number): SessionEvent {
  return {
    seq,
    type: "user.message",
    data: { content: [{ type: "text", text: `message ${seq}` }] },
    ts: "2026-07-12T00:00:00.000Z",
  };
}

describe("useSessionEvents history replay", () => {
  it("merges replayed Complete Events without gaps or duplicates", async () => {
    const history = Array.from({ length: 50 }, (_, index) =>
      historicalEvent(index + 1),
    );
    const replayFrames =
      "event: user.message\n" +
      "id: 50\n" +
      'data: {"content":[{"type":"text","text":"message 50"}]}\n\n' +
      "event: workspace.file_change\n" +
      "id: 51\n" +
      'data: {"workspaceId":"workspace_1","changed":["image.png"],"deleted":[]}\n\n';

    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Accept === "application/json") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ data: history, has_more: true }),
          } as Response);
        }

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(replayFrames));
            init?.signal?.addEventListener(
              "abort",
              () => controller.close(),
              { once: true },
            );
          },
        });
        return Promise.resolve({ ok: true, body } as Response);
      }),
    );

    const { result } = renderHook(() => useSessionEvents("session_1"));

    await waitFor(() => expect(result.current.fileChange.nonce).toBe(1));
    expect(result.current.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 51 }, (_, index) => index + 1),
    );
  });
});
