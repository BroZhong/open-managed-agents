import type { OutputBlockRef } from "@/lib/types";

/** Stable identity shared by transient Deltas and their Complete Event. */
export function outputBlockKey(block: OutputBlockRef): string {
  return `${block.turnId}:${block.blockIndex}`;
}
