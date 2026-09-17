// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaPreviewUrl, type PreviewUrlLoader } from "./use-media-preview-url";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("media signed URL lifecycle", () => {
  it("aborts pending signing when unmounted", async () => {
    const getUrl = vi.fn<PreviewUrlLoader>(() => new Promise(() => undefined));
    const view = renderHook(() => useMediaPreviewUrl("movie.mp4", getUrl));
    expect(getUrl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    view.unmount();
    expect(getUrl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("requests one explicitly fresh URL after a media error", async () => {
    const getUrl = vi.fn<PreviewUrlLoader>()
      .mockResolvedValueOnce("https://files.test/first")
      .mockResolvedValueOnce("https://files.test/second");
    const view = renderHook(() => useMediaPreviewUrl("cover.jpg", getUrl));
    await act(async () => undefined);
    expect(view.result.current.url).toBe("https://files.test/first");
    await act(async () => view.result.current.handleError());
    expect(getUrl.mock.calls[1][1]).toMatchObject({ forceRefresh: true });
    expect(view.result.current.url).toBe("https://files.test/second");
    await act(async () => view.result.current.handleError());
    expect(view.result.current.error).toBe(true);
    expect(getUrl).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled preview instead of leaving Loading forever", async () => {
    vi.useFakeTimers();
    const getUrl = vi.fn<PreviewUrlLoader>(() => new Promise(() => undefined));
    const view = renderHook(() => useMediaPreviewUrl("cover.jpg", getUrl));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(getUrl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(view.result.current.error).toBe(true);
    expect(getUrl).toHaveBeenCalledTimes(2);
  });

  it("stops the initial load deadline once native media metadata is ready", async () => {
    vi.useFakeTimers();
    const getUrl = vi.fn<PreviewUrlLoader>().mockResolvedValue("https://files.test/movie");
    const view = renderHook(() => useMediaPreviewUrl("movie.mp4", getUrl));
    await act(async () => undefined);
    act(() => view.result.current.markLoaded());
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(view.result.current.error).toBe(false);
    expect(getUrl).toHaveBeenCalledTimes(1);
  });
});
