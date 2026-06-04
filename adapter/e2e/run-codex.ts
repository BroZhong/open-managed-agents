/**
 * E2E runner for Codex adapter.
 * Spawns `codex exec --json` and pipes output through the CodexAdapter translator.
 *
 * Usage:
 *   pnpm e2e:codex "What is 2+2?"
 *   pnpm e2e:codex  (defaults to "Say hello in one word")
 */

import type { SessionEvent } from "../packages/core/src/index.js";
import { CodexAdapter } from "../packages/codex/src/index.js";

async function main() {
  const prompt = process.argv[2] || "Say hello in one word";
  console.log(`\n--- Running Codex adapter e2e with prompt: "${prompt}" ---\n`);

  const adapter = new CodexAdapter({
    sandbox: "danger-full-access",
  });

  const events = adapter.run({
    sessionId: "e2e-session",
    turnId: "e2e-turn",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    agent: { model: "gpt-5.5", system: "You are a helpful assistant. Be concise." },
    history: [],
    constraints: { timeoutSeconds: 120 },
  });

  for await (const event of events as AsyncIterable<SessionEvent>) {
    const { id, timestamp, type, ...rest } = event as any;
    const payload = Object.keys(rest).length > 0 ? JSON.stringify(rest) : "";
    console.log(
      `[${timestamp}] ${type}${payload ? " " + payload.slice(0, 200) : ""}`
    );
  }

  console.log("\n--- Done ---");
}

main().catch(console.error);
