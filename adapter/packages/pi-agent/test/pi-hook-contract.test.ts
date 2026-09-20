import { expect, it } from "vitest";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

it("uses the published SDK without private session patch methods", () => {
  expect(VERSION).toBe("0.83.0");
  const manager = SessionManager.inMemory();
  expect("restoreEntry" in manager).toBe(false);
  expect("onEntryAppended" in manager).toBe(false);
});

it("does not configure Pi patches in either workspace", () => {
  for (const path of ["../../../pnpm-workspace.yaml", "../../../../server/pnpm-workspace.yaml"]) {
    const yaml = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(yaml).not.toContain("pi-coding-agent@");
  }
});
