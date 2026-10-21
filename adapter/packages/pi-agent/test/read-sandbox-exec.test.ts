import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { buildCustomTools, readImageResizeConfig } from "../src/custom-tools.js";

// Real 2x2 RGB fixtures, encoded by Pillow as PNG and JPEG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8YCDAwMDAxMDAwMDAAAAOegEkxs/ipgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDAooor5Y/UT//Z", "base64");

// Seeded RGB noise does not compress, so the PNG exceeds any small byte limit.
function noisePng(width: number, height: number): Buffer {
  let seed = 1;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) if (i % (width * 3 + 1)) raw[i] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let root: string;
let executor: LocalToolExecutor;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oma-read-"));
  executor = new LocalToolExecutor({ root });
  // A raw read must never pass binary through ToolExecutor's UTF-8 seam.
  executor.readFile = async () => { throw new Error("UTF8_READ_FORBIDDEN"); };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function readTool() {
  return buildCustomTools(executor).find(({ name }) => name === "read")!;
}

describe("raw filesystem seam through Pi's native read tool", () => {
  it.each([
    { path: "reference.jpg", bytes: PNG, mimeType: "image/png" },
    { path: "portrait.png", bytes: JPEG, mimeType: "image/jpeg" },
  ])("returns native image content for $mimeType by magic, despite its extension", async ({ path, bytes, mimeType }) => {
    await writeFile(join(root, path), bytes);
    const result = await readTool().execute("read-image", { path } as never, undefined, undefined, {} as never);
    const image = result.content.find((block) => block.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") throw new Error("Pi did not return an image to the model");
    expect(image.mimeType).toBe(mimeType);
    expect(Buffer.from(image.data, "base64")).toEqual(bytes);
    expect(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"))
      .toBe(`Read image file [${mimeType}]`);
    expect(JSON.stringify(result)).not.toContain("\\u0000");
  });

  it("encodes read images once under a default budget that a model's models.json inputLimits replaces", async () => {
    const config = await mkdtemp(join(tmpdir(), "oma-models-"));
    try {
      const modelsPath = join(config, "models.json");
      const resize = (maxBytes: number, size?: number) => ({ inputLimits: { images: { resize: { maxBytes, ...(size ? { maxWidth: size, maxHeight: size } : {}) } } } });
      await writeFile(modelsPath, JSON.stringify({ providers: { deepseek: { models: [{ id: "small", ...resize(200_000, 300) }, { id: "pi-default", ...resize(4.5 * 1024 * 1024) }] } } }));
      const png = noisePng(900, 700);
      expect(png.toString("base64").length).toBeGreaterThan(1024 * 1024);
      await writeFile(join(root, "frame.png"), png);
      const tool = buildCustomTools(executor, readImageResizeConfig(modelsPath)).find(({ name }) => name === "read")!;
      const read = (provider: string, id: string) => tool.execute(`read-${id}`, { path: "frame.png" } as never, undefined, undefined,
        { model: { provider, id, input: ["text", "image"] } } as never);
      const imageOf = (result: Awaited<ReturnType<typeof read>>) => result.content.find((block) => block.type === "image");
      const textsOf = (result: Awaited<ReturnType<typeof read>>) => result.content.flatMap((block) => block.type === "text" ? [block.text] : []);

      // Models absent from models.json, such as tenant providers, get the default.
      const defaulted = imageOf(await read("tenant-provider", "custom-model"));
      expect(defaulted).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(defaulted?.type === "image" && defaulted.data.length).toBeLessThan(1024 * 1024);

      const small = await read("deepseek", "small");
      expect(imageOf(small)).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(textsOf(small)).toEqual(["Read image file [image/png]",
        "[Image: original 900x700, displayed at 300x233. Multiply coordinates by 3.00 to map to original image.]"]);

      // Pi's own limits restore its pass-through behavior for one model.
      expect(imageOf(await read("deepseek", "pi-default"))).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    } finally {
      await rm(config, { recursive: true, force: true });
    }
  });

  it("preserves UTF-8 text, Chinese, emoji, replacement characters and literal escapes", async () => {
    const text = "中文 😀 � literal \\u0000\n第二行";
    await writeFile(join(root, "text.png"), text);
    const result = await readTool().execute("read-text", { path: "text.png" } as never, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: "text", text }]);
    const page = await readTool().execute("read-page", { path: "text.png", offset: 2, limit: 1 } as never, undefined, undefined, {} as never);
    expect(page.content).toEqual([{ type: "text", text: "第二行" }]);
  });

  it.each([
    { name: "audio.wav", bytes: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x57, 0x41, 0x56, 0x45]) },
    { name: "invalid-utf8.bin", bytes: Buffer.from([0xff, 0xfe, 0x80]) },
  ])("matches native replacement/NUL decoding for $name", async ({ name, bytes }) => {
    await writeFile(join(root, name), bytes);
    const expected = await createReadToolDefinition(root).execute("native-binary", { path: name }, undefined, undefined, {} as never);
    const actual = await readTool().execute("sandbox-binary", { path: name } as never, undefined, undefined, {} as never);
    expect(actual).toEqual(expected);
    expect(actual.content).toEqual([{ type: "text", text: bytes.toString("utf8") }]);
  });

  it("does not reuse stale file bytes between calls", async () => {
    const tool = readTool();
    await writeFile(join(root, "note.txt"), "before");
    await tool.execute("first", { path: "note.txt" } as never, undefined, undefined, {} as never);
    await writeFile(join(root, "note.txt"), "after");
    const result = await tool.execute("second", { path: "note.txt" } as never, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: "text", text: "after" }]);
  });
});
