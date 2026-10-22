import type { Adapter } from "@open-managed-agents/adapter-core";
import type { Runtime } from "@oma-server/store";

/**
 * Resolve an Agent runtime to the Adapter a Runner executes it with. Every
 * other runtime, including the retired claude-code and codex that existing
 * Agents may still carry, resolves to undefined so the SessionRouter ends that
 * Turn with `unsupported_runtime` instead of running it.
 */
export function runtimeAdapters(
  adapters: Partial<Record<Runtime, Adapter>>,
): (runtime: string) => Adapter | undefined {
  return (runtime) => Object.hasOwn(adapters, runtime) ? adapters[runtime as Runtime] : undefined;
}
