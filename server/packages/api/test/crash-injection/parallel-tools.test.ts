import { describe } from "vitest";
import { sweep, usePiSettings } from "./harness.js";
import { parallelTools } from "./scenarios.js";

await usePiSettings();

describe("crash injection: parallel tool calls", async () => {
  await sweep(parallelTools);
});
