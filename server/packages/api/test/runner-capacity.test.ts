import { describe, expect, it } from "vitest";
import { runnerCapacityFromEnv, runnerClaimOwnerId } from "../src/lib/runner-capacity.js";

describe("the Runner's capacity and claim owner from its environment (ADR-0026)", () => {
  it("RUNNER_CAPACITY defaults to 50, and anything but a positive integer refuses the Runner's start", () => {
    expect(runnerCapacityFromEnv({})).toBe(50);
    expect(runnerCapacityFromEnv({ RUNNER_CAPACITY: "3" })).toBe(3);
    expect(runnerCapacityFromEnv({ RUNNER_CAPACITY: " 50 " })).toBe(50);
    for (const value of ["", "0", "-1", "1.5", "abc", "50abc", "1e2"]) {
      expect(() => runnerCapacityFromEnv({ RUNNER_CAPACITY: value }), value).toThrow(RangeError);
    }
  });

  it("claims as its Pod's name and a suffix of its own process, or as host outside Kubernetes", () => {
    expect(runnerClaimOwnerId({ POD_NAME: "oma-runner-7d9f8c-x2k4p" }, "a1b2c3d4")).toBe("oma-runner-7d9f8c-x2k4p_a1b2c3d4");
    expect(runnerClaimOwnerId({})).toMatch(/^host_[0-9a-f]{8}$/);
    // A restarted container in the same Pod claims as a different owner.
    expect(runnerClaimOwnerId({ POD_NAME: "oma-runner-1" })).not.toBe(runnerClaimOwnerId({ POD_NAME: "oma-runner-1" }));
  });
});
