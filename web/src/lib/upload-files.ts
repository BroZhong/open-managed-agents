export type UploadInput = File[] | DataTransfer;

type EntryItem = DataTransferItem & {
  getAsEntry?: () => FileSystemEntry | null;
};

type DropSnapshot = { entry: FileSystemEntry } | { file: File } | { error: Error };

function readError(path: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(`Failed to read "${path}": ${detail}`, { cause });
}

function fileAtPath(file: File, path: string): File {
  return new File([file], path, { type: file.type, lastModified: file.lastModified });
}

function pickerFile(file: File): File {
  return file.webkitRelativePath ? fileAtPath(file, file.webkitRelativePath) : file;
}

async function collectEntry(entry: FileSystemEntry, parent = ""): Promise<File[]> {
  const path = parent ? `${parent}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      try {
        (entry as FileSystemFileEntry).file(resolve, (error) => reject(readError(path, error)));
      } catch (error) {
        reject(readError(path, error));
      }
    });
    return [fileAtPath(file, path)];
  }

  if (entry.isDirectory) {
    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch (error) {
      throw readError(path, error);
    }
    const files: File[] = [];
    // Chromium returns directory entries in batches of at most 100.
    // Keep using the same reader until it signals the end with an empty batch.
    while (true) {
      const children = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        try {
          reader.readEntries(resolve, (error) => reject(readError(path, error)));
        } catch (error) {
          reject(readError(path, error));
        }
      });
      if (children.length === 0) return files;
      for (const child of children) files.push(...await collectEntry(child, path));
    }
  }

  throw readError(path, "Unsupported file entry");
}

/** Capture drag entries synchronously, before the browser protects the drag data. */
export async function collectUploadFiles(input: UploadInput): Promise<File[]> {
  if (Array.isArray(input)) return input.map(pickerFile);

  const items = Array.from(input.items ?? []).filter((item) => item.kind === "file");
  const files = Array.from(input.files ?? []);
  if (items.length === 0) return files.map(pickerFile);

  // Snapshot every entry before the first await; a later read of DataTransfer
  // can return an empty list or lose access to the next directory's entry.
  const snapshot = items.map((item: EntryItem, index): DropSnapshot => {
    let file = files[index] ?? null;
    try {
      file = item.getAsFile() ?? file;
      const getEntry = item.webkitGetAsEntry ?? item.getAsEntry;
      if (getEntry) {
        const entry = getEntry.call(item);
        if (entry) return { entry };
        throw new Error("File entry is unavailable");
      }
      if (file) return { file };
      throw new Error("File is unavailable");
    } catch (error) {
      return { error: readError(file?.webkitRelativePath || file?.name || `dropped item ${index + 1}`, error) };
    }
  });

  const result: File[] = [];
  for (const value of snapshot) {
    if ("error" in value) throw value.error;
    if ("entry" in value) result.push(...await collectEntry(value.entry));
    else result.push(pickerFile(value.file));
  }
  return result;
}
