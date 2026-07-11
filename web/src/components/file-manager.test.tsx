// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileManager } from "./file-manager";
import type { FileSource } from "@/lib/file-source";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sourceFor(
  path: string,
  content: Awaited<ReturnType<FileSource["read"]>>,
  previewUrl: FileSource["previewUrl"],
): FileSource {
  return {
    capabilities: { hierarchy: "nested", idleGated: false },
    list: async () => [{ path, isDir: false, size: content.size }],
    read: async () => content,
    write: async () => undefined,
    previewUrl,
  };
}

async function openListedFile(path: string): Promise<void> {
  await screen.findByText(path);
  fireEvent.click(screen.getByText(path));
}

describe("FileManager capability UI", () => {
  it("does not offer arbitrary file creation for flat Agent Files", async () => {
    const source: FileSource = {
      capabilities: { hierarchy: "flat", idleGated: false },
      list: async () => [{ path: "IDENTITY", isDir: false }],
      read: async () => ({
        path: "IDENTITY",
        text: "agent",
        contentType: "text/markdown",
        size: 5,
        isBinary: false,
      }),
      write: async () => undefined,
      delete: async () => undefined,
    };

    render(<FileManager source={source} turnStatus="idle" />);
    await screen.findByText("IDENTITY");

    expect(screen.queryByTitle("New file")).toBeNull();
  });

  it("shows oversized text as a download instead of a video", async () => {
    const source = sourceFor(
      "large.md",
      {
        path: "large.md",
        text: null,
        contentType: "text/markdown",
        size: 600 * 1024,
        isBinary: true,
      },
      async () => "blob:large-text",
    );
    const { container } = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("large.md");

    expect(await screen.findByRole("button", { name: /download/i })).toBeTruthy();
    expect(container.querySelector("video")).toBeNull();
  });
});

describe("FileManager Blob URL lifecycle", () => {
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    revokeObjectURL.mockReset();
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
  });

  it("revokes a loaded preview Blob URL when the pane unmounts", async () => {
    const source = sourceFor(
      "cover.png",
      {
        path: "cover.png",
        text: null,
        contentType: "image/png",
        size: 10,
        isBinary: true,
      },
      async () => "blob:cover-preview",
    );
    const view = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("cover.png");
    await screen.findByRole("img", { name: "cover.png" });
    expect(screen.getByRole("button", { name: /download/i })).toBeTruthy();

    view.unmount();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cover-preview");
  });

  it("replaces and revokes the preview when refresh reloads the same path", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("blob:cover-v1")
      .mockResolvedValueOnce("blob:cover-v2");
    const source = sourceFor(
      "cover.png",
      {
        path: "cover.png",
        text: null,
        contentType: "image/png",
        size: 10,
        isBinary: true,
      },
      previewUrl,
    );
    const view = render(<FileManager source={source} turnStatus="idle" refreshKey={0} />);
    await openListedFile("cover.png");
    expect((await screen.findByRole("img", { name: "cover.png" })).getAttribute("src"))
      .toBe("blob:cover-v1");

    view.rerender(<FileManager source={source} turnStatus="idle" refreshKey={1} />);

    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "cover.png" }).getAttribute("src"))
      .toBe("blob:cover-v2");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cover-v1");
  });

  it("reloads the selected preview when the toolbar Refresh button is used", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("blob:toolbar-v1")
      .mockResolvedValueOnce("blob:toolbar-v2");
    const source = sourceFor(
      "cover.png",
      {
        path: "cover.png",
        text: null,
        contentType: "image/png",
        size: 10,
        isBinary: true,
      },
      previewUrl,
    );
    render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("cover.png");
    expect((await screen.findByRole("img", { name: "cover.png" })).getAttribute("src"))
      .toBe("blob:toolbar-v1");

    fireEvent.click(screen.getByTitle("Refresh"));

    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "cover.png" }).getAttribute("src"))
      .toBe("blob:toolbar-v2");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:toolbar-v1");
  });

  it("reloads the selected preview after uploading over the same path", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("blob:upload-v1")
      .mockResolvedValueOnce("blob:upload-v2");
    const source = sourceFor(
      "cover.png",
      {
        path: "cover.png",
        text: null,
        contentType: "image/png",
        size: 10,
        isBinary: true,
      },
      previewUrl,
    );
    source.upload = vi.fn(async () => undefined);
    const { container } = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("cover.png");
    expect((await screen.findByRole("img", { name: "cover.png" })).getAttribute("src"))
      .toBe("blob:upload-v1");

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, {
      target: {
        files: [new File([Uint8Array.from([1, 2, 3])], "cover.png", { type: "image/png" })],
      },
    });

    await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "cover.png" }).getAttribute("src"))
      .toBe("blob:upload-v2");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:upload-v1");
  });

  it("revokes a Blob URL that resolves after the pane has unmounted", async () => {
    let resolvePreview!: (url: string) => void;
    const preview = new Promise<string>((resolve) => {
      resolvePreview = resolve;
    });
    const previewUrl = vi.fn(() => preview);
    const source = sourceFor(
      "late.png",
      {
        path: "late.png",
        text: null,
        contentType: "image/png",
        size: 10,
        isBinary: true,
      },
      previewUrl,
    );
    const view = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("late.png");
    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => resolvePreview("blob:late-preview"));

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:late-preview");
  });

  it("revokes a fresh one-shot download Blob URL", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const previewUrl = vi.fn(async () => "blob:archive-download");
    const source = sourceFor(
      "archive.zip",
      {
        path: "archive.zip",
        text: null,
        contentType: "application/zip",
        size: 10,
        isBinary: true,
      },
      previewUrl,
    );
    render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("archive.zip");

    fireEvent.click(await screen.findByRole("button", { name: /download/i }));

    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:archive-download"));
  });
});
