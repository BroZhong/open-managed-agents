#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";

const SAFETY_FLAGS = [
  "--no-tools",
  "--no-context-files",
  "--no-skills",
  "--no-extensions",
  "--no-prompt-templates",
];

const DROP_WITH_VALUE = new Set([
  "--tools",
  "-t",
  "--skill",
  "--prompt-template",
]);

const DROP_PREFIXES = ["--tools=", "--skill=", "--prompt-template="];

function canonical(path) {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function isPiSubagentsExtension(path, agentDir) {
  const packageRoot = canonical(
    join(agentDir, "npm", "node_modules", "pi-subagents"),
  );
  const candidate = canonical(path);
  return candidate === packageRoot || candidate.startsWith(`${packageRoot}${sep}`);
}

/**
 * Keep child Pi as a text-only reasoning process. pi-subagents adds its own
 * prompt/boundary extensions explicitly; those are the only extension paths we
 * retain. Tool/Skill flags are removed even when an Agent definition tried to
 * opt back in, and the safety flags are prepended deterministically.
 */
export function sanitizeChildArgs(input, agentDir) {
  const output = [...SAFETY_FLAGS];

  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];

    if (DROP_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (DROP_PREFIXES.some((prefix) => arg.startsWith(prefix))) {
      continue;
    }
    if (SAFETY_FLAGS.includes(arg) || ["-nt", "-nc", "-ns", "-ne", "-np"].includes(arg)) {
      continue;
    }

    if (arg === "--extension" || arg === "-e") {
      const path = input[index + 1];
      index += 1;
      if (path && isPiSubagentsExtension(path, agentDir)) {
        output.push("--extension", path);
      }
      continue;
    }
    if (arg.startsWith("--extension=")) {
      const path = arg.slice("--extension=".length);
      if (path && isPiSubagentsExtension(path, agentDir)) {
        output.push("--extension", path);
      }
      continue;
    }

    output.push(arg);
  }

  return output;
}

function run() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
    || join(homedir(), ".pi", "agent");
  const realPi = process.env.PI_SUBAGENT_REAL_PI_BINARY?.trim()
    || "/app/adapter/packages/pi-agent/node_modules/.bin/pi";
  const args = sanitizeChildArgs(process.argv.slice(2), agentDir);
  const child = spawn(realPi, args, {
    env: process.env,
    stdio: "inherit",
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  child.on("error", (error) => {
    console.error(`Unable to start safe Pi subagent: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && canonical(process.argv[1]) === canonical(fileURLToPath(import.meta.url))) {
  run();
}
