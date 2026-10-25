import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_VARIABLE_NAME,
  PLATFORM_DEFAULT_ENV,
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
});
