// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillFilesEditor } from "./skill-files-editor";

/** A TrueType header followed by bytes that are not valid UTF-8. */
const TTF = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let objectUrls: Map<string, Blob>;
let revoked: string[];
let fetchMock: ReturnType<typeof vi.fn>;

function skillHost() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.searchParams.get("path");
    if (url.pathname === "/v1/skills/s1/files") {
      return Response.json({ data: ["SKILL.md", "assets/Regular.ttf", "assets/logo.png"], has_more: false });
    }
    if (url.pathname === "/v1/skills/s1/files/content" && init?.method === "PUT") {
      return Response.json(JSON.parse(String(init.body)));
    }
    if (url.pathname === "/v1/skills/s1/files/content") {
      if (path === "SKILL.md") return Response.json({ path, content: "# Fonts" });
      if (path === "assets/Regular.ttf") return Response.json({ path, binary: true, size: TTF.byteLength, contentType: "font/ttf" });
      if (path === "assets/logo.png") return Response.json({ path, binary: true, size: PNG.byteLength, contentType: "image/png" });
    }
    if (url.pathname === "/v1/skills/s1/files/raw") {
      if (path === "assets/Regular.ttf") return new Response(TTF, { headers: { "content-type": "font/ttf" } });
      if (path === "assets/logo.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  });
}

function renderEditor() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillFilesEditor skillId="s1" />
    </QueryClientProvider>,
  );
}

async function open(name: string) {
  fireEvent.click(await screen.findByText(name));
}

const calls = (pathname: string) =>
  fetchMock.mock.calls.filter(([input]) => new URL(String(input), "http://localhost").pathname === pathname);

beforeEach(() => {
  objectUrls = new Map();
  revoked = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      const url = `blob:skill/${objectUrls.size + 1}`;
      objectUrls.set(url, blob);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }),
  });
  fetchMock = skillHost();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SkillFilesEditor binary files (#269)", () => {
  it("offers a font as a download of its exact bytes and never opens it as text", async () => {
    let anchor: { href: string; download: string } | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchor = { href: this.href, download: this.download };
    });
    renderEditor();
    await open("assets");
    await open("Regular.ttf");

    expect(await screen.findByText("Not a previewable media type.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(calls("/v1/skills/s1/files/raw")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(anchor).toBeDefined());
    expect(anchor!.download).toBe("Regular.ttf");
    expect(new Uint8Array(await objectUrls.get(anchor!.href)!.arrayBuffer())).toEqual(TTF);
  });

  it("previews an image from its bytes and releases the object URL on leave", async () => {
    const view = renderEditor();
    await open("assets");
    await open("logo.png");

    const image = await screen.findByRole("img");
    const src = image.getAttribute("src")!;
    expect(src).toMatch(/^blob:/);
    expect(new Uint8Array(await objectUrls.get(src)!.arrayBuffer())).toEqual(PNG);
    expect(screen.queryByRole("textbox")).toBeNull();

    view.unmount();
    expect(revoked).toContain(src);
  });

  it("edits and saves a text file as before", async () => {
    renderEditor();
    await open("SKILL.md");
    const editor = await screen.findByDisplayValue("# Fonts");

    fireEvent.change(editor, { target: { value: "# Fonts\nUse them." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls("/v1/skills/s1/files/content").some(([, init]) => init?.method === "PUT")).toBe(true));
    const [, put] = calls("/v1/skills/s1/files/content").find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(put!.body))).toEqual({ path: "SKILL.md", content: "# Fonts\nUse them." });
    expect(calls("/v1/skills/s1/files/raw")).toHaveLength(0);
  });
});
