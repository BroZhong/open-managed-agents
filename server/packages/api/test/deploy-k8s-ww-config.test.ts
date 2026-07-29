import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for issue #116.
 *
 * `deploy/k8s.yaml` used to put the managed OpenGrove WW integration into a
 * half-configured state: the ConfigMap supplied
 * DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL and ..._AGENT_IDS as literals, while
 * ..._ACCESS_TOKEN was wired through a `secretKeyRef` to an `oma-secrets` key
 * that only an uncommitted, never-executed `kubectl create secret` line was
 * supposed to create. At runtime two of the three variables were set and the
 * third was absent — exactly the state `sandboxEnvPolicyFromHost` fails loud
 * on — so a full `kubectl apply` crash-looped oma-server at startup.
 *
 * What a repo-level test can and cannot check matters here. It can see that the
 * three variables move together, and that the default path does not depend on a
 * Secret key created only by an out-of-band manual step. It cannot see whether
 * an `oma-secrets` key actually exists in a cluster — that is the half of #116
 * no committed file can prove, which is why enabling WW is documented as an
 * ordered procedure whose first step creates and verifies the key. So the
 * invariants asserted are: all three or none, the secret reference is inert by
 * default, and while it is off the way to turn it on stays written down.
 *
 * The manifest is read as raw text on purpose: no YAML parser is resolvable
 * from this package (`yaml` exists only as a transitive dependency of
 * vite/vitest, hoisted where this package cannot import it), and per the repo
 * convention we do not add a dependency just to lint one manifest. A
 * line-oriented scan suffices because the question is only which variable
 * names appear on active, non-commented lines — the commented-out "how to turn
 * WW on" block must not count as configuration.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const K8S_MANIFEST = `${REPO_ROOT}deploy/k8s.yaml`;

const WW_VARIABLES = [
  "DEFAULT_SANDBOX_OPENGROVE_WW_BASE_URL",
  "DEFAULT_SANDBOX_OPENGROVE_WW_ACCESS_TOKEN",
  "DEFAULT_SANDBOX_OPENGROVE_WW_AGENT_IDS",
] as const;

const allLines = readFileSync(K8S_MANIFEST, "utf8").split("\n");
const isComment = (line: string) => line.trim().startsWith("#");
const activeLines = allLines.filter((line) => !isComment(line));
const commentText = allLines.filter(isComment).join("\n");

const activeWwVariables = WW_VARIABLES.filter((name) =>
  activeLines.some((line) => line.includes(name)),
);

describe("deploy/k8s.yaml managed OpenGrove WW configuration", () => {
  it("wires either all three WW variables or none", () => {
    if (activeWwVariables.length === 0) return; // WW off — the supported default.

    expect(
      activeWwVariables.length,
      "deploy/k8s.yaml wires a PARTIAL managed OpenGrove WW configuration " +
        `(${JSON.stringify(activeWwVariables)}). sandboxEnvPolicyFromHost ` +
        "throws at startup unless all three of " +
        `${JSON.stringify([...WW_VARIABLES])} resolve, or none are set. ` +
        "Enable or disable them together — see the OpenGrove WW block in the " +
        "manifest for the ordered procedure.",
    ).toBe(WW_VARIABLES.length);
  });

  it("never activates the WW secret key reference by default", () => {
    // Criterion #2 of the issue: the missing secret key must not be something
    // the default path silently depends on.
    const activeSecretKeyRef = activeLines.filter((line) =>
      line.includes("key: OPENGROVE_WW_ACCESS_TOKEN"),
    );
    expect(
      activeSecretKeyRef,
      "deploy/k8s.yaml references oma-secrets key OPENGROVE_WW_ACCESS_TOKEN " +
        "on an active line; the default path must not depend on a secret key " +
        "created only by an out-of-band manual step.",
    ).toEqual([]);
  });

  it("documents how to turn WW on while it is off by default", () => {
    if (activeWwVariables.length > 0) return;

    // Re-enabling must stay a documented, deliberate, all-or-nothing step
    // rather than tribal knowledge.
    for (const name of WW_VARIABLES) {
      expect(
        commentText.includes(name),
        "deploy/k8s.yaml disables managed OpenGrove WW but does not mention " +
          `${name} in a comment. Keep the "how to turn WW on" block complete.`,
      ).toBe(true);
    }
    expect(
      /kubectl[^\n]*secret/.test(commentText),
      "the WW enablement comment must include the kubectl command that " +
        "creates the oma-secrets OPENGROVE_WW_ACCESS_TOKEN key.",
    ).toBe(true);
  });
});
