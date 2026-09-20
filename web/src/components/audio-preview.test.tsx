// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "@/lib/file-source";
import { AudioPreview } from "./audio-preview";

const content: FileContent = {
  path: "audio/voice.mp3", text: null, contentType: "audio/mpeg", size: 2048, isBinary: true,
};

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("AudioPreview", () => {
  it("renders native playback controls without autoplay and requests a separate download", async () => {
    const getPreviewUrl = vi.fn(async () => "https://files.test/voice");
    const onDownload = vi.fn();
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />);
    const player = await screen.findByLabelText(content.path) as HTMLAudioElement;
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("https://files.test/voice");
    expect(player.controls).toBe(true);
    expect(player.autoplay).toBe(false);
    expect(player.preload).toBe("metadata");
    expect(player.crossOrigin).toBe("anonymous");
    expect(getPreviewUrl).toHaveBeenCalledWith(content.path, { signal: expect.any(AbortSignal), forceRefresh: false });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith();
  });

  it("refreshes once, resumes audio, and bounds metadata-success/decode-failure loops", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const getPreviewUrl = vi.fn().mockResolvedValueOnce("https://files.test/first").mockResolvedValueOnce("https://files.test/second");
    const onDownload = vi.fn();
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />);
    const initial = await screen.findByLabelText(content.path) as HTMLAudioElement;
    initial.currentTime = 25;
    fireEvent.play(initial);
    Object.defineProperty(initial, "error", { configurable: true, value: { code: 2 } });
    fireEvent.pause(initial);
    fireEvent.error(initial);
    await waitFor(() => expect(screen.getByLabelText(content.path).getAttribute("src")).toBe("https://files.test/second"));
    const fresh = screen.getByLabelText(content.path) as HTMLAudioElement;
    fireEvent.loadedMetadata(fresh);
    expect(fresh.currentTime).toBe(25);
    expect(initial.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.error(fresh);
    expect(await screen.findByText(/failed to load audio/i)).toBeTruthy();
    expect(getPreviewUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Download instead" }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith();
  });

  it("allows another expiry refresh after a recovered stream actually plays", async () => {
    const getPreviewUrl = vi.fn().mockResolvedValueOnce("https://files.test/first").mockResolvedValueOnce("https://files.test/second").mockResolvedValueOnce("https://files.test/third");
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={vi.fn()} />);
    fireEvent.error(await screen.findByLabelText(content.path));
    await waitFor(() => expect(screen.getByLabelText(content.path).getAttribute("src")).toBe("https://files.test/second"));
    const fresh = screen.getByLabelText(content.path) as HTMLAudioElement;
    fireEvent.loadedMetadata(fresh);
    Object.defineProperty(fresh, "paused", { configurable: true, value: false });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    fresh.currentTime = 10;
    fireEvent.timeUpdate(fresh);
    clock.mockReturnValue(2_000);
    fresh.currentTime = 11;
    fireEvent.timeUpdate(fresh);
    fireEvent.error(fresh);
    await waitFor(() => expect(screen.getByLabelText(content.path).getAttribute("src")).toBe("https://files.test/third"));
    expect(getPreviewUrl).toHaveBeenCalledTimes(3);
  });

  it("offers download when fetching the preview fails", async () => {
    const getPreviewUrl = vi.fn().mockRejectedValue(new Error("unavailable"));
    const onDownload = vi.fn();
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />);
    expect(await screen.findByText(/failed to load audio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download instead" }));
    expect(onDownload).toHaveBeenCalledExactlyOnceWith();
    expect(getPreviewUrl).toHaveBeenCalledTimes(1);
  });
});
