import type { Adapter } from "@open-managed-agents/adapter-core";
import { PiAgentAdapter } from "@open-managed-agents/adapter-pi-agent";

/**
 * The dependency-light memory server still uses the canonical Pi SDK adapter.
 * Keeping this singleton in a tiny module makes the default dev entrypoint
 * testable without importing (and starting) its HTTP server.
 */
export const memoryPiAgentAdapter: Adapter = new PiAgentAdapter();
