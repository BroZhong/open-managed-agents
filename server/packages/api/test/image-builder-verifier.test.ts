import { describe, expect, it } from "vitest";
import { FakeSandboxClient, SandboxCreateRejected, type SandboxExecChunk } from "@oma-server/sandbox";
import { MANIFEST_PATH, SandboxImageVerifier } from "../src/image-builder/verifier.js";

const IMAGE = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-environments@sha256:${"e".repeat(64)}`;
const POOL = `registry-vpc.cn-shanghai.aliyuncs.com/welltop/oma-sandbox@sha256:${"p".repeat(0)}${"f".repeat(64)}`;
const REF = { environmentId: "env_1", buildId: "envb_1", attempt: 2 };
const MANIFEST = { schemaVersion: 1, dpkg: [{ name: "jq", version: "1.6" }], pip: [{ packages: [{ name: "requests" }] }], binaries: { node: {} } };

function setup(facts = "bash=5.2.15(1)-release\nuser=user\nhome=user:user\n", manifest: string | null = JSON.stringify(MANIFEST)) {
  const commands: string[][] = [];
  const client = new FakeSandboxClient({
    poolImage: POOL,
    execHandler: (command, files): SandboxExecChunk[] => {
      commands.push(command);
      if (manifest !== null) files.set(MANIFEST_PATH, { content: manifest, mtimeMs: 1 });
      return [{ stream: "stdout", text: facts }];
    },
  });
  const verifier = new SandboxImageVerifier({ client, environment: "test" });
  const logged: string[] = [];
  const verify = () => verifier.verify(IMAGE, { ref: REF, log: (text) => logged.push(text), signal: new AbortController().signal });
  return { client, verifier, logged, verify, commands };
}

describe("SandboxImageVerifier", () => {
  it("claims a Sandbox with the image, checks envd, bash, the user and /home/user, reads the manifest and destroys it", async () => {
    const { client, verify, logged, commands } = setup();
    expect(await verify()).toEqual({ ok: true, manifest: MANIFEST });
    const [id] = client.created;
    expect(client.createOptsOf(id!)).toMatchObject({
      image: IMAGE, timeoutSeconds: 900,
      metadata: {
        "oma.dev/environment": "test", "oma.dev/purpose": "environment-verification",
        "oma.dev/environment-id": "env_1", "oma.dev/environment-build-id": "envb_1", "oma.dev/build-attempt": "2",
      },
    });
    expect(client.createOptsOf(id!)).not.toHaveProperty("env");
    expect(commands[0]!.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(client.liveCount).toBe(0);
    expect(logged.join("\n")).toMatch(/Claimed Sandbox .* its image swapped in place\./);
    expect(logged.join("\n")).toContain("envd answers; bash 5.2.15(1)-release runs as user; /home/user is owned by user.");
    expect(logged.join("\n")).toContain("1 dpkg packages, 1 Python packages in 1 environments, 1 binaries");
  });

  it.each([
    ["bash=\nuser=user\nhome=user:user\n", "bash does not run in the image"],
    ["bash=5.2\nuser=root\nhome=user:user\n", "Commands run as root, not user"],
    ["bash=5.2\nuser=user\nhome=root:root\n", "/home/user is owned by root:root, not user:user"],
  ])("rejects an image whose Sandbox reports %j", async (facts, message) => {
    const { client, verify } = setup(facts);
    expect(await verify()).toEqual({ ok: false, kind: "image", message: expect.stringContaining(message) });
    expect(client.liveCount).toBe(0);
  });

  it("rejects an image without a readable manifest", async () => {
    expect(await setup(undefined, null).verify()).toMatchObject({ ok: false, kind: "image", message: expect.stringContaining(`${MANIFEST_PATH} is missing or not JSON`) });
    expect(await setup(undefined, "[1]").verify()).toMatchObject({ ok: false, kind: "image", message: `${MANIFEST_PATH} is not a JSON object` });
  });

  it("reports a failed claim as infrastructure", async () => {
    const { client, verify } = setup();
    client.createFault = () => { throw new SandboxCreateRejected(503); };
    expect(await verify()).toEqual({ ok: false, kind: "infrastructure", message: "Claiming a Sandbox with the image failed: Sandbox create answered HTTP 503" });
  });

  it("destroys only verification Sandboxes of its environment that `keep` rejects", async () => {
    const { client, verifier } = setup();
    const label = (attempt: number, environment = "test") => ({
      "oma.dev/environment": environment, "oma.dev/purpose": "environment-verification",
      "oma.dev/environment-id": "env_1", "oma.dev/environment-build-id": "envb_1", "oma.dev/build-attempt": String(attempt),
    });
    const stale = await client.create({ image: IMAGE, metadata: label(1) });
    const live = await client.create({ image: IMAGE, metadata: label(2) });
    const production = await client.create({ image: IMAGE, metadata: label(1, "production") });
    const session = await client.create({ image: IMAGE, metadata: { "oma.dev/environment": "test", "oma.dev/sandbox-binding": "sbb_1" } });
    expect(await verifier.sweep(async (ref) => ref.attempt === 2)).toBe(1);
    expect(await client.state(stale.id)).toBe("missing");
    for (const kept of [live, production, session]) expect(await client.state(kept.id)).toBe("running");
  });
});
