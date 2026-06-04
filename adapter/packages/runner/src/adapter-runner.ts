#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
import type { AdapterInput } from "@open-managed-agents/adapter-core";
import {
  generateEventId,
  generateTimestamp,
} from "@open-managed-agents/adapter-core";
import { resolveAdapter } from "./resolve-adapter.js";

interface RunnerInput extends AdapterInput {
  runtime: string;
  adapterOptions?: Record<string, unknown>;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    process.stderr.write("Usage: adapter-runner <input.json>\n");
    process.exit(1);
  }

  const raw = await readFile(inputPath, "utf-8");
  const input = JSON.parse(raw) as RunnerInput;
  const { runtime, adapterOptions, ...adapterInput } = input;

  const adapter = await resolveAdapter(runtime, adapterOptions);

  for await (const event of adapter.run(adapterInput)) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}

main().catch((err: unknown) => {
  const errorEvent = {
    id: generateEventId(),
    timestamp: generateTimestamp(),
    type: "session.error",
    error: { message: String(err), code: "runner_error" },
  };
  process.stdout.write(JSON.stringify(errorEvent) + "\n");
  process.exit(1);
});
