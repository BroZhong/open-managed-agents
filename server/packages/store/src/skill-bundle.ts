import { createHash } from "node:crypto";
import { buffer as streamToBuffer } from "node:stream/consumers";
import yazl from "yazl";
import yauzl from "yauzl";
import { InvalidSkillBundleError, InvalidSkillFileError, SkillBundleTooLargeError } from "./errors.js";

/**
 * Skill Bundles (ADR-0022): every version of a Skill is one immutable zip,
 * content-addressed within its tenant by the sha256 of the zip bytes.
 *
 * Packing is deterministic — the same files, paths and modes always produce
 * byte-identical zips — so the digest names the content: entries sorted by
 * path, fixed timestamps, fixed deflate level, no OS-dependent metadata. The
 * zip is a standard unix deflate archive ("version made by" = unix, the mode in
 * the external attributes), so Info-ZIP `unzip` restores the executable bit.
 * Python's `zipfile.extractall` does NOT restore modes; an installer using it
 * must apply `external_attr >> 16` itself.
 */

/** The maximum total uncompressed size of one Skill. No file-count or per-file limits. */
export const SKILL_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;

/** The only modes a bundle records: executable iff any x bit was set. */
export type SkillFileMode = 0o644 | 0o755;

export interface SkillBundleInputFile {
  /** Skill-relative POSIX path, e.g. `scripts/run.sh`. */
  path: string;
  body: Uint8Array;
  /** Unix mode; only the x bits matter. Defaults to 0o644. */
  mode?: number;
}

export interface SkillBundleEntry {
  path: string;
  /** Uncompressed bytes. */
  size: number;
  mode: SkillFileMode;
}

export interface SkillBundleFile {
  path: string;
  body: Uint8Array;
  mode: SkillFileMode;
}

export interface PackedSkillBundle {
  /** Lowercase hex sha256 of {@link bytes}: the bundle's identity within a tenant. */
  sha256: string;
  /** Total uncompressed bytes of the packed files. */
  size: number;
  /** The zip. */
  bytes: Uint8Array;
  /** Number of packed files. */
  files: number;
  /** Sorted paths that were dropped (`*.pyc`, anything under `__pycache__`). */
  filtered: string[];
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REGULAR_FILE = 0o100000;
const FILE_TYPE_MASK = 0o170000;
const UNIX = 3;
const DEFLATE_LEVEL = 6;
const NAME_MAX_BYTES = 255;

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function isSkillBundleSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/**
 * Validate a bundle's storage identity. Tenant ids are opaque ASCII segments,
 * the same contract as Workspace object prefixes.
 */
export function assertSkillBundleIdentity(tenantId: string, sha256: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(tenantId) || !isSkillBundleSha256(sha256)) {
    throw new Error("Invalid Skill Bundle identity");
  }
}

/** The install URL expiry bound every `SkillBundleStore` enforces. */
export function assertInstallUrlExpiry(expiresInSec: number): void {
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 900) {
    throw new Error("Skill Bundle install URL expiry must be an integer between 1 and 900 seconds");
  }
}

/** Why `path` is not a literal, extractable, Skill-relative file path; null if it is. */
function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "Skill file path is empty";
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return `Skill file path contains a backslash or control character: ${JSON.stringify(path)}`;
  if (/^[a-zA-Z]:/.test(path)) return `Skill file path is absolute: ${path}`;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return `Skill file path must be relative without empty, "." or ".." segments: ${path}`;
  }
  try { encodeURIComponent(path); } catch { return "Skill file path is not valid Unicode"; }
  if (segments.some((segment) => Buffer.byteLength(segment) > NAME_MAX_BYTES)) {
    return `Skill file name exceeds ${NAME_MAX_BYTES} bytes: ${path}`;
  }
  return null;
}

/**
 * Compiled Python never belongs in a Skill version: packing leaves these paths
 * out. A request that targets one explicitly is rejected instead (#269).
 */
export function isFilteredSkillPath(path: string): boolean {
  return path.endsWith(".pyc") || path.split("/").includes("__pycache__");
}

function normalizeMode(path: string, mode: number | undefined): SkillFileMode {
  if (mode === undefined) return 0o644;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o177777) {
    throw new InvalidSkillFileError(path, `Invalid mode for Skill file ${path}`);
  }
  return mode & 0o111 ? 0o755 : 0o644;
}

/**
 * The fixed entry timestamp, 1980-01-01 00:00, the DOS epoch. yazl derives the
 * DOS date and time from a Date's local getters, and V8 on Linux can construct
 * and read a local Date with different offsets after a process changes its
 * timezone. Local getters that return the UTC fields make the bytes independent
 * of any timezone; the UTC extended-timestamp field is omitted
 * (`forceDosTimestamp`).
 */
function dosEpoch(): Date {
  return Object.assign(new Date(Date.UTC(1980, 0, 1)), {
    getFullYear(this: Date) { return this.getUTCFullYear(); },
    getMonth(this: Date) { return this.getUTCMonth(); },
    getDate(this: Date) { return this.getUTCDate(); },
    getHours(this: Date) { return this.getUTCHours(); },
    getMinutes(this: Date) { return this.getUTCMinutes(); },
    getSeconds(this: Date) { return this.getUTCSeconds(); },
  });
}

/**
 * Pack a Skill's files into a deterministic Skill Bundle.
 * Throws {@link InvalidSkillFileError} for an invalid/duplicate path or mode and
 * {@link SkillBundleTooLargeError} above {@link SKILL_BUNDLE_MAX_BYTES} (after filtering).
 */
export async function packSkillBundle(files: readonly SkillBundleInputFile[]): Promise<PackedSkillBundle> {
  const paths = new Set<string>();
  for (const file of files) {
    const problem = pathProblem(file.path);
    if (problem) throw new InvalidSkillFileError(String(file.path), problem);
    if (paths.has(file.path)) throw new InvalidSkillFileError(file.path, `Duplicate Skill file path: ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    for (let end = path.indexOf("/"); end !== -1; end = path.indexOf("/", end + 1)) {
      const parent = path.slice(0, end);
      if (paths.has(parent)) throw new InvalidSkillFileError(parent, `Skill file path is both a file and a directory: ${parent}`);
    }
  }
  const kept = files
    .filter((file) => !isFilteredSkillPath(file.path))
    .map((file) => ({ path: file.path, body: file.body, mode: normalizeMode(file.path, file.mode) }))
    .sort((a, b) => byCodeUnit(a.path, b.path));
  const filtered = files.filter((file) => isFilteredSkillPath(file.path)).map((file) => file.path).sort(byCodeUnit);
  const size = kept.reduce((total, file) => total + file.body.byteLength, 0);
  if (size > SKILL_BUNDLE_MAX_BYTES) throw new SkillBundleTooLargeError(size, SKILL_BUNDLE_MAX_BYTES);

  const zip = new yazl.ZipFile();
  const mtime = dosEpoch();
  for (const file of kept) {
    zip.addBuffer(asBuffer(file.body), file.path, {
      mtime, mode: REGULAR_FILE | file.mode, compressionLevel: DEFLATE_LEVEL, forceDosTimestamp: true,
    });
  }
  zip.end();
  const bytes = new Uint8Array(await streamToBuffer(zip.outputStream));
  return { sha256: sha256Hex(bytes), size, bytes, files: kept.length, filtered };
}

/** Visit a bundle's validated entries in archive order; `visit` returns true to stop early. */
async function eachEntry(
  bytes: Uint8Array,
  visit: (entry: SkillBundleEntry, read: () => Promise<Uint8Array>) => Promise<boolean | void>,
): Promise<void> {
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(asBuffer(bytes), { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  } catch (error) {
    throw new InvalidSkillBundleError(`Invalid Skill Bundle: ${(error as Error).message}`);
  }
  try {
    const paths = new Set<string>();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const attributes = entry.versionMadeBy >> 8 === UNIX ? entry.externalFileAttributes >>> 16 : 0;
      const type = attributes & FILE_TYPE_MASK;
      if (pathProblem(entry.fileName) || paths.has(entry.fileName) || (type !== 0 && type !== REGULAR_FILE) ||
        !entry.canDecodeFileData()) {
        throw new InvalidSkillBundleError(`Invalid Skill Bundle entry: ${entry.fileName}`);
      }
      paths.add(entry.fileName);
      total += entry.uncompressedSize;
      // Declared sizes are verified against the data as it is inflated.
      if (total > SKILL_BUNDLE_MAX_BYTES) throw new SkillBundleTooLargeError(total, SKILL_BUNDLE_MAX_BYTES);
      const info: SkillBundleEntry = { path: entry.fileName, size: entry.uncompressedSize, mode: attributes & 0o111 ? 0o755 : 0o644 };
      const read = async () => new Uint8Array(await streamToBuffer(await zip.openReadStreamPromise(entry)));
      if (await visit(info, read)) return;
    }
  } catch (error) {
    if (error instanceof InvalidSkillBundleError || error instanceof SkillBundleTooLargeError) throw error;
    throw new InvalidSkillBundleError(`Invalid Skill Bundle: ${(error as Error).message}`);
  } finally {
    zip.close();
  }
}

/** The file tree (path, size, mode) from the central directory, without inflating bodies. */
export async function listSkillBundle(bytes: Uint8Array): Promise<SkillBundleEntry[]> {
  const entries: SkillBundleEntry[] = [];
  await eachEntry(bytes, async (entry) => { entries.push(entry); });
  return entries;
}

/** One file's bytes, or null if the bundle has no such file. */
export async function readSkillBundleFile(bytes: Uint8Array, path: string): Promise<Uint8Array | null> {
  let body: Uint8Array | null = null;
  await eachEntry(bytes, async (entry, read) => {
    if (entry.path !== path) return false;
    body = await read();
    return true;
  });
  return body;
}

/** Every file (path, bytes, mode), in path order. */
export async function unpackSkillBundle(bytes: Uint8Array): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
  await eachEntry(bytes, async (entry, read) => { files.push({ path: entry.path, mode: entry.mode, body: await read() }); });
  return files;
}

/** Validate a stored bundle: its digest names its bytes and it is a well-formed bundle. */
export async function verifySkillBundle(bundle: { sha256: string; bytes: Uint8Array }): Promise<void> {
  if (sha256Hex(bundle.bytes) !== bundle.sha256) throw new InvalidSkillBundleError("Skill Bundle bytes do not match their sha256");
  await listSkillBundle(bundle.bytes);
}

export interface SkillSetMember {
  /** The installed directory name of the equipped Skill. */
  name: string;
  bundleSha256: string;
}

/**
 * The Skill Set hash of an Agent's equipped Skills: a stable lowercase hex
 * sha256 of `"oma-skill-set/v1\n" + JSON.stringify([[name, bundleSha256], ...])`
 * with members sorted by name. Independent of equip order; any equip, unequip,
 * rename or bundle change produces a different value.
 *
 * The empty set is NOT a special case: it hashes the empty list to
 * {@link EMPTY_SKILL_SET_HASH}, a real installed state ("no Skills"), distinct
 * from a Sandbox whose installed set is unknown (no recorded hash).
 */
export function skillSetHash(skills: readonly SkillSetMember[]): string {
  const members = skills.map(({ name, bundleSha256 }) => {
    if (typeof name !== "string" || !name) throw new Error("Skill Set member name is empty");
    if (!isSkillBundleSha256(bundleSha256)) throw new Error(`Invalid bundle sha256 for Skill ${name}`);
    return [name, bundleSha256] as const;
  }).sort(([a], [b]) => byCodeUnit(a, b));
  for (let index = 1; index < members.length; index += 1) {
    if (members[index][0] === members[index - 1][0]) throw new Error(`Duplicate Skill name in Skill Set: ${members[index][0]}`);
  }
  return sha256Hex(`oma-skill-set/v1\n${JSON.stringify(members)}`);
}

/** `skillSetHash([])`: sha256 of `"oma-skill-set/v1\n[]"`. */
export const EMPTY_SKILL_SET_HASH = "39bd81253647ecd67f7f191ab79114b7bee84427fb395ede5f555d59621cad6e";

/**
 * Normalize the pair of `skills` columns naming a Skill's current bundle in a
 * store input: undefined when neither is given, otherwise both set or both null.
 */
export function skillBundleColumns(input: { bundleSha256?: string | null; bundleSize?: number | null }):
  { bundleSha256: string | null; bundleSize: number | null } | undefined {
  const { bundleSha256, bundleSize } = input;
  if (bundleSha256 === undefined && bundleSize === undefined) return undefined;
  if (bundleSha256 === null && bundleSize === null) return { bundleSha256: null, bundleSize: null };
  if (!isSkillBundleSha256(bundleSha256) || typeof bundleSize !== "number" || !Number.isSafeInteger(bundleSize) ||
    bundleSize < 0 || bundleSize > SKILL_BUNDLE_MAX_BYTES) {
    throw new Error("bundleSha256 and bundleSize must be set together to a valid Skill Bundle");
  }
  return { bundleSha256, bundleSize };
}
