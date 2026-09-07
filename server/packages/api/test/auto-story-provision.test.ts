import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import {
  InMemoryAgentStore,
  InMemorySkillArtifactStore,
  InMemorySkillStore,
} from "@oma-server/store-memory";
import { provision } from "../../../../deploy/auto-story/provision.mjs";

const temporaryDirectories: string[] = [];
const sharedName = "byted-mediakit-shared";
const videoName = "byted-mediakit-video";
const sharedMd = `---\nname: ${sharedName}\ndescription: Shared contract\n---\nRead [query](reference/query_task.md).\n`;
const videoMd = `---\nname: ${videoName}\ndescription: Video processing\n---\nRead \`../${sharedName}/SKILL.md\` first, then [probe](reference/probe-video.md).\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "auto-story-provision-"));
  temporaryDirectories.push(root);
  const shared = join(root, sharedName);
  const video = join(root, videoName);
  await mkdir(join(shared, "reference"), { recursive: true });
  await mkdir(join(video, "reference"), { recursive: true });
  await writeFile(join(shared, "SKILL.md"), sharedMd);
  await writeFile(join(shared, "reference", "query_task.md"), "Return the completed task result.\n");
  await writeFile(join(video, "SKILL.md"), videoMd);
  await writeFile(join(video, "reference", "probe-video.md"), "Use the actual video.\n");
  await writeFile(join(video, "reference", "中文 空格.md"), "保留中文路径和内容。\n");
  return { shared, video, directories: [shared, video] };
}

function setup() {
  const agentStore = new InMemoryAgentStore();
  const skillStore = new InMemorySkillStore();
  const skillArtifactStore = new InMemorySkillArtifactStore();
  const app = createApp({
    apiKeyStore: { async findByKeyHash() { return null; } },
    agentStore,
    skillStore,
    skillArtifactStore,
  });
  // Only replace the network transport. Upload, equip, list and file mutation
  // requests all execute the real API routes and their in-memory stores.
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).origin).toBe("https://oma.test");
    expect(request.headers.get("x-api-key")).toBe("test-only-api-key");
    return app.request(request);
  });
  vi.stubGlobal("fetch", fetch);
  return { app, agentStore, skillStore, skillArtifactStore, fetch };
}

async function content(store: InMemorySkillArtifactStore, id: string, path: string) {
  const bytes = await store.get("dev", id, path);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

describe("auto-story provisioning through the API", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("AUTO_STORY_MODEL", undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it("uploads original directory trees and equips independent forks with resolvable sibling paths", async () => {
    const { directories, video } = await fixture();
    const { agentStore, skillStore, skillArtifactStore } = setup();
    const result = await provision({ baseUrl: "https://oma.test/", apiKey: "test-only-api-key", directories });

    const agent = await agentStore.getById(result.agentId);
    expect(agent).toMatchObject({ name: "auto-story", runtime: "pi-agent", sandbox: { enabled: true, image: "auto-story" } });
    const libraries = (await skillStore.list("dev")).data;
    const forks = await skillStore.listByOwner("dev", "agent", result.agentId);
    expect(libraries.map(skill => skill.name).sort()).toEqual([sharedName, videoName].sort());
    expect(agent?.skills).toEqual(result.skills.map((skill: { id: string }) => skill.id));
    expect(forks).toHaveLength(2);
    const sharedFork = forks.find(skill => skill.name === sharedName)!;
    const videoFork = forks.find(skill => skill.name === videoName)!;
    const videoLibrary = libraries.find(skill => skill.name === videoName)!;
    expect(videoFork.sourceSkillId).toBe(videoLibrary.id);
    expect(videoFork.id).not.toBe(videoLibrary.id);

    const forkMd = await content(skillArtifactStore, videoFork.id, "SKILL.md");
    expect(forkMd).toContain(`/skills/${sharedFork.id}/SKILL.md`);
    expect(forkMd).toContain("reference/probe-video.md");
    // Follow the rewritten projection coordinate to its actual stored content.
    expect(await content(skillArtifactStore, sharedFork.id, "SKILL.md")).toBe(sharedMd);
    expect(await content(skillArtifactStore, videoFork.id, "reference/中文 空格.md")).toBe("保留中文路径和内容。\n");
    expect(await content(skillArtifactStore, videoLibrary.id, "SKILL.md")).toBe(videoMd);
    expect(await readFile(join(video, "SKILL.md"), "utf8")).toBe(videoMd);
  });

  it("reruns refresh only this Agent's forks while preserving custom env, other forks and Library files", async () => {
    const { directories, video } = await fixture();
    const { app, agentStore, skillStore, skillArtifactStore } = setup();
    const first = await provision({ baseUrl: "https://oma.test", apiKey: "test-only-api-key", directories });
    const agent = (await agentStore.getById(first.agentId))!;
    await agentStore.update(agent.id, { sandbox: { ...agent.sandbox, env: { ...agent.sandbox?.env, CUSTOM_SETTING: "keep-me" } } });
    const videoLibrary = (await skillStore.list("dev")).data.find(skill => skill.name === videoName)!;
    const otherAgent = await agentStore.create({ tenantId: "dev", name: "other", runtime: "pi-agent", model: "m", system: "s" });
    const otherEquip = await app.request(`/v1/agents/${otherAgent.id}/skills`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ skillId: videoLibrary.id }),
    });
    expect(otherEquip.status).toBe(201);
    const otherFork = await otherEquip.json();

    await rm(join(video, "reference", "中文 空格.md"));
    await writeFile(join(video, "reference", "probe-video.md"), "Updated local contract.\n");
    await writeFile(join(video, "reference", "new & query.md"), "New local file.\n");
    const second = await provision({ baseUrl: "https://oma.test", apiKey: "test-only-api-key", directories });
    expect(second.agentId).toBe(first.agentId);
    expect(second.skills.map((skill: { id: string }) => skill.id)).toEqual(first.skills.map((skill: { id: string }) => skill.id));
    expect((await agentStore.getById(first.agentId))?.sandbox?.env?.CUSTOM_SETTING).toBe("keep-me");
    expect((await skillStore.list("dev")).data).toHaveLength(2);
    const refreshedFork = second.skills.find((skill: { name: string }) => skill.name === videoName)!;
    expect(await content(skillArtifactStore, refreshedFork.id, "reference/中文 空格.md")).toBeNull();
    expect(await content(skillArtifactStore, refreshedFork.id, "reference/probe-video.md")).toBe("Updated local contract.\n");
    expect(await content(skillArtifactStore, refreshedFork.id, "reference/new & query.md")).toBe("New local file.\n");
    for (const id of [videoLibrary.id, otherFork.id]) {
      expect(await content(skillArtifactStore, id, "reference/probe-video.md")).toBe("Use the actual video.\n");
      expect(await content(skillArtifactStore, id, "reference/中文 空格.md")).toBe("保留中文路径和内容。\n");
    }
  });

  it("finds an existing Agent and Library Skill past the first listing page", async () => {
    const { directories } = await fixture();
    const { agentStore, skillStore, skillArtifactStore } = setup();
    for (let index = 0; index < 100; index++) {
      await agentStore.create({ tenantId: "dev", name: `unrelated-${index}`, runtime: "mock", model: "m", system: "s" });
      await skillStore.create({ tenantId: "dev", name: `unrelated-${index}`, description: "Unrelated Skill" });
    }
    const existingAgent = await agentStore.create({ tenantId: "dev", name: "auto-story", runtime: "pi-agent", model: "previous-model", system: "s" });
    const existingLibrary = await skillStore.create({ tenantId: "dev", name: sharedName, description: "Existing shared Skill" });
    await skillArtifactStore.put("dev", existingLibrary.id, "SKILL.md", "Previous Library version");

    const result = await provision({ baseUrl: "https://oma.test", apiKey: "test-only-api-key", directories });
    expect(result.agentId).toBe(existingAgent.id);
    const sharedFork = (await skillStore.listByOwner("dev", "agent", existingAgent.id)).find(skill => skill.name === sharedName)!;
    expect(sharedFork.sourceSkillId).toBe(existingLibrary.id);
    expect(await content(skillArtifactStore, sharedFork.id, "SKILL.md")).toBe(sharedMd);
    expect(await content(skillArtifactStore, existingLibrary.id, "SKILL.md")).toBe("Previous Library version");
  });

  it("equips additional original Skills without resetting the existing Agent configuration", async () => {
    const { shared, video } = await fixture();
    const { agentStore } = setup();
    const first = await provision({ baseUrl: "https://oma.test", apiKey: "test-only-api-key", directories: [shared] });
    await agentStore.update(first.agentId, {
      model: "openai-codex/gpt-6-astra", system: "User-selected workflow",
      sandbox: { enabled: true, image: "auto-story", env: { RUNTIME_ENV: "DEV", HTTP_PROXY: "http://test-proxy:8080" } },
    });
    const before = structuredClone((await agentStore.getById(first.agentId))!);
    const result = await provision({ baseUrl: "https://oma.test", apiKey: "test-only-api-key", directories: [video], skillsOnly: true });
    const after = (await agentStore.getById(first.agentId))!;
    expect(after.model).toBe(before.model);
    expect(after.system).toBe(before.system);
    expect(after.sandbox).toEqual(before.sandbox);
    expect(after.skills).toEqual([...before.skills!, ...result.skills.map((skill: { id: string }) => skill.id)]);
    expect(result.model).toBe(before.model);
  });
});
