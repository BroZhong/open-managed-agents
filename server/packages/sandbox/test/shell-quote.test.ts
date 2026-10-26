import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "../src/index.js";

describe("shellQuote", () => {
  it("makes any value one word that sh does not expand", () => {
    for (const value of ["plain", "", "it's", "$HOME `id` $(id) \\n * ?", "line\nbreak", "'''"]) {
      expect(execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" })).toBe(value);
    }
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});
