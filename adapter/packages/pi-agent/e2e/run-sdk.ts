/**
 * E2E runner for the Pi Agent adapter (real SDK path).
 * Drives the real `PiAgentAdapter` through a live `createAgentSession`, so it
 * exercises the same code path as production — event translation included.
 *
 * This file lives inside the pi-agent package (not the repo-root e2e/ dir) on
 * purpose: tsx resolves the `@earendil-works/*` deps against the importing
 * file's location, and those deps are nested under this package's node_modules
 * in the pnpm layout. Running it from repo root fails to resolve them.
 *
 * Auth: the Pi SDK reads credentials at request time (shared with the `pi`
 * CLI, e.g. `~/.pi/agent/auth.json`). Make sure the CLI is logged in first.
 *
 * Usage (from repo root):
 *   pnpm e2e:pi "What is 2+2?"
 *   pnpm e2e:pi                       (defaults to "Say hello in one word")
 *   pnpm e2e:pi --tools "Write hello.txt with 'hi', then read it back"
 *     ^ wires a LocalToolExecutor (temp dir) so the Sandbox-as-Tool path
 *       (custom tools + noTools:"builtin") is exercised end-to-end.
 *   pnpm e2e:pi --model codex "What is 2+2?"
 *     ^ picks the model/provider. Auth comes from ~/.pi/agent/auth.json, so use
 *       whichever provider you are logged into there (`pi login`). Default is
 *       claude-sonnet-4-5 (anthropic).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@open-managed-agents/adapter-core";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { PiAgentAdapter } from "../src/index.js";

async function main() {
  // Strip the argv separator "--" that pnpm passes through when this script is
  // invoked via `pnpm --filter ... e2e --`, plus the flags below.
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const useTools = argv.includes("--tools");

  // --model <id> selects the model/provider (default: claude-sonnet-4-5).
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : "claude-sonnet-4-5";

  const positional = argv.filter(
    (a, i) =>
      a !== "--tools" &&
      a !== "--model" &&
      !(modelIdx >= 0 && i === modelIdx + 1),
  );
  const prompt = positional[0] || "Say hello in one word";

  console.log(
    `\n--- Running Pi adapter e2e (SDK) model="${model}" prompt="${prompt}"` +
      `${useTools ? " [+tools]" : ""} ---\n`,
  );

  const adapter = new PiAgentAdapter();

  let toolExecutor: LocalToolExecutor | undefined;
  if (useTools) {
    const root = mkdtempSync(join(tmpdir(), "pi-e2e-"));
    toolExecutor = new LocalToolExecutor({ root });
    console.log(`(tool executor root: ${root})\n`);
  }

  const events = adapter.run({
    sessionId: "e2e-session",
    turnId: "e2e-turn",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: {
      model,
      system: "You are a helpful assistant. Be concise.",
    },
    history: [],
    constraints: { timeoutSeconds: 120 },
    ...(toolExecutor ? { toolExecutor } : {}),
  });

  for await (const event of events as AsyncIterable<SessionEvent>) {
    const { id, timestamp, type, ...rest } = event as any;
    const payload = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
    console.log(
      `[${timestamp}] ${type}${payload ? " " + payload.slice(0, 200) : ""}`,
    );
  }

  console.log("\n--- Done ---");
}

main().catch(console.error);
