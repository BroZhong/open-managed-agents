import {
  lstat,
  stat as fsStat,
  readdir,
  readFile,
  mkdir,
  open,
  link,
  rename,
  unlink,
} from "node:fs/promises";
import { resolve, parse, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { conflict, invalid } from "./errors.js";
import { remotePath } from "./input.js";
export async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function checkChain(
  path: string,
  leaf: "file" | "directory",
  overwrite = true,
): Promise<string> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split("/").filter(Boolean);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const s = await stat(current);
    if (!s) continue;
    if (s.isSymbolicLink()) {
      // macOS exposes /var (and therefore the default os.tmpdir()) as a
      // root-level compatibility alias for /private/var. Treat root aliases
      // like the filesystem root itself, while still rejecting symlinks
      // inside a user-provided tree where they could escape the destination.
      if (i !== 0 || root !== "/")
        invalid("Symbolic links are not allowed: " + current);
      if (!(await fsStat(current)).isDirectory())
        invalid("Expected directory: " + current);
      continue;
    }
    const last = i === parts.length - 1;
    if (!last || leaf === "directory") {
      if (!s.isDirectory()) invalid("Expected directory: " + current);
    } else {
      if (!s.isFile()) invalid("Expected regular file: " + current);
      if (!overwrite) conflict("Local destination already exists: " + current);
    }
  }
  return absolute;
}
export async function tree(
  directory: string,
): Promise<{ path: string; local: string; bytes: Uint8Array }[]> {
  const absolute = await checkChain(directory, "directory");
  if (!(await stat(absolute)))
    throw Object.assign(new Error("Local directory not found"), {
      code: "ENOENT",
    });
  const files: { path: string; local: string; bytes: Uint8Array }[] = [];
  async function walk(dir: string, prefix: string) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const path = prefix + item.name;
      remotePath(path);
      const local = join(dir, item.name);
      if (item.isSymbolicLink())
        invalid("Symbolic links are not allowed: " + local);
      if (item.isDirectory()) await walk(local, path + "/");
      else if (item.isFile())
        files.push({ path, local, bytes: await readFile(local) });
      else
        invalid(
          "Only regular files and directories can be transferred: " + local,
        );
    }
  }
  await walk(absolute, "");
  return files;
}
export async function destinations(
  output: string,
  paths: string[],
  skill = false,
): Promise<string[]> {
  await checkChain(output, "directory");
  const unique = new Set<string>();
  const targets: string[] = [];
  for (const p of paths) {
    remotePath(p, skill);
    if (unique.has(p)) invalid("Duplicate remote file path");
    unique.add(p);
    targets.push(resolve(output, p));
  }
  for (const p of paths)
    for (const other of paths)
      if (other.startsWith(p + "/"))
        invalid("File/directory collision in remote tree");
  return targets;
}
export async function save(
  output: string,
  source: AsyncIterable<Uint8Array> | Uint8Array,
  overwrite: boolean,
  signal: AbortSignal,
  expectedSize?: number,
): Promise<number> {
  await checkChain(output, "file", overwrite);
  await mkdir(dirname(output), { recursive: true });
  await checkChain(dirname(output), "directory");
  const temp = join(dirname(output), ".oma-download-" + randomUUID());
  const handle = await open(temp, "wx", 0o600);
  let size = 0;
  try {
    const chunks = source instanceof Uint8Array ? [source] : source;
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      await handle.writeFile(chunk);
      size += chunk.byteLength;
    }
    signal.throwIfAborted();
    if (expectedSize !== undefined && size !== expectedSize)
      throw new Error("Downloaded size does not match descriptor");
    await handle.sync();
    await handle.close();
    await checkChain(output, "file", overwrite);
    if (overwrite) await rename(temp, output);
    else {
      try {
        await link(temp, output);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          conflict("Destination appeared during download");
        throw e;
      }
      await unlink(temp);
    }
    return size;
  } finally {
    await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
}
export function mime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    (
      {
        txt: "text/plain",
        md: "text/markdown",
        json: "application/json",
        csv: "text/csv",
        html: "text/html",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        svg: "image/svg+xml",
        pdf: "application/pdf",
        mp4: "video/mp4",
        mp3: "audio/mpeg",
        zip: "application/zip",
      } as Record<string, string>
    )[ext] ?? "application/octet-stream"
  );
}
