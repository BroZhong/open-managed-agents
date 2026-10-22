import { createHash } from "node:crypto";

/**
 * The font fix of the Skill Bundle migration (#266, ADR-0022). The old upload
 * route read every file with `.text()`, so each stored TTF was decoded as UTF-8
 * and re-encoded: every invalid byte became U+FFFD (EF BF BD). The 4-byte sfnt
 * header 00 01 00 00 is valid UTF-8 and survives, so a header check alone does
 * not detect the damage; the table directory and the `head` table do.
 *
 * Every corrupted copy of `LiberationSans-Regular.ttf` (the font of the
 * `precise-subtitles` Skill and its Agent forks) is replaced by the official
 * release file, pinned below. Other corrupted fonts are reported, never guessed.
 */

/**
 * The official liberation-fonts 2.1.5 release
 * (https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5).
 * Obtain the file with:
 *
 *   curl -fsSLO https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
 *   shasum -a 256 liberation-fonts-ttf-2.1.5.tar.gz   # archiveSha256
 *   tar -xzf liberation-fonts-ttf-2.1.5.tar.gz liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf
 */
export const OFFICIAL_LIBERATION_SANS_REGULAR = {
  fileName: "LiberationSans-Regular.ttf",
  sha256: "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8",
  size: 410712,
  archive: "liberation-fonts-ttf-2.1.5.tar.gz",
  archiveUrl: "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz",
  archiveSha256: "7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0",
  archiveMember: "liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf",
} as const;

export type PinnedFont = { readonly fileName: string; readonly sha256: string; readonly size: number };

export interface ReplacementFont {
  fileName: string;
  sha256: string;
  body: Uint8Array;
}

export interface FontReplacement {
  path: string;
  fromSha256: string;
  fromSize: number;
  toSha256: string;
  toSize: number;
  /** Why the stored bytes are not a font. */
  problem: string;
}

export interface CorruptFont {
  path: string;
  sha256: string;
  size: number;
  problem: string;
}

const SFNT_VERSIONS = new Set([0x00010000, 0x74727565 /* 'true' */, 0x4f54544f /* 'OTTO' */]);
const HEAD_MAGIC = 0x5f0f3cf5;
const HEAD_MIN_LENGTH = 54;

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export const isFontPath = (path: string) => /\.(ttf|otf)$/i.test(path);

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Why `bytes` is not a structurally valid single sfnt font (TrueType / OpenType); null if it is. */
export function fontProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12) return "shorter than an sfnt header";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  if (!SFNT_VERSIONS.has(version)) return `unknown sfnt version 0x${version.toString(16).padStart(8, "0")}`;
  const tables = view.getUint16(4);
  if (tables === 0 || 12 + 16 * tables > bytes.byteLength) return "table directory out of bounds";
  let head: { offset: number; length: number } | undefined;
  for (let index = 0; index < tables; index += 1) {
    const record = 12 + 16 * index;
    const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    if (offset + length > bytes.byteLength) return `table ${JSON.stringify(tag)} out of bounds`;
    if (tag === "head") head = { offset, length };
  }
  if (!head) return "no head table";
  if (head.length < HEAD_MIN_LENGTH) return "head table too short";
  if (view.getUint32(head.offset + 12) !== HEAD_MAGIC) return "head table magic number mismatch";
  return null;
}

/** Verify the replacement file given to the tool is exactly the pinned official release file. */
export function loadReplacementFont(body: Uint8Array, pinned: PinnedFont = OFFICIAL_LIBERATION_SANS_REGULAR): ReplacementFont {
  const digest = sha256Hex(body);
  if (digest !== pinned.sha256 || body.byteLength !== pinned.size) {
    throw new Error(`The replacement font is not the official ${pinned.fileName}: sha256 ${digest}, expected ${pinned.sha256}`);
  }
  const problem = fontProblem(body);
  if (problem) throw new Error(`The pinned ${pinned.fileName} is not a valid font: ${problem}`);
  return { fileName: pinned.fileName, sha256: digest, body };
}

/**
 * Replace every corrupted copy of the replacement font (matched by file name)
 * and report every other `.ttf`/`.otf` that is not a valid font. Files are
 * returned in input order; untouched entries are the input objects.
 */
export function repairFonts<T extends { path: string; body: Uint8Array }>(files: readonly T[], font: ReplacementFont):
  { files: T[]; replaced: FontReplacement[]; corrupt: CorruptFont[] } {
  const replaced: FontReplacement[] = [];
  const corrupt: CorruptFont[] = [];
  const repaired = files.map((file) => {
    if (!isFontPath(file.path)) return file;
    const problem = fontProblem(file.body);
    if (!problem) return file;
    if (basename(file.path) !== font.fileName) {
      corrupt.push({ path: file.path, sha256: sha256Hex(file.body), size: file.body.byteLength, problem });
      return file;
    }
    replaced.push({
      path: file.path, fromSha256: sha256Hex(file.body), fromSize: file.body.byteLength,
      toSha256: font.sha256, toSize: font.body.byteLength, problem,
    });
    return { ...file, body: font.body };
  });
  return { files: repaired, replaced, corrupt };
}
