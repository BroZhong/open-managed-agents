import { describe, expect, it } from "vitest";
import {
  OFFICIAL_LIBERATION_SANS_REGULAR,
  fontProblem,
  loadReplacementFont,
  repairFonts,
} from "../src/skill-bundle-migration/fonts.js";
import { pinnedFor, sha256, syntheticFont, text, utf8Mangled } from "./fixtures/skill-bundle-migration.js";

describe("fontProblem", () => {
  it("accepts TrueType, Apple 'true' and CFF 'OTTO' fonts", () => {
    expect(fontProblem(syntheticFont())).toBeNull();
    expect(fontProblem(syntheticFont(0x74727565))).toBeNull();
    expect(fontProblem(syntheticFont(0x4f54544f))).toBeNull();
  });

  it("rejects a UTF-8 mangled font even though its 00 01 00 00 header survived", () => {
    const mangled = utf8Mangled(syntheticFont());
    expect(Buffer.from(mangled.subarray(0, 4)).toString("hex")).toBe("00010000");
    expect(fontProblem(mangled)).toMatch(/head|out of bounds/);
  });

  it("rejects text, truncated files and unknown sfnt versions", () => {
    expect(fontProblem(text("not a font at all"))).toMatch(/sfnt version/);
    expect(fontProblem(new Uint8Array([0, 1, 0, 0]))).toMatch(/shorter/);
    expect(fontProblem(syntheticFont().subarray(0, 60))).toMatch(/out of bounds/);
    expect(fontProblem(syntheticFont(0x74746366))).toMatch(/sfnt version/);
  });
});

describe("loadReplacementFont", () => {
  it("pins the official liberation-fonts 2.1.5 release file", () => {
    expect(OFFICIAL_LIBERATION_SANS_REGULAR).toMatchObject({
      fileName: "LiberationSans-Regular.ttf",
      sha256: "76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8",
      size: 410712,
      archive: "liberation-fonts-ttf-2.1.5.tar.gz",
      archiveSha256: "7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0",
    });
  });

  it("refuses any file but the pinned one", () => {
    expect(() => loadReplacementFont(syntheticFont())).toThrow(/sha256/);
  });

  it("refuses a pinned file that is not a valid font", () => {
    const body = text("pinned but not a font");
    expect(() => loadReplacementFont(body, pinnedFor(body))).toThrow(/not a valid font/);
  });

  it("returns the verified bytes and identity", () => {
    const body = syntheticFont();
    expect(loadReplacementFont(body, pinnedFor(body))).toEqual({ fileName: "LiberationSans-Regular.ttf", sha256: sha256(body), body });
  });
});

describe("repairFonts", () => {
  const official = syntheticFont(0x00010000, 2);
  const font = loadReplacementFont(official, pinnedFor(official));

  it("replaces only corrupted copies of the pinned font and reports each", () => {
    const corrupted = utf8Mangled(syntheticFont(0x00010000, 3));
    const intact = syntheticFont(0x00010000, 4);
    const files = [
      { path: "SKILL.md", body: text("# precise-subtitles") },
      { path: "assets/fonts/LiberationSans-Regular.ttf", body: corrupted },
      { path: "assets/fonts/LICENSE.txt", body: text("license") },
      { path: "other/LiberationSans-Regular.ttf", body: intact },
    ];
    const result = repairFonts(files, font);
    expect(result.files.map((file) => file.path)).toEqual(files.map((file) => file.path));
    expect(result.files[1].body).toBe(official);
    expect(result.files[3].body).toBe(intact);
    expect(result.files[0]).toBe(files[0]);
    expect(result.replaced).toEqual([{
      path: "assets/fonts/LiberationSans-Regular.ttf",
      fromSha256: sha256(corrupted), fromSize: corrupted.byteLength,
      toSha256: sha256(official), toSize: official.byteLength,
      problem: expect.any(String),
    }]);
    expect(result.corrupt).toEqual([]);
  });

  it("reports, but never guesses a replacement for, other corrupted fonts", () => {
    const corrupted = utf8Mangled(syntheticFont());
    const result = repairFonts([{ path: "fonts/NotoSans.TTF", body: corrupted }, { path: "fonts/x.otf", body: syntheticFont(0x4f54544f) }], font);
    expect(result.files[0].body).toBe(corrupted);
    expect(result.replaced).toEqual([]);
    expect(result.corrupt).toEqual([{ path: "fonts/NotoSans.TTF", sha256: sha256(corrupted), size: corrupted.byteLength, problem: expect.any(String) }]);
  });
});
