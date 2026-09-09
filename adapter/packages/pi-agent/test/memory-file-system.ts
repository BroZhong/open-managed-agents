import { posix } from "node:path";
import type { ToolFileSystem, ToolFileSystemOptions, ToolFileStat } from "@open-managed-agents/adapter-core";

/** File/empty-directory fixture. No method touches the process filesystem. */
export class MemoryFileSystem implements ToolFileSystem {
  readonly directories = new Set([".", "/", "/home", "/skills"]);
  private temporary = 0;

  constructor(readonly files = new Map<string, string>(), readonly calls: string[] = []) {}

  private key(path: string): string {
    const normalized = posix.normalize(path);
    return normalized === "/home/user" ? "."
      : normalized.startsWith("/home/user/") ? normalized.slice(11) : normalized;
  }

  private check(options?: ToolFileSystemOptions): void { options?.signal?.throwIfAborted(); }
  private missing(path: string): never { throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" }); }
  private hasDirectory(path: string): boolean {
    const prefix = path === "." ? "" : `${path}/`;
    return this.directories.has(path) || [...this.files.keys(), ...this.directories].some((candidate) => candidate !== path && candidate.startsWith(prefix));
  }

  async readFile(path: string, options?: ToolFileSystemOptions): Promise<Uint8Array> {
    this.check(options); path = this.key(path); this.calls.push(`read ${path}`);
    const value = this.files.get(path);
    if (value === undefined) this.missing(path);
    return Buffer.from(value);
  }
  async writeFile(path: string, content: Uint8Array, options?: ToolFileSystemOptions): Promise<void> {
    this.check(options); path = this.key(path); this.calls.push(`write ${path}`);
    if (!this.hasDirectory(posix.dirname(path))) this.missing(posix.dirname(path));
    this.files.set(path, Buffer.from(content).toString());
  }
  async access(path: string, _mode?: number, options?: ToolFileSystemOptions): Promise<void> {
    this.check(options); path = this.key(path); this.calls.push(`access ${path}`);
    if (!this.files.has(path) && !this.hasDirectory(path)) this.missing(path);
  }
  async stat(path: string, options?: ToolFileSystemOptions): Promise<ToolFileStat> {
    this.check(options); path = this.key(path); this.calls.push(`stat ${path}`);
    const isFile = this.files.has(path);
    const isDirectory = !isFile && this.hasDirectory(path);
    if (!isFile && !isDirectory) this.missing(path);
    return { isFile, isDirectory, isSymbolicLink: false, size: Buffer.byteLength(this.files.get(path) ?? ""), mtimeMs: 0 };
  }
  async lstat(path: string, options?: ToolFileSystemOptions): Promise<ToolFileStat> { return this.stat(path, options); }
  async realpath(path: string, options?: ToolFileSystemOptions): Promise<string> {
    this.check(options); path = this.key(path); this.calls.push(`realpath ${path}`);
    if (!this.files.has(path) && !this.hasDirectory(path)) this.missing(path);
    return posix.resolve("/home/user", path);
  }
  async readdir(path: string, options?: ToolFileSystemOptions): Promise<string[]> {
    this.check(options); path = this.key(path); this.calls.push(`readdir ${path}`);
    if (!this.hasDirectory(path)) this.missing(path);
    const prefix = path === "." ? "" : `${path}/`;
    return [...new Set([...this.files.keys(), ...this.directories]
      .filter((candidate) => candidate !== path && candidate.startsWith(prefix))
      .map((candidate) => candidate.slice(prefix.length).split("/")[0]).filter(Boolean))];
  }
  async mkdir(path: string, options?: ToolFileSystemOptions): Promise<void> {
    this.check(options); path = this.key(path); this.calls.push(`mkdir ${path}`);
    this.directories.add(path);
    while (posix.dirname(path) !== path) { path = posix.dirname(path); this.directories.add(path); }
  }
  async createTempFile(options?: ToolFileSystemOptions): Promise<string> {
    this.check(options);
    const path = `/home/user/.tmp/output-${++this.temporary}.log`;
    await this.mkdir(".tmp", options);
    await this.writeFile(path, new Uint8Array(), options);
    this.calls.push(`createTempFile ${path}`);
    return path;
  }
  async appendFile(path: string, content: Uint8Array, options?: ToolFileSystemOptions): Promise<void> {
    this.check(options); path = this.key(path); this.calls.push(`appendFile ${path}`);
    this.files.set(path, (this.files.get(path) ?? "") + Buffer.from(content).toString());
  }
}
