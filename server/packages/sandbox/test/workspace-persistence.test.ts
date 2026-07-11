import { describe, it, expect } from "vitest";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import {
  FakeWorkspacePersistence,
  S3WorkspacePersistence,
  type HydrateTarget,
  type SandboxFsAccess,
} from "../src/workspace-persistence.js";
import type { ArtifactPutInput, ArtifactStore } from "@oma-server/store";

const TENANT = "tenant_1";
const WS = "ws_1";
const WORKSPACE_DIR = "/workspace";

/**
 * Build a {@link SandboxFsAccess} over a {@link FakeSandboxClient} sandbox,
 * exactly as the executor/Manager does: the three ops with the sandbox id bound.
 * Optionally wraps `readFile`/`list` with a counting spy so a test can assert
 * the size+mtime pre-filter skipped a read.
 */
function fsAccessFor(
  client: FakeSandboxClient,
  id: string,
  spy?: { reads: string[] },
): SandboxFsAccess {
  return {
    writeFile: (path, content) => client.writeFile(id, path, content),
    writeFileBytes: (path, content) => client.writeFileBytes(id, path, content),
    readFile: (path) => {
      spy?.reads.push(path);
      return client.readFile(id, path);
    },
    readFileBytes: (path) => {
      spy?.reads.push(path);
      return client.readFileBytes(id, path);
    },
    remove: (path) => client.remove(id, path),
    list: (dir) => client.list(id, dir),
  };
}

async function makeSandbox(): Promise<{
  client: FakeSandboxClient;
  id: string;
}> {
  const client = new FakeSandboxClient();
  const { id } = await client.create();
  return { client, id };
}

function targetFor(fs: SandboxFsAccess, workspaceId = WS): HydrateTarget {
  return { tenantId: TENANT, workspaceId, workspaceDir: WORKSPACE_DIR, fs };
}

describe("FakeWorkspacePersistence (WorkspacePersistence seam)", () => {
  it("hydrate writes the persisted workspace into the sandbox and it reads back", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "notes/todo.md", "buy milk");
    persistence.seed(TENANT, WS, "main.py", "print('hi')");

    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);

    await persistence.hydrate(targetFor(fs));

    // The files landed under the sandbox workspace dir…
    expect(await fs.readFile("/workspace/notes/todo.md")).toBe("buy milk");
    expect(await fs.readFile("/workspace/main.py")).toBe("print('hi')");
  });

  it("sync pushes only changed/new files; an untouched file is not re-stored", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "keep.txt", "unchanged");
    persistence.seed(TENANT, WS, "edit.txt", "aaaa");

    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs));

    // Same-size edit (aaaa -> bbbb) a size-only comparison would miss, plus a
    // brand-new file. keep.txt is left untouched.
    await client.writeFile(id, "/workspace/edit.txt", "bbbb");
    await client.writeFile(id, "/workspace/new.txt", "hello");

    const result = await persistence.sync(session, targetFor(fs));

    expect(result.changed.sort()).toEqual(["edit.txt", "new.txt"]);
    expect(result.deleted).toEqual([]);
    expect(persistence.contentOf(TENANT, WS, "edit.txt")).toBe("bbbb");
    expect(persistence.contentOf(TENANT, WS, "new.txt")).toBe("hello");
    expect(persistence.contentOf(TENANT, WS, "keep.txt")).toBe("unchanged");
  });

  it("baseline-diff deletes only vanished baseline paths", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "gone.txt", "bye");
    persistence.seed(TENANT, WS, "stay.txt", "here");

    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs)); // baseline: gone, stay

    // Simulate `rm /workspace/gone.txt`.
    client.filesOf(id).delete("/workspace/gone.txt");

    const result = await persistence.sync(session, targetFor(fs));

    expect(result.deleted).toEqual(["gone.txt"]);
    expect(persistence.contentOf(TENANT, WS, "gone.txt")).toBeUndefined();
    expect(persistence.contentOf(TENANT, WS, "stay.txt")).toBe("here");
  });

  it("a concurrent session's new file (not in this baseline) is NEVER deleted", async () => {
    // Shared store, two sessions (two sandboxes) on the same Workspace.
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "shared.txt", "orig");

    const client = new FakeSandboxClient();
    const { id: idA } = await client.create();
    const { id: idB } = await client.create();
    const fsA = fsAccessFor(client, idA);
    const fsB = fsAccessFor(client, idB);

    // Both hydrate from the same baseline: only "shared.txt".
    const sessionA = await persistence.hydrate(targetFor(fsA));
    const sessionB = await persistence.hydrate(targetFor(fsB));

    // Session B creates a brand-new file and syncs it back.
    await client.writeFile(idB, "/workspace/b-only.txt", "from-B");
    await persistence.sync(sessionB, targetFor(fsB));
    expect(persistence.contentOf(TENANT, WS, "b-only.txt")).toBe("from-B");

    // Session A syncs. b-only.txt is not in A's baseline and A's sandbox does
    // not have it → A must not delete it.
    const resultA = await persistence.sync(sessionA, targetFor(fsA));
    expect(resultA.deleted).toEqual([]);
    expect(persistence.contentOf(TENANT, WS, "b-only.txt")).toBe("from-B");
  });

  it("size+mtime pre-filter skips reading an untouched file on the next sync", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "untouched.txt", "same");
    persistence.seed(TENANT, WS, "touched.txt", "before");

    const { client, id } = await makeSandbox();
    const spy = { reads: [] as string[] };
    const fs = fsAccessFor(client, id, spy);
    const session = await persistence.hydrate(targetFor(fs));

    // Edit only touched.txt. Its mtime changes (FakeSandboxClient stamps
    // Date.now() on write); untouched.txt keeps its hydrate size+mtime.
    await new Promise((r) => setTimeout(r, 2)); // ensure a distinct mtime.
    await client.writeFile(id, "/workspace/touched.txt", "after");

    spy.reads.length = 0; // only count reads during sync.
    const result = await persistence.sync(session, targetFor(fs));

    expect(result.changed).toEqual(["touched.txt"]);
    // The pre-filter skipped untouched.txt entirely: it was never read/hashed.
    expect(spy.reads).toEqual(["/workspace/touched.txt"]);
    expect(spy.reads).not.toContain("/workspace/untouched.txt");
  });

  it("does not re-push an unchanged file on a second sync (pre-filter holds)", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "a.txt", "A");

    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs));

    await client.writeFile(id, "/workspace/b.txt", "B");
    const first = await persistence.sync(session, targetFor(fs));
    expect(first.changed).toEqual(["b.txt"]);

    const second = await persistence.sync(session, targetFor(fs));
    expect(second.changed).toEqual([]);
    expect(second.deleted).toEqual([]);
  });

  it("refresh reconciles the live sandbox downward from authoritative storage", async () => {
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "edit.txt", "before");
    persistence.seed(TENANT, WS, "deleted.txt", "remove me");

    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs));
    await client.writeFile(id, "/workspace/local-only.txt", "stale sandbox state");

    // Simulate idle-time Workspace edits made through the Host/S3 APIs.
    persistence.seed(TENANT, WS, "edit.txt", "from web");
    persistence.seed(TENANT, WS, "added.txt", "new from web");
    persistence.delete(TENANT, WS, "deleted.txt");

    await persistence.refresh(session, targetFor(fs));

    expect(await client.readFile(id, "/workspace/edit.txt")).toBe("from web");
    expect(await client.readFile(id, "/workspace/added.txt")).toBe("new from web");
    await expect(client.readFile(id, "/workspace/deleted.txt")).rejects.toThrow();
    await expect(client.readFile(id, "/workspace/local-only.txt")).rejects.toThrow();

    // Refresh also advances the baseline: deleting the web-added file in the
    // next turn must delete it from authoritative storage on sync.
    client.filesOf(id).delete("/workspace/added.txt");
    const result = await persistence.sync(session, targetFor(fs));
    expect(result.deleted).toEqual(["added.txt"]);
    expect(persistence.contentOf(TENANT, WS, "added.txt")).toBeUndefined();
  });

  it("sync advances its baseline so a newly-created file can be deleted next turn", async () => {
    const persistence = new FakeWorkspacePersistence();
    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs));

    await client.writeFile(id, "/workspace/transient.txt", "turn one");
    expect((await persistence.sync(session, targetFor(fs))).changed).toEqual([
      "transient.txt",
    ]);

    client.filesOf(id).delete("/workspace/transient.txt");
    const second = await persistence.sync(session, targetFor(fs));
    expect(second.deleted).toEqual(["transient.txt"]);
    expect(persistence.contentOf(TENANT, WS, "transient.txt")).toBeUndefined();
  });
});

describe("S3WorkspacePersistence binary safety", () => {
  it("hydrates invalid UTF-8 bytes into the sandbox unchanged", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);
    const store: ArtifactStore = {
      list: async () => [{ path: "image.png", size: png.byteLength }],
      get: async () => ({
        path: "image.png",
        body: png,
        contentType: "image/png",
      }),
      exists: async () => true,
      put: async () => {
        throw new Error("not expected");
      },
      delete: async () => false,
    };
    const persistence = new S3WorkspacePersistence(store);
    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);

    await persistence.hydrate(targetFor(fs));

    expect(await client.readFileBytes(id, "/workspace/image.png")).toEqual(png);
  });

  it("syncs PNG bytes without UTF-8 replacement-character corruption", async () => {
    const puts: ArtifactPutInput[] = [];
    const store: ArtifactStore = {
      list: async () => [],
      get: async () => null,
      exists: async () => false,
      put: async (input) => {
        puts.push(input);
        const size =
          typeof input.body === "string"
            ? Buffer.byteLength(input.body)
            : input.body.byteLength;
        return { path: input.path, size };
      },
      delete: async () => false,
    };
    const persistence = new S3WorkspacePersistence(store);
    const { client, id } = await makeSandbox();
    const fs = fsAccessFor(client, id);
    const session = await persistence.hydrate(targetFor(fs));
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);

    await client.writeFileBytes(id, "/workspace/image.png", png);
    await persistence.sync(session, targetFor(fs));

    expect(puts).toHaveLength(1);
    expect(puts[0].body).toEqual(png);
    expect(puts[0].contentType).toBe("image/png");
  });
});
