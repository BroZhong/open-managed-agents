// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileManager } from "./file-manager";
import type { FileSource } from "@/lib/file-source";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});

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
      async () => "https://files.test/large-text",
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

  function folderTransfer(file: File, readFile = (success: FileCallback) => success(file)) {
    const placeholder = new File([], "recordings");
    const leaf = { name: file.name, isFile: true, isDirectory: false, file: readFile };
    const directory = (name: string, child: unknown) => ({
      name, isFile: false, isDirectory: true,
      createReader: () => {
        let read = false;
        return { readEntries: (success: (entries: unknown[]) => void) => {
          success(read ? [] : [child]);
          read = true;
        } };
      },
    });
    return {
      files: [placeholder],
      items: [{ kind: "file", getAsFile: () => placeholder, webkitGetAsEntry: () => directory("recordings", directory("tracks", leaf)) }],
      types: ["Files"],
      dropEffect: "none",
    };
  }

  it("uploads a dropped folder's real files with their relative paths into the target directory", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("assets"));
    const file = new File(["RIFF test audio"], "voice.wav", { type: "audio/wav" });

    fireEvent.drop(screen.getByRole("button", { name: "audio" }), { dataTransfer: folderTransfer(file) });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ name: "recordings/tracks/voice.wav", type: "audio/wav", size: file.size })],
      "assets/audio",
    ));
  });

  it("locks uploads during a directory scan and keeps the drop destination when selection changes", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    await screen.findByText("assets");
    const file = new File(["audio"], "voice.wav");
    let complete!: FileCallback;
    const transfer = folderTransfer(file, (success) => { complete = success; });

    fireEvent.drop(screen.getByRole("button", { name: "Root directory /" }), { dataTransfer: transfer });
    await waitFor(() => expect(complete).toBeDefined());
    expect(source.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose folder" }).hasAttribute("disabled")).toBe(true);
    fireEvent.drop(screen.getByText("Uploading…"), { dataTransfer: dragFiles() });
    fireEvent.click(screen.getByText("notes"));
    await act(async () => complete(file));

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ name: "recordings/tracks/voice.wav" })], undefined,
    ));
    expect(screen.getByTitle("Upload to /notes")).toBeTruthy();
  });

  it("does not upload a scanned folder if a Turn starts while reading it", async () => {
    const source = uploadSource();
    const view = render(<FileManager source={source} turnStatus="idle" />);
    await screen.findByText("assets");
    const file = new File(["audio"], "voice.wav");
    let complete!: FileCallback;
    fireEvent.drop(screen.getByRole("button", { name: "Root directory /" }), {
      dataTransfer: folderTransfer(file, (success) => { complete = success; }),
    });
    await waitFor(() => expect(complete).toBeDefined());
    view.rerender(<FileManager source={source} turnStatus="running" />);
    await act(async () => complete(file));

    expect(await screen.findByText("Agent 运行中，稍后重试")).toBeTruthy();
    expect(source.upload).not.toHaveBeenCalled();
  });

  it("explains empty folders without sending a directory placeholder", async () => {
    const source = uploadSource();
    render(<FileManager source={source} turnStatus="idle" />);
    await screen.findByText("assets");
    fireEvent.drop(screen.getByRole("button", { name: "Root directory /" }), {
      dataTransfer: {
        types: ["Files"], files: [new File([], "empty")],
        items: [{ kind: "file", getAsFile: () => new File([], "empty"), webkitGetAsEntry: () => ({
          name: "empty", isFile: false, isDirectory: true,
          createReader: () => ({ readEntries: (success: FileSystemEntriesCallback) => success([]) }),
        }) }],
      },
    });

    expect(await screen.findByText(/Empty folders cannot be uploaded/)).toBeTruthy();
    expect(source.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose folder" }).hasAttribute("disabled")).toBe(false);
  });

  it("preserves the selected folder's hierarchy when using the folder picker", async () => {
    const source = uploadSource();
    const { container } = render(<FileManager source={source} turnStatus="idle" />);
    fireEvent.click(await screen.findByText("assets"));
    const file = new File(["audio"], "voice.wav", { type: "audio/wav" });
    Object.defineProperty(file, "webkitRelativePath", { value: "recordings/tracks/voice.wav" });
    fireEvent.change(container.querySelector('input[webkitdirectory]')!, { target: { files: [file] } });

    await waitFor(() => expect(source.upload).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ name: "recordings/tracks/voice.wav", size: file.size, type: file.type })],
      "assets",
    ));
  });

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

    await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(1));
    expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    fireEvent.click(screen.getByText("notes"));
    await act(async () => finish());
    await waitFor(() => expect(container.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(false));
    expect(screen.getByTitle("Upload to /notes")).toBeTruthy();
  });
});

describe("FileManager media refresh", () => {
  it("opens audio with native playback controls even when storage reports a generic MIME", async () => {
    const source = sourceFor(
      "recording.mp3",
      { path: "recording.mp3", text: null, contentType: "application/octet-stream", size: 10, isBinary: true },
      async () => "https://files.test/audio-preview",
    );
    const view = render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("recording.mp3");

    const player = await screen.findByLabelText("recording.mp3");
    expect(player.tagName).toBe("AUDIO");
    expect(player.getAttribute("src")).toBe("https://files.test/audio-preview");
    expect(player.hasAttribute("controls")).toBe(true);
    view.unmount();
  });



  it("replaces the preview when refresh reloads the same path", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://files.test/cover-v1")
      .mockResolvedValueOnce("https://files.test/cover-v2");
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
      .toBe("https://files.test/cover-v1");

    view.rerender(<FileManager source={source} turnStatus="idle" refreshKey={1} />);

    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "cover.png" }).getAttribute("src"))
      .toBe("https://files.test/cover-v2");
  });

  it("reloads the selected preview when the toolbar Refresh button is used", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://files.test/toolbar-v1")
      .mockResolvedValueOnce("https://files.test/toolbar-v2");
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
      .toBe("https://files.test/toolbar-v1");

    fireEvent.click(screen.getByTitle("Refresh"));

    await waitFor(() => expect(previewUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("img", { name: "cover.png" }).getAttribute("src"))
      .toBe("https://files.test/toolbar-v2");
  });

  it("reloads the selected preview after uploading over the same path", async () => {
    const previewUrl = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("https://files.test/upload-v1")
      .mockResolvedValueOnce("https://files.test/upload-v2");
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
      .toBe("https://files.test/upload-v1");

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
      .toBe("https://files.test/upload-v2");
  });




});

describe("FileManager storage links", () => {
  it("downloads through a fresh attachment URL rather than the mounted preview", async () => {
    let anchor: Pick<HTMLAnchorElement, "href" | "target" | "rel"> | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { anchor = { href: this.href, target: this.target, rel: this.rel }; });
    const source = sourceFor("poster.jpg", { path: "poster.jpg", text: null, contentType: "image/jpeg", size: 1024, isBinary: true }, vi.fn(async () => "https://files.test/preview"));
    source.downloadUrl = vi.fn(async () => "https://files.test/attachment");
    render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("poster.jpg");
    await screen.findByRole("img");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(source.downloadUrl).toHaveBeenCalledWith("poster.jpg"));
    expect(anchor?.href).toBe("https://files.test/attachment");
    expect(anchor?.target).toBe("_blank");
    expect(anchor?.rel).toBe("noopener noreferrer");
    expect(source.previewUrl).toHaveBeenCalledTimes(1);
  });

  it("shows a download-link failure", async () => {
    const source = sourceFor("archive.zip", { path: "archive.zip", text: null, contentType: "application/zip", size: 1024, isBinary: true }, async () => "https://files.test/preview");
    source.downloadUrl = vi.fn(async () => { throw new Error("Storage unavailable"); });
    render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("archive.zip");
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Storage unavailable");
  });

  it("preloads video metadata and preserves its position after one fresh URL", async () => {
    const previewUrl = vi.fn().mockResolvedValueOnce("https://files.test/old").mockResolvedValueOnce("https://files.test/fresh");
    const source = sourceFor("movie.mp4", { path: "movie.mp4", text: null, contentType: "video/mp4", size: 50 * 1024 * 1024, isBinary: true }, previewUrl);
    const view = render(<FileManager source={source} turnStatus="idle" />);
    const { container } = view;
    await openListedFile("movie.mp4");
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const old = container.querySelector("video")!;
    expect(old.preload).toBe("metadata");
    expect(old.crossOrigin).toBe("anonymous");
    old.currentTime = 23;
    fireEvent.error(old);
    await waitFor(() => expect(container.querySelector("video")?.src).toBe("https://files.test/fresh"));
    const fresh = container.querySelector("video")!;
    fireEvent.loadedMetadata(fresh);
    expect(fresh.currentTime).toBe(23);
    expect(old.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(previewUrl.mock.calls[1][1]).toMatchObject({ forceRefresh: true });
    fireEvent.error(fresh);
    expect(await screen.findByText("Failed to load video.")).toBeTruthy();
    expect(previewUrl).toHaveBeenCalledTimes(2);
    expect(fresh.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(2);
  });

  it("cancels the previous read when a different file is selected", async () => {
    const read = vi.fn<FileSource["read"]>((path, options) => path === "slow.txt"
      ? new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason)))
      : Promise.resolve({ path, text: "fast", contentType: "text/plain", size: 4, isBinary: false }));
    const source: FileSource = {
      capabilities: { hierarchy: "nested", idleGated: false },
      list: async () => [{ path: "slow.txt", isDir: false }, { path: "fast.txt", isDir: false }],
      read,
    };
    render(<FileManager source={source} turnStatus="idle" />);
    await openListedFile("slow.txt");
    await openListedFile("fast.txt");
    expect(await screen.findByText("fast")).toBeTruthy();
    expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(read.mock.calls[1][1]?.signal?.aborted).toBe(false);
  });
});
