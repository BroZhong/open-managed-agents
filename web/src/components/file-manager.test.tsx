// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("FileManager uploads to a directory", () => {
  function uploadSource(): FileSource {
    return {
      capabilities: { hierarchy: "nested", idleGated: true },
      list: vi.fn(async () => [
        { path: "assets/audio/existing.txt", isDir: false },
        { path: "notes/readme.txt", isDir: false },
      ]),
      read: async (path) => ({ path, text: "hello", contentType: "text/plain", size: 5, isBinary: false }),
      upload: vi.fn(async () => undefined),
    };
  }

  function dragFiles() {
    return {
      files: [new File(["new file"], "new.txt", { type: "text/plain" })],
      types: ["Files"],
      dropEffect: "none",
    };
  }

  it("highlights a collapsed nested folder and drops into its full path exactly once", async () => {
    const source = uploadSource();
    const view = render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("assets"));
    const folder = screen.getByRole("button", { name: "audio" });
    const dataTransfer = dragFiles();
    const dragOver = createEvent.dragOver(folder, { dataTransfer });

    fireEvent(folder, dragOver);

    expect(dragOver.defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(folder.className).toContain("ring-2");
    const leave = createEvent.dragLeave(folder);
    Object.defineProperty(leave, "relatedTarget", { value: folder.querySelector("span") });
    fireEvent(folder, leave);
    expect(folder.className).toContain("ring-2");
    fireEvent.drop(folder, { dataTransfer });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(dataTransfer.files, "assets/audio"));
    expect(await screen.findByText("existing.txt")).toBeTruthy();
    expect(screen.getByTitle("Upload to /assets/audio")).toBeTruthy();
    expect(folder.className).not.toContain("ring-2");
    view.unmount();
  });

  it("uses the clicked folder for picker uploads even when another file is previewed", async () => {
    const source = uploadSource();
    const { container } = render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("notes"));
    fireEvent.click(screen.getByText("readme.txt"));
    await screen.findByText("hello");
    fireEvent.click(screen.getByText("assets"));
    expect(screen.getByTitle("Upload to /assets")).toBeTruthy();

    const files = dragFiles().files;
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(files, "assets"));
    await waitFor(() => expect(screen.queryByText("Uploading…")).toBeNull());
    expect(screen.getByTitle("Upload to /assets")).toBeTruthy();
  });

  it("keeps the chosen upload folder when the selected file refreshes", async () => {
    const source = uploadSource();
    const view = render(<FileManager source={source} turnStatus="idle" refreshKey={0} />);
    fireEvent.click(await screen.findByText("notes"));
    fireEvent.click(screen.getByText("readme.txt"));
    await screen.findByText("hello");
    fireEvent.click(screen.getByText("assets"));

    view.rerender(<FileManager source={source} turnStatus="idle" refreshKey={1} />);

    await screen.findByText("hello");
    expect(screen.getByTitle("Upload to /assets")).toBeTruthy();
  });

  it("drops to the root instead of the previously selected directory", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("notes"));
    const dataTransfer = dragFiles();

    fireEvent.drop(screen.getByRole("button", { name: "Root directory /" }), { dataTransfer });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(dataTransfer.files, undefined));
    expect(screen.getByTitle("Upload to /")).toBeTruthy();
  });

  it("uses the root dropzone after clicking the root directory", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("notes"));
    fireEvent.click(screen.getByRole("button", { name: "Root directory /" }));
    const dataTransfer = dragFiles();

    fireEvent.drop(screen.getByText("Drag files here or click to select"), { dataTransfer });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(dataTransfer.files, undefined));
  });

  it("ignores text drags", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    const folder = (await screen.findByText("assets")).closest("button")!;
    const event = createEvent.dragOver(folder, { dataTransfer: { types: ["text/plain"], files: [] } });

    fireEvent(folder, event);

    expect(event.defaultPrevented).toBe(false);
    expect(folder.className).not.toContain("ring-2");
    expect(source.upload).not.toHaveBeenCalled();
  });

  it("blocks file drops while a Turn is running without opening the file in the browser", async () => {
    const source = uploadSource();
    const view = render(<FileManager source={source} turnStatus="idle" />);
    const folder = (await screen.findByText("assets")).closest("button")!;
    const dataTransfer = dragFiles();
    fireEvent.dragOver(folder, { dataTransfer });
    view.rerender(<FileManager source={source} turnStatus="running" />);
    expect(folder.className).not.toContain("ring-2");

    for (const target of [folder, screen.getByRole("button", { name: "Root directory /" }), screen.getByText("Drag files here or click to select")]) {
      const event = createEvent.drop(target, { dataTransfer });
      fireEvent(target, event);
      expect(event.defaultPrevented).toBe(true);
    }

    expect(source.upload).not.toHaveBeenCalled();
  });

  it("blocks duplicate uploads until the in-flight upload finishes", async () => {
    const source = uploadSource();
    let finish!: () => void;
    source.upload = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = render(<FileManager source={source} turnStatus="idle" />);
    const folder = (await screen.findByText("assets")).closest("button")!;
    const dataTransfer = dragFiles();

    fireEvent.drop(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    fireEvent.drop(screen.getByText("Uploading…"), { dataTransfer });

    expect(source.upload).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    fireEvent.click(screen.getByText("notes"));
    await act(async () => finish());
    await waitFor(() => expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(false));
    expect(screen.getByTitle("Upload to /notes")).toBeTruthy();
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

  it("opens audio with native playback controls even when storage reports a generic MIME", async () => {
    const source = sourceFor(
      "recording.mp3",
      { path: "recording.mp3", text: null, contentType: "application/octet-stream", size: 10, isBinary: true },
      async () => "blob:audio-preview",
    );
    const view = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("recording.mp3");

    const player = await screen.findByLabelText("recording.mp3");
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("blob:audio-preview");
    expect(player.hasAttribute("controls")).toBe(true);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audio-preview");
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
