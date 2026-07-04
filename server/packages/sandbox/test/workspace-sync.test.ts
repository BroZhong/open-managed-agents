import { describe, it, expect } from "vitest";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { SandboxToolExecutor } from "../src/sandbox-tool-executor.js";
import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "@oma-server/store";

// ─── Mock S3 ArtifactStore that records every put/delete ────────────────────

class MockArtifactStore implements ArtifactStore {
  // key: `${tenant}/${workspace}/${path}` -> bytes
  private readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  readonly deletes: string[] = [];

  private key(t: string, w: string, p: string): string {
    return `${t}/${w}/${p}`;
  }

  seed(tenant: string, workspace: string, path: string, content: string): void {
    this.objects.set(this.key(tenant, workspace, path), new TextEncoder().encode(content));
  }

  /** Current stored content for a workspace-relative path (or undefined). */
  contentOf(tenant: string, workspace: string, path: string): string | undefined {
    const body = this.objects.get(this.key(tenant, workspace, path));
    return body ? new TextDecoder().decode(body) : undefined;
  }

  /** Workspace-relative paths currently present in the store. */
  pathsOf(tenant: string, workspace: string): string[] {
    const prefix = `${tenant}/${workspace}/`;
    const out: string[] = [];
    for (const k of this.objects.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out.sort();
  }

  async list(tenantId: string, workspaceId: string, prefix = ""): Promise<Artifact[]> {
    const wsPrefix = `${tenantId}/${workspaceId}/`;
    const results: Artifact[] = [];
    for (const [k, v] of this.objects) {
      if (!k.startsWith(wsPrefix)) continue;
      const rel = k.slice(wsPrefix.length);
      if (prefix && !rel.startsWith(prefix)) continue;
      results.push({ path: rel, size: v.byteLength });
    }
    return results;
  }

  async get(tenantId: string, workspaceId: string, path: string): Promise<ArtifactContent | null> {
    const body = this.objects.get(this.key(tenantId, workspaceId, path));
    if (!body) return null;
    return { path, body };
  }

  async put(input: ArtifactPutInput): Promise<Artifact> {
    const body =
      typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
    this.objects.set(this.key(input.tenantId, input.workspaceId, input.path), body);
    this.puts.push(input.path);
    return { path: input.path, size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    this.deletes.push(path);
    return this.objects.delete(this.key(tenantId, workspaceId, path));
  }
}

const TENANT = "tenant_1";
const WS = "ws_1";

function makeExecutor(opts?: {
  seed?: Array<[string, string]>;
  sandboxClient?: FakeSandboxClient;
  artifactStore?: MockArtifactStore;
  workspaceId?: string;
}) {
  const artifactStore = opts?.artifactStore ?? new MockArtifactStore();
  const workspaceId = opts?.workspaceId ?? WS;
  for (const [path, content] of opts?.seed ?? []) {
    artifactStore.seed(TENANT, workspaceId, path, content);
  }
  const sandboxClient = opts?.sandboxClient ?? new FakeSandboxClient();
  const executor = new SandboxToolExecutor({
    sandboxClient,
    artifactStore,
    tenantId: TENANT,
    workspaceId,
  });
  return { executor, sandboxClient, artifactStore };
}

/**
 * A fake exec handler that simulates `sh -c "printf '<content>' > <abs-path>"`,
 * so a test can create a file *by any means* (bash), not through writeFile,
 * and then prove the full scan picks it up.
 */
function bashWriteHandler(sandboxClient: FakeSandboxClient) {
  return new FakeSandboxClient({
    execHandler: (command, files) => {
      // shape: ["sh", "-c", "printf %s '<content>' > <abs-path>"]
      if (command[0] === "sh" && command[1] === "-c") {
        const script = command[2] ?? "";
        const m = script.match(/printf %s '([\s\S]*)' > (\S+)/);
        if (m) {
          files.set(m[2], { content: m[1], mtimeMs: Date.now() });
          return [];
        }
      }
      return undefined;
    },
  });
}

async function drainExec(
  it: AsyncIterable<{ stream: "stdout" | "stderr"; text: string }>,
): Promise<void> {
  for await (const _ of it) {
    // discard
  }
}

describe("SandboxToolExecutor — workspace sync (#43)", () => {
  it("sync is a no-op with an empty result when no sandbox was ever created", async () => {
    const { executor, artifactStore } = makeExecutor();
    const result = await executor.sync();
    expect(result).toEqual({ tenantId: TENANT, workspaceId: WS, changed: [], deleted: [] });
    expect(artifactStore.puts).toHaveLength(0);
    expect(artifactStore.deletes).toHaveLength(0);
  });

  it("a bash-created file appears in S3 after sync (full scan, not a write tool)", async () => {
    const sandboxClient = bashWriteHandler(new FakeSandboxClient());
    const { executor, artifactStore } = makeExecutor({ sandboxClient });

    // Force create/hydrate, then create a file purely via bash.
    await executor.list();
    await drainExec(
      executor.exec(["sh", "-c", "printf %s 'from-bash' > /workspace/out/report.txt"]),
    );

    const result = await executor.sync();

    expect(result.changed).toContain("out/report.txt");
    expect(artifactStore.contentOf(TENANT, WS, "out/report.txt")).toBe("from-bash");
  });

  it("pushes only changed/new files; a same-size edit is still synced (hash, not size)", async () => {
    // Baseline: two files. "keep.txt" stays byte-identical; "edit.txt" gets a
    // same-length edit (aaaa -> bbbb) that a size comparison would miss.
    const { executor, sandboxClient, artifactStore } = makeExecutor({
      seed: [
        ["keep.txt", "unchanged"],
        ["edit.txt", "aaaa"],
      ],
    });

    await executor.list(); // create + hydrate
    const id = sandboxClient.created[0];
    // Same-size edit directly in the sandbox file map.
    await sandboxClient.writeFile(id, "/workspace/edit.txt", "bbbb");
    // Also add a brand-new file.
    await sandboxClient.writeFile(id, "/workspace/new.txt", "hello");

    const result = await executor.sync();

    // keep.txt is unchanged → not pushed. edit.txt (same size) + new.txt pushed.
    expect(result.changed.sort()).toEqual(["edit.txt", "new.txt"]);
    expect(artifactStore.puts.sort()).toEqual(["edit.txt", "new.txt"]);
    expect(artifactStore.contentOf(TENANT, WS, "edit.txt")).toBe("bbbb");
    expect(artifactStore.contentOf(TENANT, WS, "keep.txt")).toBe("unchanged");
  });

  it("does not re-push an unchanged file on a second sync", async () => {
    const { executor, sandboxClient, artifactStore } = makeExecutor({
      seed: [["a.txt", "A"]],
    });
    await executor.list();
    const id = sandboxClient.created[0];
    await sandboxClient.writeFile(id, "/workspace/b.txt", "B");

    const first = await executor.sync();
    expect(first.changed).toEqual(["b.txt"]);
    expect(artifactStore.puts).toEqual(["b.txt"]);

    // Nothing changed since → second sync pushes nothing.
    const second = await executor.sync();
    expect(second.changed).toEqual([]);
    expect(artifactStore.puts).toEqual(["b.txt"]);
  });

  it("rm of a hydrated file propagates a delete to S3", async () => {
    const { executor, sandboxClient, artifactStore } = makeExecutor({
      seed: [
        ["gone.txt", "bye"],
        ["stay.txt", "here"],
      ],
    });

    await executor.list(); // create + hydrate; baseline = [gone.txt, stay.txt]
    const id = sandboxClient.created[0];
    // Simulate `rm /workspace/gone.txt` — drop it from the sandbox file map.
    sandboxClient.filesOf(id).delete("/workspace/gone.txt");

    const result = await executor.sync();

    expect(result.deleted).toEqual(["gone.txt"]);
    expect(artifactStore.deletes).toContain("gone.txt");
    expect(artifactStore.contentOf(TENANT, WS, "gone.txt")).toBeUndefined();
    // The surviving hydrated file is untouched.
    expect(artifactStore.contentOf(TENANT, WS, "stay.txt")).toBe("here");
  });

  it("baseline-diff: a concurrent session's new file is NEVER deleted", async () => {
    // Shared Workspace, two sandboxes (= two sessions) on the same S3 store.
    const artifactStore = new MockArtifactStore();
    artifactStore.seed(TENANT, WS, "shared.txt", "orig");

    const clientA = new FakeSandboxClient();
    const clientB = new FakeSandboxClient();
    const a = makeExecutor({ artifactStore, sandboxClient: clientA });
    const b = makeExecutor({ artifactStore, sandboxClient: clientB });

    // Both hydrate from the same baseline: only "shared.txt".
    await a.executor.list();
    await b.executor.list();
    expect([...a.executor.baseline]).toEqual(["shared.txt"]);
    expect([...b.executor.baseline]).toEqual(["shared.txt"]);

    // Session B creates a brand-new file and syncs it to S3.
    const idB = clientB.created[0];
    await clientB.writeFile(idB, "/workspace/b-only.txt", "from-B");
    await b.executor.sync();
    expect(artifactStore.contentOf(TENANT, WS, "b-only.txt")).toBe("from-B");

    // Session A now syncs. b-only.txt is NOT in A's hydrate baseline, so even
    // though A's sandbox does not have it, A must not delete it.
    const resultA = await a.executor.sync();
    expect(resultA.deleted).toEqual([]);
    expect(artifactStore.contentOf(TENANT, WS, "b-only.txt")).toBe("from-B");
    expect(artifactStore.deletes).not.toContain("b-only.txt");
  });

  it("holds the hydrate baseline in memory and discards it when the sandbox is destroyed", async () => {
    const { executor } = makeExecutor({ seed: [["a.txt", "A"], ["b.txt", "B"]] });

    await executor.list(); // hydrate
    expect([...executor.baseline]).toEqual(["a.txt", "b.txt"]);

    await executor.dispose(); // destroy → baseline discarded
    expect([...executor.baseline]).toEqual([]);
  });
});
