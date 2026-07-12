import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeChildArgs } from "./pi-subagent-safe.mjs";

test("subagent wrapper removes Host tool/context escape hatches", () => {
  const agentDir = "/root/.pi/agent";
  const allowed =
    "/root/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts";

  assert.deepEqual(
    sanitizeChildArgs(
      [
        "--mode",
        "json",
        "--tools",
        "read,bash,write",
        "--skill",
        "/tmp/untrusted-skill",
        "--extension",
        "/tmp/untrusted-extension.ts",
        "--extension",
        allowed,
        "Task: design shots",
      ],
      agentDir,
    ),
    [
      "--no-tools",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--mode",
      "json",
      "--extension",
      allowed,
      "Task: design shots",
    ],
  );
});

test("subagent wrapper removes equals and short-form tool flags", () => {
  assert.deepEqual(
    sanitizeChildArgs(
      ["--tools=read,bash", "-t", "write", "--skill=/tmp/x", "Task: review"],
      "/root/.pi/agent",
    ),
    [
      "--no-tools",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "Task: review",
    ],
  );
});
