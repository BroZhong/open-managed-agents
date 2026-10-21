import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { LocalToolExecutor } from "@open-managed-agents/adapter-tool-executor-local";
import { buildCustomTools } from "../src/custom-tools.js";

// Real 2x2 RGB fixtures, encoded by Pillow as PNG and JPEG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN8YCDAwMDAxMDAwMDAAAAOegEkxs/ipgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDAooor5Y/UT//Z", "base64");

// Minimal PNG encoder for fixtures: `pixel` returns each channel's byte.
function png(width: number, height: number, channels: 3 | 4, pixel: (x: number, y: number, c: number) => number): Buffer {
  const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[y * stride + 1 + x * channels + c] = pixel(x, y, c);
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
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
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

  it("re-encodes opaque PNG reads as JPEG once, keeping transparent images and smaller originals", async () => {
    let seed = 1;
    const noise = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 28;
    // A photo-like gradient with grain: PNG stores it poorly, JPEG well.
    const textured = png(600, 400, 3, x => Math.round(x / 3) + noise());
    const flat = png(600, 400, 3, () => 128);
    const transparent = png(600, 400, 4, (x, y, c) => c === 3 ? (x < 300 ? 0 : 255) : Math.round(x / 3) + noise());
    const read = async (bytes: Buffer) => {
      await writeFile(join(root, "frame.png"), bytes);
      return readTool().execute("read-frame", { path: "frame.png" } as never, undefined, undefined, {} as never);
    };

    const converted = await read(textured);
    const image = converted.content.find((block) => block.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(image?.type === "image" && image.data.length).toBeLessThan(textured.toString("base64").length / 2);
    expect(converted.content.filter((block) => block.type === "text")).toEqual([{ type: "text", text: "Read image file [image/png]" }]);

    for (const kept of [flat, transparent]) {
      expect((await read(kept)).content).toContainEqual({ type: "image", mimeType: "image/png", data: kept.toString("base64") });
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
