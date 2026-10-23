import { describe, expect, it } from "vitest";
import { SupabaseObjectMissingError, SupabaseSkillReader } from "../src/skill-bundle-migration/supabase-reader.js";
import { fakeSupabaseStorage, text } from "./fixtures/skill-bundle-migration.js";

const SERVICE_KEY = "service-role-jwt-never-printed";
const options = (storage: ReturnType<typeof fakeSupabaseStorage>, extra: Partial<ConstructorParameters<typeof SupabaseSkillReader>[0]> = {}) => ({
  endpoint: "http://storage.internal:80/storage/v1/", serviceKey: SERVICE_KEY, bucket: "workspace-test",
  fetch: storage.fetch, sleep: async () => {}, ...extra,
});

describe("SupabaseSkillReader", () => {
  it("lists a Skill's files recursively across folders and pages, relative to the Skill", async () => {
    const storage = fakeSupabaseStorage();
    for (const path of ["SKILL.md", "a.txt", "b.txt", "scripts/run.py", "scripts/__pycache__/run.cpython-312.pyc", "assets/fonts/x.ttf"]) {
      storage.put(`tenant-1/skills/skill_A/${path}`, text(path));
    }
    storage.put("tenant-1/skills/skill_AB/SKILL.md", text("other Skill"));
    storage.put("tenant-2/skills/skill_A/SKILL.md", text("other tenant"));
    const reader = new SupabaseSkillReader(options(storage, { listPageSize: 2 }));
    expect(await reader.list("tenant-1", "skill_A")).toEqual([
      "SKILL.md", "a.txt", "assets/fonts/x.ttf", "b.txt", "scripts/__pycache__/run.cpython-312.pyc", "scripts/run.py",
    ]);
    expect(storage.requests.every((request) => request.authorization === `Bearer ${SERVICE_KEY}`)).toBe(true);
    expect(storage.requests.filter((request) => request.kind === "list").map((request) => request.bucket)).toEqual(
      expect.arrayContaining(["workspace-test"]),
    );
  });

  it("reads bytes exactly, through the bucket's object URL with each key segment encoded", async () => {
    const storage = fakeSupabaseStorage();
    const binary = new Uint8Array([0, 1, 0, 0, 0xff, 0xfe, 0x80]);
    storage.put("tenant-1/skills/skill_A/assets/a b#.bin", binary);
    const reader = new SupabaseSkillReader(options(storage));
    expect(await reader.read("tenant-1", "skill_A", "assets/a b#.bin")).toEqual(binary);
    expect(storage.requests.at(-1)?.url).toBe("http://storage.internal:80/storage/v1/object/workspace-test/tenant-1/skills/skill_A/assets/a%20b%23.bin");
  });

  it("fails a listed object that vanished, in both 404 shapes Supabase uses", async () => {
    const storage = fakeSupabaseStorage();
    const reader = new SupabaseSkillReader(options(storage));
    await expect(reader.read("tenant-1", "skill_A", "gone.md")).rejects.toBeInstanceOf(SupabaseObjectMissingError);
    storage.failNext(() => ({ status: 404, body: "" }));
    await expect(reader.read("tenant-1", "skill_A", "gone.md")).rejects.toBeInstanceOf(SupabaseObjectMissingError);
  });

  it("retries HTTP 544, other 5xx and network errors with backoff and counts the retries", async () => {
    const storage = fakeSupabaseStorage();
    storage.put("t/skills/s/SKILL.md", text("ok"));
    const delays: number[] = [];
    storage.failNext(() => ({ status: 544, body: JSON.stringify({ statusCode: "544", error: "DatabaseTimeout", message: "timeout" }) }));
    storage.failNext(() => ({ status: 503, body: "upstream" }));
    storage.failNext(() => { throw new TypeError("fetch failed"); });
    const reader = new SupabaseSkillReader(options(storage, { sleep: async (ms) => { delays.push(ms); }, backoffMs: 100 }));
    expect(await reader.read("t", "s", "SKILL.md")).toEqual(text("ok"));
    expect(reader.stats).toEqual({ requests: 4, retries: 3, retriesByCause: { "544": 1, "503": 1, network: 1 } });
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
  });

  it("gives up after the attempt budget with the status and Supabase's error code, never the credential or URL", async () => {
    const storage = fakeSupabaseStorage();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      storage.failNext(() => ({ status: 544, body: JSON.stringify({ statusCode: "544", error: "DatabaseTimeout", message: `token ${SERVICE_KEY}` }) }));
    }
    const reader = new SupabaseSkillReader(options(storage, { maxAttempts: 3 }));
    const error = await reader.list("t", "s").then(() => null, (cause: Error) => cause);
    expect(error?.message).toMatch(/list failed after 3 attempts: HTTP 544 DatabaseTimeout/);
    expect(error?.message).not.toContain(SERVICE_KEY);
    expect(error?.message).not.toContain("storage.internal");
    expect(reader.stats.retries).toBe(2);
  });

  it("does not retry a client error", async () => {
    const storage = fakeSupabaseStorage();
    storage.failNext(() => ({ status: 403, body: JSON.stringify({ error: "Unauthorized" }) }));
    const reader = new SupabaseSkillReader(options(storage));
    await expect(reader.read("t", "s", "SKILL.md")).rejects.toThrow(/read failed: HTTP 403 Unauthorized/);
    expect(reader.stats.requests).toBe(1);
  });

  it("bounds the requests in flight", async () => {
    const storage = fakeSupabaseStorage({ latencyMs: 5 });
    for (let index = 0; index < 20; index += 1) storage.put(`t/skills/s/f${index}.md`, text(String(index)));
    const reader = new SupabaseSkillReader(options(storage, { concurrency: 3 }));
    await Promise.all(Array.from({ length: 20 }, (_, index) => reader.read("t", "s", `f${index}.md`)));
    expect(storage.maxInFlight()).toBe(3);
  });

  it("requires an endpoint, a service key and a bucket", () => {
    const storage = fakeSupabaseStorage();
    expect(() => new SupabaseSkillReader({ ...options(storage), serviceKey: "" })).toThrow(/service key/);
    expect(() => new SupabaseSkillReader({ ...options(storage), endpoint: "" })).toThrow(/endpoint/);
    expect(() => new SupabaseSkillReader({ ...options(storage), bucket: "" })).toThrow(/bucket/);
  });
});
