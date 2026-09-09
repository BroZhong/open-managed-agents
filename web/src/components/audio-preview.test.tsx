// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContent } from "@/lib/file-source";
import { AudioPreview } from "./audio-preview";

const content: FileContent = {
  path: "audio/voice.mp3",
  text: null,
  contentType: "audio/mpeg",
  size: 2048,
  isBinary: true,
};

const revokeObjectURL = vi.fn();

beforeEach(() => {
  revokeObjectURL.mockReset();
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AudioPreview", () => {
  it("renders native playback controls without autoplay and downloads the loaded URL", async () => {
    const getPreviewUrl = vi.fn(async () => "blob:voice");
    const onDownload = vi.fn();
    const view = render(
      <AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />,
    );

    const player = await screen.findByLabelText(content.path) as HTMLAudioElement;
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("blob:voice");
    expect(player.controls).toBe(true);
    expect(player.autoplay).toBe(false);
    expect(player.preload).toBe("metadata");
    expect(getPreviewUrl).toHaveBeenCalledWith(content.path);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledWith("blob:voice");

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice");
  });

  it("refreshes a failed URL once, releases the old Blob, then offers a download fallback", async () => {
    const getPreviewUrl = vi.fn()
      .mockResolvedValueOnce("blob:first")
      .mockResolvedValueOnce("blob:second");
    const onDownload = vi.fn();
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />);

    fireEvent.error(await screen.findByLabelText(content.path));
    await waitFor(() => {
      expect(screen.getByLabelText(content.path).getAttribute("src")).toBe("blob:second");
    });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first");
    fireEvent.error(screen.getByLabelText(content.path));

    expect(await screen.findByText(/failed to load audio/i)).toBeTruthy();
    expect(getPreviewUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Download instead" }));
    expect(onDownload).toHaveBeenCalledWith("blob:second");
  });

  it("offers download when fetching the preview fails", async () => {
    const getPreviewUrl = vi.fn().mockRejectedValue(new Error("unavailable"));
    const onDownload = vi.fn();
    render(<AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={onDownload} />);

    expect(await screen.findByText(/failed to load audio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download instead" }));
    expect(onDownload).toHaveBeenCalledWith(undefined);
    expect(getPreviewUrl).toHaveBeenCalledTimes(1);
  });

  it("releases a Blob URL that arrives after unmounting", async () => {
    let finish!: (url: string) => void;
    const getPreviewUrl = vi.fn(() => new Promise<string>((resolve) => {
      finish = resolve;
    }));
    const view = render(
      <AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={vi.fn()} />,
    );
    expect(getPreviewUrl).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => finish("blob:late"));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late");
  });

  it("leaves remote preview URLs alone when unmounting", async () => {
    const getPreviewUrl = vi.fn(async () => "https://storage.example/audio.mp3");
    const view = render(
      <AudioPreview content={content} getPreviewUrl={getPreviewUrl} onDownload={vi.fn()} />,
    );
    await screen.findByLabelText(content.path);
    view.unmount();

    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
