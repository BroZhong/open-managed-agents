import { describe, expect, it, vi } from "vitest";
import { collectUploadFiles } from "./upload-files";

function fileEntry(file: File, failure?: Error): FileSystemFileEntry {
  return {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: (success: FileCallback, error: ErrorCallback) => queueMicrotask(() => {
      if (failure) error(failure as DOMException);
      else success(file);
    }),
  } as FileSystemFileEntry;
}

function directoryEntry(
  name: string,
  batches: FileSystemEntry[][],
  failure?: Error,
): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let batch = 0;
      return {
        readEntries: (success: FileSystemEntriesCallback, error: ErrorCallback) => queueMicrotask(() => {
          if (failure) error(failure as DOMException);
          else success(batches[batch++] ?? []);
        }),
      };
    },
  } as FileSystemDirectoryEntry;
}

function item(file: File, entry?: FileSystemEntry): DataTransferItem {
  return {
    kind: "file",
    getAsFile: () => file,
    ...(entry ? { webkitGetAsEntry: () => entry } : {}),
  } as DataTransferItem;
}

function transfer(items: DataTransferItem[], files: File[]): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

describe("collectUploadFiles", () => {
  it("preserves ordinary input File objects", async () => {
    const file = new File(["hello"], "notes.txt");
    expect((await collectUploadFiles([file]))[0]).toBe(file);
  });

  it("keeps directory-picker paths, bytes, MIME and modification time", async () => {
    const file = new File([Uint8Array.from([0x00, 0xff, 0x80])], "voice.wav", {
      type: "audio/wav", lastModified: 12345,
    });
    Object.defineProperty(file, "webkitRelativePath", { value: "Album/raw/voice.wav" });
    const [result] = await collectUploadFiles([file]);
    expect(result.name).toBe("Album/raw/voice.wav");
    expect(result.type).toBe("audio/wav");
    expect(result.lastModified).toBe(12345);
    expect(await result.arrayBuffer()).toEqual(await file.arrayBuffer());
  });

  it("collects mixed files and nested folders without flattening duplicate names or hiding files", async () => {
    const first = new File(["first"], "voice.wav", { type: "audio/wav", lastModified: 123 });
    const second = new File(["second"], "voice.wav", { type: "audio/wav", lastModified: 456 });
    const root = directoryEntry("Album", [[
      fileEntry(first),
      directoryEntry("draft", [[fileEntry(second), fileEntry(new File(["hidden"], ".notes"))]]),
    ]]);
    const placeholder = new File([], "Album");
    const loose = new File(["read me"], "README.txt");
    const result = await collectUploadFiles(transfer(
      [item(placeholder, root), item(loose)], [placeholder, loose],
    ));

    expect(result.map((file) => file.name)).toEqual([
      "Album/voice.wav", "Album/draft/voice.wav", "Album/draft/.notes", "README.txt",
    ]);
    expect(await Promise.all(result.map((file) => file.text()))).toEqual(["first", "second", "hidden", "read me"]);
    expect(result[1].type).toBe("audio/wav");
    expect(result[1].lastModified).toBe(456);
    expect(result).not.toContain(placeholder);
  });

  it("reads directory batches past the first 100 entries until the empty batch", async () => {
    const entries = Array.from({ length: 103 }, (_, index) => fileEntry(new File([String(index)], `${index}.txt`)));
    const root = directoryEntry("many", [entries.slice(0, 100), entries.slice(100, 102), entries.slice(102), []]);
    const placeholder = new File([], "many");
    const result = await collectUploadFiles(transfer([item(placeholder, root)], [placeholder]));
    expect(result).toHaveLength(103);
    expect(result[102].name).toBe("many/102.txt");
    expect(await result[102].text()).toBe("102");
  });

  it("captures both entry APIs and the live item/file lists before returning to the drop handler", async () => {
    let active = true;
    const first = new File(["first"], "first.txt");
    const second = new File(["second"], "second.txt");
    const getEntry = (file: File) => vi.fn(() => {
      if (!active) throw new Error("drag data expired");
      return fileEntry(file);
    });
    const webkitGetAsEntry = getEntry(first);
    const getAsEntry = getEntry(second);
    const items = [
      { kind: "file", getAsFile: () => first, webkitGetAsEntry },
      { kind: "file", getAsFile: () => second, getAsEntry },
    ] as unknown as DataTransferItem[];
    const files = [first, second];
    const promise = collectUploadFiles(transfer(items, files));
    active = false;
    items.length = 0;
    files.length = 0;

    expect(webkitGetAsEntry).toHaveBeenCalledTimes(1);
    expect(getAsEntry).toHaveBeenCalledTimes(1);
    expect((await promise).map((file) => file.name)).toEqual(["first.txt", "second.txt"]);
  });

  it.each([true, false])("falls back to files without entry APIs (items available: %s)", async (hasItems) => {
    const file = new File(["notes"], "notes.txt");
    const result = await collectUploadFiles(transfer(hasItems ? [item(file)] : [], [file]));
    expect(result).toEqual([file]);
    expect(result[0]).toBe(file);
  });

  it("returns no files for empty directories instead of uploading placeholders", async () => {
    const placeholder = new File([], "empty");
    const root = directoryEntry("empty", [[directoryEntry("also-empty", [[]])], []]);
    expect(await collectUploadFiles(transfer([item(placeholder, root)], [placeholder]))).toEqual([]);
  });

  it.each(["file", "directory"])("reports the failing %s path without uploading its placeholder", async (kind) => {
    const failure = new Error("permission denied");
    const child = kind === "file"
      ? fileEntry(new File([], "locked.wav"), failure)
      : directoryEntry("locked", [], failure);
    const root = directoryEntry("Album", [[child]]);
    const placeholder = new File([], "Album");
    await expect(collectUploadFiles(transfer([item(placeholder, root)], [placeholder])))
      .rejects.toThrow(`Album/${child.name}`);
  });

  it("reports an unavailable entry instead of treating the directory placeholder as a file", async () => {
    const placeholder = new File([], "unavailable");
    const missing = { kind: "file", getAsFile: () => placeholder, webkitGetAsEntry: () => null } as DataTransferItem;
    await expect(collectUploadFiles(transfer([missing], [placeholder]))).rejects.toThrow("unavailable");
  });
});
