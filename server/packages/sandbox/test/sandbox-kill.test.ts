import { describe, expect, it, vi } from "vitest";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { killBindingSandboxes, killSandboxes } from "../src/sandbox-kill.js";
import { SANDBOX_BINDING_LABEL } from "../src/sandbox-sweep.js";
import { FAKE_ENVIRONMENT_IMAGE } from "../src/fake-environments.js";

const ofBinding = (client: FakeSandboxClient, bindingId: string) =>
  client.create({ image: FAKE_ENVIRONMENT_IMAGE, metadata: { [SANDBOX_BINDING_LABEL]: bindingId } }).then(({ id }) => id);

describe("killing Sandboxes and confirming them missing", () => {
  it("kills each Sandbox once, attempts every one past a failure, and counts one already missing as killed", async () => {
    const client = new FakeSandboxClient();
    const [a, b, c] = [await ofBinding(client, "x"), await ofBinding(client, "x"), await ofBinding(client, "x")];
    await client.destroy(c);
    const destroy = vi.spyOn(client, "destroy");
    const failure = new Error("gateway unavailable");
    destroy.mockImplementationOnce(async () => { throw failure; });
    const kills = await killSandboxes(client, [a, b, a, c]);
    expect(kills).toEqual({ killed: [b, c], failed: [{ sandboxId: a, error: failure }] });
    expect(destroy.mock.calls.map(([id]) => id)).toEqual([a, b, c]);
    expect(await client.state(a)).toBe("running");
  });

  it("kills a binding's recorded Sandbox, then every one the gateway lists for that binding alone, running or paused", async () => {
    const client = new FakeSandboxClient();
    const recorded = await ofBinding(client, "root");
    const extra = await ofBinding(client, "root");
    const paused = await ofBinding(client, "root");
    client.pause(paused);
    const other = await ofBinding(client, "root-2");
    const unlabelled = (await client.create({ image: FAKE_ENVIRONMENT_IMAGE })).id;
    const list = vi.spyOn(client, "listSandboxes");
    const destroy = vi.spyOn(client, "destroy");
    expect(await killBindingSandboxes(client, "root", recorded)).toEqual([recorded, extra, paused]);
    expect(destroy.mock.calls.map(([id]) => id)).toEqual([recorded, extra, paused]);
    // Listed after the recorded one went, by the exact binding label.
    expect(destroy.mock.invocationCallOrder[0]).toBeLessThan(list.mock.invocationCallOrder[0]);
    expect(list).toHaveBeenCalledExactlyOnceWith({ metadata: { [SANDBOX_BINDING_LABEL]: "root" }, states: ["running", "paused"] });
    expect((await list.mock.results[0].value).map(({ sandboxId }: { sandboxId: string }) => sandboxId)).toEqual([extra, paused]);
    expect(await client.state(other)).toBe("running");
    expect(await client.state(unlabelled)).toBe("running");
  });

  it("lists a binding that records no Sandbox, and kills what a lost create left", async () => {
    const client = new FakeSandboxClient();
    const orphan = await ofBinding(client, "root");
    expect(await killBindingSandboxes(client, "root", null)).toEqual([orphan]);
    expect(await killBindingSandboxes(client, "root", null)).toEqual([]);
  });

  it("rejects with the first failure after attempting the rest, and kills the recorded Sandbox even when the list fails", async () => {
    const client = new FakeSandboxClient();
    const recorded = await ofBinding(client, "root");
    const extra = await ofBinding(client, "root");
    const later = await ofBinding(client, "root");
    const destroy = vi.spyOn(client, "destroy");
    destroy.mockImplementationOnce(async () => { throw new Error("recorded kill failed"); });
    await expect(killBindingSandboxes(client, "root", recorded)).rejects.toThrow("recorded kill failed");
    // The recorded one is not attempted twice in one reclamation; the listed ones went.
    expect(destroy.mock.calls.map(([id]) => id)).toEqual([recorded, extra, later]);
    expect(await client.state(recorded)).toBe("running");

    vi.spyOn(client, "listSandboxes").mockRejectedValueOnce(new Error("Sandbox list answered HTTP 503"));
    await expect(killBindingSandboxes(client, "root", recorded)).rejects.toThrow("HTTP 503");
    expect(await client.state(recorded)).toBe("missing");
  });
});
