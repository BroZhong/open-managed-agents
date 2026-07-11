import { describe, it, expect } from "vitest";
import type {
  SkillArtifactStore,
  SkillFile,
} from "@oma-server/store";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import {
  FakeWorkspacePersistence,
  type HydrateTarget,
  type SandboxFsAccess,
} from "../src/workspace-persistence.js";
import {
  S3ProvisionSource,
  FakeProvisionSource,
  isInsideWorkspace,
  assertProjectionOutsideWorkspace,
  type ProvisionCoordinate,
  type ProvisionSource,
  type ProjectionTarget,
} from "../src/provision-source.js";

const TENANT = "tenant_1";
const WS = "ws_1";
const WORKSPACE_DIR = "/workspace";

/** SandboxFsAccess over a FakeSandboxClient sandbox (id bound), as the Manager builds it. */
function fsAccessFor(client: FakeSandboxClient, id: string): SandboxFsAccess {
  return {
    writeFile: (path, content) => client.writeFile(id, path, content),
    readFile: (path) => client.readFile(id, path),
    writeFileBytes: (path, content) => client.writeFileBytes(id, path, content),
    readFileBytes: (path) => client.readFileBytes(id, path),
    remove: (path) => client.remove(id, path),
    list: (dir) => client.list(id, dir),
  };
}

/** A ProjectionTarget over a live fake sandbox, at the given absolute targetPath. */
function projectionTargetFor(
  client: FakeSandboxClient,
  id: string,
  targetPath: string,
): ProjectionTarget {
  return {
    targetPath,
    fs: fsAccessFor(client, id),
    exec: (command, opts) => client.exec(id, command, opts),
  };
}

function hydrateTargetFor(fs: SandboxFsAccess): HydrateTarget {
  return { tenantId: TENANT, workspaceId: WS, workspaceDir: WORKSPACE_DIR, fs };
}

/**
 * A minimal in-memory {@link SkillArtifactStore} for the S3 adapter test, so the
 * test never touches real S3. Only `getAll`/`put` are meaningful for projection;
 * the rest satisfy the interface and throw if unexpectedly called.
 */
class FakeSkillArtifactStore implements SkillArtifactStore {
  private readonly files = new Map<string, Uint8Array>();
  private prefix(t: string, s: string): string {
    return `${t}/skills/${s}/`;
  }
  async put(t: string, s: string, path: string, body: Uint8Array | string): Promise<void> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.files.set(`${this.prefix(t, s)}${path}`, bytes);
  }
  async getAll(t: string, s: string): Promise<SkillFile[]> {
    const p = this.prefix(t, s);
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(p))
      .map(([k, body]) => ({ path: k.slice(p.length), body }));
  }
  async list(): Promise<string[]> {
    throw new Error("not needed");
  }
  async get(): Promise<Uint8Array | null> {
    throw new Error("not needed");
  }
  async delete(): Promise<void> {
    throw new Error("not needed");
  }
  async move(): Promise<void> {
    throw new Error("not needed");
  }
  async deleteTree(): Promise<void> {
    throw new Error("not needed");
  }
  async copyTree(): Promise<void> {
    throw new Error("not needed");
  }
}

describe("ProvisionSource seam", () => {
  it("S3ProvisionSource projects a Skill's S3 files into the sandbox at targetPath", async () => {
    const skills = new FakeSkillArtifactStore();
    await skills.put(TENANT, "skl_1", "SKILL.md", "# hello skill");
    await skills.put(TENANT, "skl_1", "scripts/run.sh", "echo run");

    const source = new S3ProvisionSource(skills);
    const client = new FakeSandboxClient();
    const { id } = await client.create();

    const coord: ProvisionCoordinate = {
      kind: "s3",
      ref: { tenantId: TENANT, skillId: "skl_1" },
    };
    await source.project(coord, projectionTargetFor(client, id, "/skills/skl_1"));

    const fs = fsAccessFor(client, id);
    expect(await fs.readFile("/skills/skl_1/SKILL.md")).toBe("# hello skill");
    expect(await fs.readFile("/skills/skl_1/scripts/run.sh")).toBe("echo run");
  });

  it("projects Skill binary assets without UTF-8 corruption", async () => {
    const skills = new FakeSkillArtifactStore();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await skills.put(TENANT, "skl_binary", "asset.png", bytes);
    const source = new S3ProvisionSource(skills);
    const client = new FakeSandboxClient();
    const { id } = await client.create();

    await source.project(
      {
        kind: "s3",
        ref: { tenantId: TENANT, skillId: "skl_binary" },
      },
      projectionTargetFor(client, id, "/skills/skl_binary"),
    );

    expect(await client.readFileBytes(id, "/skills/skl_binary/asset.png")).toEqual(
      bytes,
    );
  });

  it("dispatches by coordinate.kind to the registered adapter", async () => {
    // A Record<kind, ProvisionSource> map — exactly the future SandboxManager's
    // provisionSources shape. Two adapters under two kinds; the coordinate's kind
    // selects which one runs.
    const s3 = new FakeProvisionSource();
    const git = new FakeProvisionSource();
    s3.seed({ kind: "s3", ref: { skillId: "a" } }, { "f.txt": "from-s3" });
    git.seed({ kind: "git", ref: { repo: "r" } }, { "f.txt": "from-git" });
    const sources: Record<string, ProvisionSource> = { s3, git };

    const client = new FakeSandboxClient();
    const { id } = await client.create();

    const coord: ProvisionCoordinate = { kind: "git", ref: { repo: "r" } };
    await sources[coord.kind].project(
      coord,
      projectionTargetFor(client, id, "/repo"),
    );

    // Only the git adapter ran; the s3 adapter was untouched.
    expect(git.projected).toEqual([coord]);
    expect(s3.projected).toEqual([]);
    expect(await fsAccessFor(client, id).readFile("/repo/f.txt")).toBe("from-git");
  });

  it("projected content lands OUTSIDE the workspace dir", async () => {
    const source = new FakeProvisionSource();
    const coord: ProvisionCoordinate = { kind: "fake", ref: { id: "skl_1" } };
    source.seed(coord, { "SKILL.md": "body" });

    const client = new FakeSandboxClient();
    const { id } = await client.create();
    const target = projectionTargetFor(client, id, "/skills/skl_1");

    // The invariant holds for this target path.
    expect(isInsideWorkspace(target.targetPath, WORKSPACE_DIR)).toBe(false);
    await source.project(coord, target);

    const files = [...client.filesOf(id).keys()];
    expect(files).toContain("/skills/skl_1/SKILL.md");
    // Nothing landed inside /workspace.
    expect(files.every((f) => !f.startsWith("/workspace"))).toBe(true);
  });

  it("NEVER synced: a projection under /skills is not pushed or deleted by a workspace sync", async () => {
    // One sandbox holds both a hydrated Workspace (/workspace) and a Read-only
    // Projection (/skills/skl_1). This is the core guarantee: the Workspace sync's
    // full scan of /workspace never sees /skills, so projected files are neither
    // pushed to the Store nor deleted from it.
    const persistence = new FakeWorkspacePersistence();
    persistence.seed(TENANT, WS, "main.py", "print(1)");

    const client = new FakeSandboxClient();
    const { id } = await client.create();
    const fs = fsAccessFor(client, id);

    // Hydrate the Workspace, then project a Skill outside it.
    const session = await persistence.hydrate(hydrateTargetFor(fs));
    const source = new FakeProvisionSource();
    const coord: ProvisionCoordinate = { kind: "fake", ref: { id: "skl_1" } };
    source.seed(coord, { "SKILL.md": "skill body", "helper.py": "x = 1" });
    await source.project(coord, projectionTargetFor(client, id, "/skills/skl_1"));

    // A normal user edit inside the workspace, then sync.
    await client.writeFile(id, "/workspace/notes.txt", "hi");
    const result = await persistence.sync(session, hydrateTargetFor(fs));

    // Only the workspace file was pushed; NOTHING from /skills was pushed…
    expect(result.changed).toEqual(["notes.txt"]);
    expect(result.changed.some((p) => p.includes("SKILL") || p.includes("skl_1"))).toBe(false);
    // …and NOTHING from /skills was deleted.
    expect(result.deleted).toEqual([]);
    // The Store holds only workspace files — no projected paths leaked in.
    expect(persistence.pathsOf(TENANT, WS)).toEqual(["main.py", "notes.txt"]);
    // The projection is still intact in the sandbox, untouched by the sync.
    expect(await fs.readFile("/skills/skl_1/SKILL.md")).toBe("skill body");
  });

  it("fails loud when a projection targetPath is inside the workspace", async () => {
    expect(() =>
      assertProjectionOutsideWorkspace("/workspace/skills/x", WORKSPACE_DIR),
    ).toThrow(/inside the workspace/);
    // The workspace dir itself is inside (equal).
    expect(() => assertProjectionOutsideWorkspace("/workspace", WORKSPACE_DIR)).toThrow();
    expect(() => assertProjectionOutsideWorkspace("/workspace/", WORKSPACE_DIR)).toThrow();
    // Outside paths pass silently.
    expect(() => assertProjectionOutsideWorkspace("/skills/x", WORKSPACE_DIR)).not.toThrow();
    // A sibling that merely shares a prefix is NOT inside.
    expect(isInsideWorkspace("/workspaceX", WORKSPACE_DIR)).toBe(false);
    expect(() => assertProjectionOutsideWorkspace("/workspaceX", WORKSPACE_DIR)).not.toThrow();
  });

  it("S3ProvisionSource rejects a ref missing tenantId/skillId (fail loud)", async () => {
    const source = new S3ProvisionSource(new FakeSkillArtifactStore());
    const client = new FakeSandboxClient();
    const { id } = await client.create();
    await expect(
      source.project(
        { kind: "s3", ref: { skillId: "skl_1" } },
        projectionTargetFor(client, id, "/skills/skl_1"),
      ),
    ).rejects.toThrow(/tenantId, skillId/);
  });
});
