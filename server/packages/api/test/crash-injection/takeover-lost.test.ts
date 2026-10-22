import { describe, expect, it } from "vitest";
import { describeWrite, execute, expectResumed, rowOf, usePiSettings, writesOf } from "./harness.js";
import { parallelTools as scenario } from "./scenarios.js";

await usePiSettings();

describe("crash injection: the takeover is lost too (A17)", async () => {
  const writes = await writesOf(scenario);
  const call = writes.findIndex((write) => describeWrite(write) === "append agent.context_entry(assistant)") + 1;
  const firstResult = call + 1;
  // The first Runner is lost with all three calls dangling, or with one result
  // committed; the Runner that takes over is then lost after each of its writes.
  for (const lostAt of [call, firstResult]) {
    const takeover = (await execute(scenario, [lostAt])).runners[1].writes;
    it.each(takeover.map((write, index) => [lostAt, index + 1, describeWrite(write), rowOf(takeover, index)] as const))(
      "Runner 0 lost after write %i, Runner 1 after its write %i (%s, %s): repairs are written once and the Turn completes",
      async (_lostAt, n) => {
        const outcome = await execute(scenario, [lostAt, n]);
        expectResumed(scenario, outcome);
        expect(outcome.runners.length).toBeGreaterThanOrEqual(2);
      });
  }
});
