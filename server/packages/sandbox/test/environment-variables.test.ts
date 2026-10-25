import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_VARIABLE_NAME,
  PLATFORM_DEFAULT_ENV,
  RESERVED_ENVIRONMENT_VARIABLE_NAMES,
  RESERVED_ENVIRONMENT_VARIABLE_PREFIXES,
  isReservedEnvironmentVariable,
} from "../src/environment-variables.js";
import { WORKSPACE_ENV } from "../src/workspace-environment.js";

describe("Environment variable policy (ADR-0024)", () => {
  it("reserves what the platform injects and what breaks a command's login shell", () => {
    for (const name of Object.keys(WORKSPACE_ENV)) expect(isReservedEnvironmentVariable(name)).toBe(true);
    for (const name of ["PATH", "USER", "SHELL", "PWD", "BASH_ENV", "ENV", "IFS", "LD_PRELOAD", "BASHOPTS"]) {
      expect(isReservedEnvironmentVariable(name)).toBe(true);
    }
    for (const name of ["OMA_TENANT_ID", "E2B_SANDBOX_ID", "ENVD_ACCESS_TOKEN", "BASH_XTRACEFD"]) {
      expect(isReservedEnvironmentVariable(name)).toBe(true);
    }
  });

  it("lets Environments set ordinary names, proxies and override the platform defaults", () => {
    for (const name of ["FOO", "HTTP_PROXY", "NO_PROXY", "LANG", "path", "OMAHA", "GEMINI_API_KEY", ...Object.keys(PLATFORM_DEFAULT_ENV)]) {
      expect(isReservedEnvironmentVariable(name)).toBe(false);
    }
  });

  it("points package managers at the Aliyun mirrors by default", () => {
    expect(PLATFORM_DEFAULT_ENV).toEqual({
      PIP_INDEX_URL: "https://mirrors.aliyun.com/pypi/simple/",
      NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com",
    });
    for (const name of Object.keys(PLATFORM_DEFAULT_ENV)) expect(name).toMatch(ENVIRONMENT_VARIABLE_NAME);
  });

  it("is the policy migration 0029 drops reserved Agent variables by, name for name", () => {
    const sql = readFileSync(new URL("../../../../deploy/migrations/0029_environment_migration.sql", import.meta.url), "utf8");
    const names = /AND v\.key NOT IN \(([^)]*)\)/.exec(sql)![1]!.match(/'([A-Z0-9_]+)'/g)!.map((quoted) => quoted.slice(1, -1));
    expect(new Set(names)).toEqual(RESERVED_ENVIRONMENT_VARIABLE_NAMES);
    expect(/AND v\.key !~ '\^\(([^)]*)\)'/.exec(sql)![1]!.split("|")).toEqual([...RESERVED_ENVIRONMENT_VARIABLE_PREFIXES]);
  });
});
