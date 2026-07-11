import { describe, it, expect } from "vitest";
import type { ToolExecutor } from "@open-managed-agents/adapter-core";
import { FakeSandboxClient } from "../src/fake-sandbox-client.js";
import {
  FakeWorkspacePersistence,
  type WorkspacePersistence,
} from "../src/workspace-persistence.js";
import { FakeProvisionSource } from "../src/provision-source.js";
import {
  DefaultSandboxManager,
  SandboxSessionClosed,
  type EnvSpec,
  type SandboxManager,
  type SandboxSession,
} from "../src/sandbox-manager.js";

const TENANT = "tenant_1";
const WS = "ws_1";

/**
 * A fully in-memory harness: FakeSandboxClient + FakeWorkspacePersistence +
 * FakeProvisionSource (registered under both "fake" and "s3" for dispatch
 * proof). No real S3/e2b. Returns the pieces so a test can seed the Workspace,
 * seed projections, reclaim a sandbox, and open sessions.
 */
function makeManager(opts?: {
  seed?: Array<[string, string]>;
  sandboxClient?: FakeSandboxClient;
}) {
  const sandboxClient = opts?.sandboxClient ?? new FakeSandboxClient();
  const persistence = new FakeWorkspacePersistence();
  for (const [path, content] of opts?.seed ?? []) {
    persistence.seed(TENANT, WS, path, content);
  }
  const provision = new FakeProvisionSource();
  const manager: SandboxManager = new DefaultSandboxManager({
    sandboxClient,
    persistence,
    provisionSources: { fake: provision, s3: provision },
  });
  return { manager, sandboxClient, persistence, provision };
}

function specFor(overrides: Partial<EnvSpec> = {}): EnvSpec {
  // Pin workspaceDir explicitly so these assertions (which hard-code
  // `/workspace/…` paths) are independent of the production default, which is
  // `/home/user` (issue #85). Override per-test as needed.
  return { tenantId: TENANT, workspaceId: WS, workspaceDir: "/workspace", ...overrides };
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

describe("SandboxManager / SandboxSession", () => {
  // ─── invariant §1: open is cheap; lazy create ──────────────────────────────

  it("open starts NO sandbox — a pure-chat turn spins up nothing", () => {
    const { manager, sandboxClient } = makeManager();
    const session = manager.open(specFor());
    expect(session).toBeDefined();
    expect(sandboxClient.created).toHaveLength(0);
    expect(sandboxClient.liveCount).toBe(0);
  });

  it("the first primitive triggers exactly one create + hydrate", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["main.py", "hi"]] });
    const session = manager.open(specFor());

    expect(await session.readFile("main.py")).toBe("hi");
    expect(sandboxClient.created).toHaveLength(1);

    // A second primitive reuses the same sandbox — no second create.
    await session.list();
    expect(sandboxClient.created).toHaveLength(1);
  });

  it("does not create a second sandbox under concurrent first primitives", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["x.txt", "X"]] });
    const session = manager.open(specFor());

    await Promise.all([
      session.readFile("x.txt"),
      session.list(),
      drainExec(session.exec(["echo", "hi"])),
    ]);

    expect(sandboxClient.created).toHaveLength(1);
  });

  it("hydrates the sandbox workspace and projects skills on first primitive", async () => {
    const { manager, sandboxClient, provision } = makeManager({
      seed: [["notes/todo.md", "buy milk"]],
    });
    const coord = { kind: "s3", ref: { tenantId: TENANT, skillId: "skl_1" } };
    provision.seed(coord, { "SKILL.md": "# skill body" });

    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/skl_1", source: coord }] }),
    );
    await session.list();

    const id = sandboxClient.created[0];
    // Workspace hydrated under /workspace ...
    expect(await sandboxClient.readFile(id, "/workspace/notes/todo.md")).toBe("buy milk");
    // ... and the skill projected OUTSIDE the workspace at /skills.
    expect(await sandboxClient.readFile(id, "/skills/skl_1/SKILL.md")).toBe("# skill body");
    expect(provision.projected).toHaveLength(1);
  });

  it("reads a projected Skill through the session primitives (absolute path is NOT re-based under workspace)", async () => {
    // Regression: the Pi adapter's tools run with cwd=/workspace and hand the
    // executor a Pi-resolved ABSOLUTE path — a workspace file as `/workspace/x`
    // and a projected Skill as `/skills/<id>/SKILL.md`. If readFile/list re-base
    // every path under workspaceDir, a projected Skill read becomes
    // `/workspace/skills/…` and is unreadable (the invisible-Skill bug found in
    // the HK E2E). Absolute paths must pass through untouched.
    const { manager, provision } = makeManager({
      seed: [["main.py", "print('hi')"]],
    });
    const coord = { kind: "s3", ref: { tenantId: TENANT, skillId: "skl_1" } };
    provision.seed(coord, { "SKILL.md": "# skill body" });

    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/skl_1", source: coord }] }),
    );

    // The projected Skill is readable at its real absolute path.
    expect(await session.readFile("/skills/skl_1/SKILL.md")).toBe("# skill body");
    // Listing the projection root (outside the workspace) surfaces its files.
    const skillEntries = await session.list("/skills/skl_1");
    expect(skillEntries.map((e) => e.path)).toContain("/skills/skl_1/SKILL.md");

    // A workspace file still resolves under workspaceDir via BOTH forms.
    expect(await session.readFile("main.py")).toBe("print('hi')");
    expect(await session.readFile("/workspace/main.py")).toBe("print('hi')");
  });

  // ─── invariant §2: two opens → two independent sessions ───────────────────

  it("two opens yield two independent sessions (binding in object identity)", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["a", "1"]] });
    const a = manager.open(specFor());
    const b = manager.open(specFor());

    expect(a).not.toBe(b);

    await a.readFile("a");
    // Only a's primitive created a sandbox; b is still cold.
    expect(sandboxClient.created).toHaveLength(1);

    await b.readFile("a");
    expect(sandboxClient.created).toHaveLength(2);
    expect(sandboxClient.created[0]).not.toBe(sandboxClient.created[1]);
  });

  // ─── invariant §3/§7: transparent self-heal; re-hydrate AND re-project ────

  it("self-heals a reclaimed sandbox: rebuild + re-hydrate + re-project, no caller error", async () => {
    const { manager, sandboxClient, provision } = makeManager({
      seed: [["main.py", "print('hi')"]],
    });
    const coord = { kind: "s3", ref: { tenantId: TENANT, skillId: "skl_1" } };
    provision.seed(coord, { "SKILL.md": "body" });

    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/skl_1", source: coord }] }),
    );

    // Turn 1: create + hydrate + project sandbox #1.
    expect(await session.readFile("main.py")).toBe("print('hi')");
    const first = sandboxClient.created[0];
    expect(provision.projected).toHaveLength(1);

    // The gateway reclaims it between turns.
    sandboxClient.reclaim(first);
    expect(await sandboxClient.isAlive(first)).toBe(false);

    // Turn 2: the next primitive must NOT throw. It rebuilds, re-hydrates, and
    // — critically — RE-PROJECTS (a rebuilt sandbox without /skills is broken).
    expect(await session.readFile("main.py")).toBe("print('hi')");
    const second = sandboxClient.created[1];
    expect(second).not.toBe(first);
    // Re-hydrated: workspace file present in the fresh sandbox.
    expect(await sandboxClient.readFile(second, "/workspace/main.py")).toBe(
      "print('hi')",
    );
    // Re-projected: /skills present in the fresh sandbox, and project ran twice.
    expect(sandboxClient.filesOf(second).get("/skills/skl_1/SKILL.md")?.content).toBe(
      "body",
    );
    expect(provision.projected).toHaveLength(2);
    // The dead sandbox was best-effort destroyed.
    expect(sandboxClient.destroyed).toContain(first);
  });

  it("passes a generous explicit lifetime and tenant/workspace metadata on create", async () => {
    const { manager, sandboxClient } = makeManager();
    const session = manager.open(specFor());
    await session.writeFile("a.txt", "hi");

    const id = sandboxClient.created[0];
    const created = sandboxClient.createOptsOf(id);
    expect(created.timeoutSeconds).toBeGreaterThanOrEqual(60 * 60);
    expect(created.metadata?.["oma.dev/tenant"]).toBe(TENANT);
    expect(created.metadata?.["oma.dev/workspace"]).toBe(WS);
  });

  it("honors EnvSpec image/env and a workspaceDir default override", async () => {
    const sandboxClient = new FakeSandboxClient();
    const manager = new DefaultSandboxManager({
      sandboxClient,
      persistence: new FakeWorkspacePersistence(),
      provisionSources: {},
      defaults: { lifetimeSeconds: 123 },
    });
    const session = manager.open(
      specFor({ image: "custom:img", env: { FOO: "bar" } }),
    );
    await session.writeFile("a.txt", "hi");

    const opts = sandboxClient.createOptsOf(sandboxClient.created[0]);
    expect(opts.image).toBe("custom:img");
    expect(opts.env).toEqual({ FOO: "bar" });
    expect(opts.timeoutSeconds).toBe(123);
  });

  it("fails loud if no ProvisionSource is registered for a projection kind", async () => {
    const sandboxClient = new FakeSandboxClient();
    const manager = new DefaultSandboxManager({
      sandboxClient,
      persistence: new FakeWorkspacePersistence(),
      provisionSources: {}, // no "git" adapter
    });
    const session = manager.open(
      specFor({
        projections: [{ targetPath: "/repo", source: { kind: "git", ref: {} } }],
      }),
    );
    await expect(session.readFile("x")).rejects.toThrow(
      /No ProvisionSource registered for kind "git"/,
    );
  });

  // ─── invariant §4: checkpoint delta + empty no-op ──────────────────────────

  it("checkpoint returns the delta of files changed this turn", async () => {
    const { manager, persistence } = makeManager({ seed: [["a.txt", "A"]] });
    const session = manager.open(specFor());

    await session.writeFile("b.txt", "B");
    const result = await session.checkpoint();

    expect(result.changed).toContain("b.txt");
    expect(result.deleted).toEqual([]);
    expect(persistence.contentOf(TENANT, WS, "b.txt")).toBe("B");
  });

  it("checkpoint on a never-created (pure-chat) session → EMPTY, no throw, no create", async () => {
    const { manager, sandboxClient } = makeManager();
    const session = manager.open(specFor());

    const result = await session.checkpoint();
    expect(result).toEqual({
      tenantId: TENANT,
      workspaceId: WS,
      changed: [],
      deleted: [],
    });
    // Did NOT create a sandbox just to sync.
    expect(sandboxClient.created).toHaveLength(0);
  });

  it("checkpoint on a reclaimed sandbox → EMPTY, no throw", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["f", "1"]] });
    const session = manager.open(specFor());

    await session.readFile("f"); // create + hydrate
    const id = sandboxClient.created[0];
    sandboxClient.reclaim(id);

    const result = await session.checkpoint();
    expect(result.changed).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  // ─── turn-boundary downward refresh ─────────────────────────────

  it("refresh on a cold session is a no-op and never creates a sandbox", async () => {
    const { manager, sandboxClient } = makeManager();
    const session = manager.open(specFor());

    await session.refresh();

    expect(sandboxClient.created).toEqual([]);
    expect(sandboxClient.destroyed).toEqual([]);
  });

  it("refresh reconciles Workspace and reprojects Skills in the same live sandbox", async () => {
    const { manager, sandboxClient, persistence, provision } = makeManager({
      seed: [
        ["edit.txt", "before"],
        ["deleted.txt", "remove me"],
      ],
    });
    const coord = { kind: "s3", ref: { tenantId: TENANT, skillId: "skl_1" } };
    provision.seed(coord, {
      "SKILL.md": "old skill",
      "obsolete.md": "remove me",
    });
    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/skl_1", source: coord }] }),
    );
    expect(await session.readFile("edit.txt")).toBe("before");
    const id = sandboxClient.created[0];

    // Simulate idle-time Host edits to both authoritative domains.
    persistence.seed(TENANT, WS, "edit.txt", "from web");
    persistence.seed(TENANT, WS, "added.txt", "new from web");
    persistence.delete(TENANT, WS, "deleted.txt");
    provision.seed(coord, { "SKILL.md": "new skill" });

    await session.refresh();

    expect(sandboxClient.created).toEqual([id]);
    expect(sandboxClient.destroyed).toEqual([]);
    expect(await sandboxClient.readFile(id, "/workspace/edit.txt")).toBe("from web");
    expect(await sandboxClient.readFile(id, "/workspace/added.txt")).toBe("new from web");
    await expect(
      sandboxClient.readFile(id, "/workspace/deleted.txt"),
    ).rejects.toThrow();
    expect(await sandboxClient.readFile(id, "/skills/skl_1/SKILL.md")).toBe(
      "new skill",
    );
    await expect(
      sandboxClient.readFile(id, "/skills/skl_1/obsolete.md"),
    ).rejects.toThrow();
    expect(provision.projected).toHaveLength(2);
  });

  it("refresh replaces the equipped projection set without rebuilding", async () => {
    const { manager, sandboxClient, provision } = makeManager();
    const oldCoord = { kind: "s3", ref: { skillId: "old" } };
    const newCoord = { kind: "s3", ref: { skillId: "new" } };
    provision.seed(oldCoord, { "SKILL.md": "old" });
    provision.seed(newCoord, { "SKILL.md": "new" });
    const session = manager.open(
      specFor({ projections: [{ targetPath: "/skills/old", source: oldCoord }] }),
    );
    expect(await session.readFile("/skills/old/SKILL.md")).toBe("old");
    const id = sandboxClient.created[0];

    await session.refresh([
      { targetPath: "/skills/new", source: newCoord },
    ]);

    expect(sandboxClient.created).toEqual([id]);
    expect(sandboxClient.destroyed).toEqual([]);
    await expect(session.readFile("/skills/old/SKILL.md")).rejects.toThrow();
    expect(await session.readFile("/skills/new/SKILL.md")).toBe("new");
  });

  it("retries a failed checkpoint before downward refresh preserves sandbox-only bytes", async () => {
    const sandboxClient = new FakeSandboxClient();
    const backing = new FakeWorkspacePersistence();
    let failNextSync = true;
    const persistence: WorkspacePersistence = {
      hydrate: (target) => backing.hydrate(target),
      refresh: (hydration, target) => backing.refresh(hydration, target),
      async sync(hydration, target) {
        if (failNextSync) {
          failNextSync = false;
          throw new Error("temporary medium failure");
        }
        return backing.sync(hydration, target);
      },
    };
    const manager = new DefaultSandboxManager({
      sandboxClient,
      persistence,
      provisionSources: {},
    });
    const session = manager.open(specFor());
    await session.list();
    const id = sandboxClient.created[0];
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff,
    ]);
    await sandboxClient.writeFileBytes(id, "/workspace/result.png", png);

    await expect(session.checkpoint()).rejects.toThrow("temporary medium failure");
    expect(backing.bytesOf(TENANT, WS, "result.png")).toBeUndefined();

    await session.refresh();

    expect(backing.bytesOf(TENANT, WS, "result.png")).toEqual(png);
    expect(await sandboxClient.readFileBytes(id, "/workspace/result.png")).toEqual(png);
  });

  // ─── invariant §5/§8: dispose sync-before-destroy, idempotent, closes ─────

  it("dispose syncs the last turn's files BEFORE destroying the sandbox", async () => {
    const { manager, sandboxClient, persistence } = makeManager({
      seed: [["a.txt", "A"]],
    });
    const session = manager.open(specFor());

    await session.writeFile("late.txt", "written in the last turn");
    const id = sandboxClient.created[0];

    const result = await session.dispose();

    // The last turn's file was synced back (pre-sync is load-bearing) ...
    expect(result.changed).toContain("late.txt");
    expect(persistence.contentOf(TENANT, WS, "late.txt")).toBe(
      "written in the last turn",
    );
    // ... and only then was the sandbox destroyed.
    expect(sandboxClient.destroyed).toEqual([id]);
    expect(sandboxClient.liveCount).toBe(0);
  });

  it("dispose on a pure-chat session (never created) → empty no-op", async () => {
    const { manager, sandboxClient } = makeManager();
    const session = manager.open(specFor());

    const result = await session.dispose();
    expect(result).toEqual({
      tenantId: TENANT,
      workspaceId: WS,
      changed: [],
      deleted: [],
    });
    expect(sandboxClient.created).toHaveLength(0);
    expect(sandboxClient.destroyed).toHaveLength(0);
  });

  it("dispose is idempotent — a second dispose is an empty no-op", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["f", "1"]] });
    const session = manager.open(specFor());

    await session.readFile("f");
    const first = await session.dispose();
    expect(first.changed.length + first.deleted.length).toBeGreaterThanOrEqual(0);

    const second = await session.dispose();
    expect(second).toEqual({
      tenantId: TENANT,
      workspaceId: WS,
      changed: [],
      deleted: [],
    });
    // Destroyed exactly once.
    expect(sandboxClient.destroyed).toHaveLength(1);
  });

  it("after dispose, any primitive throws SandboxSessionClosed (no resurrection)", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["f", "1"]] });
    const session = manager.open(specFor());

    await session.readFile("f");
    await session.dispose();

    await expect(session.readFile("f")).rejects.toBeInstanceOf(
      SandboxSessionClosed,
    );
    await expect(session.writeFile("f", "x")).rejects.toBeInstanceOf(
      SandboxSessionClosed,
    );
    await expect(session.list()).rejects.toBeInstanceOf(SandboxSessionClosed);
    await expect(drainExec(session.exec(["echo", "hi"]))).rejects.toBeInstanceOf(
      SandboxSessionClosed,
    );
    // No new sandbox was created by the rejected primitives.
    expect(sandboxClient.created).toHaveLength(1);
  });

  // ─── invariant §6: projection inside workspace fails loud at open ─────────

  it("open FAILS LOUD when a projection.targetPath is inside workspaceDir", () => {
    const { manager } = makeManager();
    expect(() =>
      manager.open(
        specFor({
          workspaceDir: "/workspace",
          projections: [
            {
              targetPath: "/workspace/skills",
              source: { kind: "s3", ref: {} },
            },
          ],
        }),
      ),
    ).toThrow(/inside the workspace/);
  });

  it("open fails loud at open time — before any sandbox is created", () => {
    const { manager, sandboxClient } = makeManager();
    expect(() =>
      manager.open(
        specFor({
          projections: [
            { targetPath: "/workspace/x", source: { kind: "s3", ref: {} } },
          ],
        }),
      ),
    ).toThrow();
    expect(sandboxClient.created).toHaveLength(0);
  });

  // ─── path handling ─────────────────────────────────────────────────────────

  it("does NOT guard against `..` — the sandbox is the trust boundary, not this path rewrite", async () => {
    // Sandbox-as-tool convention (E2B / opensandbox / Anthropic code exec): the
    // disposable sandbox is the isolation boundary, so paths are taken at face
    // value. A `..` is passed through to the sandbox (which resolves it against
    // the same throwaway container) — it is NOT rejected at this layer with an
    // "escapes workspace" error. Here it simply hits a non-existent file, and
    // the error that surfaces is the sandbox's own not-found, not a path guard.
    const { manager } = makeManager();
    const session = manager.open(specFor());
    await expect(session.readFile("../etc/passwd")).rejects.not.toThrow(
      /escapes workspace/,
    );
  });

  it("list returns workspace-relative paths and supports a glob filter", async () => {
    const { manager } = makeManager({
      seed: [
        ["src/a.ts", "a"],
        ["src/b.ts", "b"],
        ["README.md", "r"],
      ],
    });
    const session = manager.open(specFor());

    const all = await session.list();
    expect(all.map((e) => e.path).sort()).toEqual([
      "README.md",
      "src/a.ts",
      "src/b.ts",
    ]);

    const ts = await session.list("**/*.ts");
    expect(ts.map((e) => e.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  // ─── §3 structural: SandboxSession IS a ToolExecutor ──────────────────────

  it("a SandboxSession is structurally a ToolExecutor", () => {
    const { manager } = makeManager();
    const session = manager.open(specFor());
    // Compiles only if the primitive signatures match exactly.
    const asExecutor: ToolExecutor = session satisfies ToolExecutor;
    expect(asExecutor).toBe(session);
  });

  // ─── reserved list/reclaim (no active sweep today) ────────────────────────

  it("list is a reserved no-op returning [] (no cross-session registry)", async () => {
    const { manager } = makeManager();
    expect(await manager.list()).toEqual([]);
    expect(await manager.list({ tenantId: TENANT })).toEqual([]);
  });

  it("reclaim best-effort destroys a known sandbox id", async () => {
    const { manager, sandboxClient } = makeManager({ seed: [["f", "1"]] });
    const session = manager.open(specFor());
    await session.readFile("f");
    const id = sandboxClient.created[0];

    await manager.reclaim(id);
    expect(sandboxClient.destroyed).toContain(id);
    // Idempotent: reclaiming an unknown id is harmless.
    await expect(manager.reclaim("sbx-unknown")).resolves.toBeUndefined();
  });
});
