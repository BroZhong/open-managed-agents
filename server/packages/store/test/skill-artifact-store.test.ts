import { describe, expect, it } from "vitest";
import { S3SkillArtifactStore } from "../src/s3/skill-artifact-store.js";

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("S3SkillArtifactStore", () => {
  it("copies Skill files with bounded concurrent reads and writes", async () => {
    const fileCount = 17;
    const tenantId = "tenant";
    const sourceSkillId = "source";
    const targetSkillId = "target";
    const sourcePrefix = `object/workspace/${tenantId}/skills/${sourceSkillId}/`;
    const targetPrefix = `object/workspace/${tenantId}/skills/${targetSkillId}/`;
    const objects = new Map<string, Uint8Array>(
      Array.from({ length: fileCount }, (_, index) => [
        `${sourcePrefix}file-${index}.md`,
        new TextEncoder().encode(`file ${index}`),
      ]),
    );
    let activeGets = 0;
    let activePuts = 0;
    let maxConcurrentGets = 0;
    let maxConcurrentPuts = 0;

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/object/list/workspace") && method === "POST") {
        return jsonResponse(
          Array.from({ length: fileCount }, (_, index) => ({
            name: `file-${index}.md`,
            id: `file-${index}`,
            metadata: { size: 6 },
          })),
        );
      }

      const objectKey = `object/${url.split("/object/")[1] ?? ""}`;
      if (method === "GET") {
        activeGets++;
        maxConcurrentGets = Math.max(maxConcurrentGets, activeGets);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const body = objects.get(objectKey);
        activeGets--;
        return body
          ? new Response(body, { status: 200 })
          : new Response(null, { status: 404 });
      }
      if (method === "POST") {
        activePuts++;
        maxConcurrentPuts = Math.max(maxConcurrentPuts, activePuts);
        await new Promise((resolve) => setTimeout(resolve, 5));
        objects.set(objectKey, init?.body as unknown as Uint8Array);
        activePuts--;
        return jsonResponse({ Key: objectKey });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const store = new S3SkillArtifactStore({
      endpoint: "http://storage.local/storage/v1",
      serviceKey: "service-key",
      bucket: "workspace",
      fetch: fetchImpl,
    });

    await store.copyTree(tenantId, sourceSkillId, targetSkillId);

    expect(maxConcurrentGets).toBeGreaterThan(1);
    expect(maxConcurrentGets).toBeLessThanOrEqual(8);
    expect(maxConcurrentPuts).toBeGreaterThan(1);
    expect(maxConcurrentPuts).toBeLessThanOrEqual(8);
    expect(
      [...objects.keys()].filter((key) => key.startsWith(targetPrefix)),
    ).toHaveLength(fileCount);
    for (let index = 0; index < fileCount; index++) {
      expect(
        new TextDecoder().decode(objects.get(`${targetPrefix}file-${index}.md`)),
      ).toBe(`file ${index}`);
    }
  });

  it("deletes an unequipped Skill's files with bounded concurrency", async () => {
    const fileCount = 17;
    const tenantId = "tenant";
    const skillId = "fork";
    const prefix = `object/workspace/${tenantId}/skills/${skillId}/`;
    const objects = new Set(
      Array.from({ length: fileCount }, (_, index) => `${prefix}file-${index}.md`),
    );
    let activeDeletes = 0;
    let maxConcurrentDeletes = 0;

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/object/list/workspace") && method === "POST") {
        return jsonResponse(
          Array.from({ length: fileCount }, (_, index) => ({
            name: `file-${index}.md`,
            id: `file-${index}`,
            metadata: { size: 6 },
          })),
        );
      }
      if (method === "DELETE") {
        activeDeletes++;
        maxConcurrentDeletes = Math.max(maxConcurrentDeletes, activeDeletes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        objects.delete(`object/${url.split("/object/")[1] ?? ""}`);
        activeDeletes--;
        return jsonResponse({ message: "Deleted" });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const store = new S3SkillArtifactStore({
      endpoint: "http://storage.local/storage/v1",
      serviceKey: "service-key",
      bucket: "workspace",
      fetch: fetchImpl,
    });

    await store.deleteTree(tenantId, skillId);

    expect(maxConcurrentDeletes).toBeGreaterThan(1);
    expect(maxConcurrentDeletes).toBeLessThanOrEqual(8);
    expect(objects.size).toBe(0);
  });

  it("waits for the active batch to settle before reporting an I/O failure", async () => {
    let slowDeleteFinished = false;
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/object/list/workspace") && method === "POST") {
        return jsonResponse([
          { name: "fails.md", id: "fails", metadata: { size: 1 } },
          { name: "slow.md", id: "slow", metadata: { size: 1 } },
        ]);
      }
      if (method === "DELETE" && url.endsWith("/fails.md")) {
        return new Response("failed", { status: 500 });
      }
      if (method === "DELETE" && url.endsWith("/slow.md")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        slowDeleteFinished = true;
        return jsonResponse({ message: "Deleted" });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const store = new S3SkillArtifactStore({
      endpoint: "http://storage.local/storage/v1",
      serviceKey: "service-key",
      bucket: "workspace",
      fetch: fetchImpl,
    });

    await expect(store.deleteTree("tenant", "fork")).rejects.toThrow(
      "Supabase deleteObject failed",
    );
    try {
      expect(slowDeleteFinished).toBe(true);
    } finally {
      if (!slowDeleteFinished) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
  });
});
