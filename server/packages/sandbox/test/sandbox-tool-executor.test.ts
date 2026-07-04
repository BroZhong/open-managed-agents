import { describe, it, expect } from "vitest";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import { SandboxToolExecutor } from "../src/sandbox-tool-executor.js";
import type {
  Artifact,
  ArtifactContent,
  ArtifactPutInput,
  ArtifactStore,
} from "@oma-server/store";

// ─── In-memory ArtifactStore (a stand-in S3 Workspace) ──────────────────────

class InMemoryArtifactStore implements ArtifactStore {
  // key: `${tenant}/${workspace}/${path}` -> bytes
  private readonly objects = new Map<string, Uint8Array>();

  private key(t: string, w: string, p: string): string {
    return `${t}/${w}/${p}`;
  }

  seed(tenant: string, workspace: string, path: string, content: string): void {
    this.objects.set(this.key(tenant, workspace, path), new TextEncoder().encode(content));
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
    return { path: input.path, size: body.byteLength };
  }

  async delete(tenantId: string, workspaceId: string, path: string): Promise<boolean> {
    return this.objects.delete(this.key(tenantId, workspaceId, path));
  }
}

function makeExecutor(opts?: {
  seed?: Array<[string, string]>;
  sandboxClient?: FakeSandboxClient;
}) {
  const artifactStore = new InMemoryArtifactStore();
  for (const [path, content] of opts?.seed ?? []) {
    artifactStore.seed("tenant_1", "ws_1", path, content);
  }
  const sandboxClient = opts?.sandboxClient ?? new FakeSandboxClient();
  const executor = new SandboxToolExecutor({
    sandboxClient,
    artifactStore,
    tenantId: "tenant_1",
    workspaceId: "ws_1",
  });
  return { executor, sandboxClient, artifactStore };
}

async function drainExec(
  it: AsyncIterable<{ stream: "stdout" | "stderr"; text: string }>,
): Promise<string> {
  let out = "";
  for await (const chunk of it) {
    if (chunk.stream === "stdout") out += chunk.text;
  }
  return out;
}

describe("SandboxToolExecutor", () => {
  it("creates NO sandbox until the first filesystem/code tool call (lazy create)", async () => {
    const { executor, sandboxClient } = makeExecutor();
    // Constructing + a pure-chat turn touch nothing.
    expect(executor.created).toBe(false);
    expect(sandboxClient.liveCount).toBe(0);
    expect(sandboxClient.created).toHaveLength(0);
  });

  it("creates exactly one sandbox on first tool use", async () => {
    const { executor, sandboxClient } = makeExecutor();

    await executor.writeFile("a.txt", "hi");

    expect(executor.created).toBe(true);
    expect(sandboxClient.created).toHaveLength(1);
    expect(sandboxClient.liveCount).toBe(1);

    // A second op reuses the same sandbox — no second create.
    await executor.readFile("a.txt");
    expect(sandboxClient.created).toHaveLength(1);
  });

  it("does not create a second sandbox under concurrent first calls", async () => {
    const { executor, sandboxClient } = makeExecutor({ seed: [["x.txt", "X"]] });

    await Promise.all([
      executor.readFile("x.txt"),
      executor.list(),
      drainExec(executor.exec(["echo", "hi"])),
    ]);

    expect(sandboxClient.created).toHaveLength(1);
  });

  it("hydrates the sandbox /workspace from the S3 Workspace on create", async () => {
    const { executor, sandboxClient } = makeExecutor({
      seed: [
        ["notes/todo.md", "buy milk"],
        ["main.py", "print('hi')"],
      ],
    });

    // First tool use triggers create + hydrate.
    await executor.list();

    const id = sandboxClient.created[0];
    const files = sandboxClient.filesOf(id);
    expect(files.get("/workspace/notes/todo.md")?.content).toBe("buy milk");
    expect(files.get("/workspace/main.py")?.content).toBe("print('hi')");

    // The hydrate baseline (relative paths) is captured for the sync slice.
    expect([...executor.baseline]).toEqual(["main.py", "notes/todo.md"]);
  });

  it("a tool call reads a hydrated file back through the executor", async () => {
    const { executor } = makeExecutor({
      seed: [["config.json", '{"ok":true}']],
    });

    // readFile is workspace-relative; it resolves under /workspace inside the sandbox.
    const viaRead = await executor.readFile("config.json");
    expect(viaRead).toBe('{"ok":true}');

    // And an exec `cat` against the hydrated file streams the same bytes.
    const viaCat = await drainExec(executor.exec(["cat", "/workspace/config.json"]));
    expect(viaCat).toBe('{"ok":true}');
  });

  it("list returns workspace-relative paths for hydrated files", async () => {
    const { executor } = makeExecutor({
      seed: [
        ["src/a.ts", "a"],
        ["src/b.ts", "b"],
      ],
    });

    const entries = await executor.list();
    expect(entries.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("destroys the sandbox on dispose (session end)", async () => {
    const { executor, sandboxClient } = makeExecutor({ seed: [["f", "1"]] });

    await executor.readFile("f");
    const id = sandboxClient.created[0];
    expect(sandboxClient.liveCount).toBe(1);

    await executor.dispose();

    expect(sandboxClient.destroyed).toEqual([id]);
    expect(sandboxClient.liveCount).toBe(0);
  });

  it("dispose is a no-op when no sandbox was ever created (pure chat)", async () => {
    const { executor, sandboxClient } = makeExecutor();

    await executor.dispose();

    expect(sandboxClient.created).toHaveLength(0);
    expect(sandboxClient.destroyed).toHaveLength(0);
  });

  it("rejects paths that escape the workspace", async () => {
    const { executor } = makeExecutor();
    await expect(executor.readFile("../etc/passwd")).rejects.toThrow(
      /escapes workspace/,
    );
  });
});
