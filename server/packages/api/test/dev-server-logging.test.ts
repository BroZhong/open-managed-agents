import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));

async function captureStartupLog(
  authDisabled: "true" | "false",
  extraEnv: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/dev-server-memory.ts"],
      {
        cwd: API_PACKAGE_DIR,
        env: {
          ...process.env,
          ...extraEnv,
          AUTH_DISABLED: authDisabled,
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let stopping = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`dev server did not start; output:\n${output}`));
    }, 15_000);

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (!stopping && output.includes("Server listening on")) {
        stopping = true;
        setTimeout(() => child.kill("SIGTERM"), 100);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timeout);
      resolve(output);
    });
  });
}

describe("development server startup logging", () => {
  it.each(["false", "true"] as const)(
    "does not expose the generated API key when AUTH_DISABLED=%s",
    async (authDisabled) => {
      const output = await captureStartupLog(authDisabled);

      expect(output).not.toMatch(/(?:omak_[A-Za-z0-9_-]+|sk-test-[A-Za-z0-9_-]+)/);
    },
    20_000,
  );

  it("does not expose Host-managed sandbox credentials", async () => {
    const secret = "ww-token-must-not-be-logged";
    const output = await captureStartupLog("true", {
      DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL: "https://ww.example.test",
      DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN: secret,
    });

    expect(output).not.toContain(secret);
  }, 20_000);
});
