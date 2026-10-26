// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { toast } from "sonner";
import EnvironmentDetailPage from "./environment-detail";
import { manifestItems } from "@/lib/environment-manifest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const OLD_IMAGE = "registry/oma-environments@sha256:old";
const build = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "envb_2", status, createdAt: "2026-10-26T00:00:00Z", startedAt: "2026-10-26T00:00:05Z", finishedAt: null, errorCode: null, errorMessage: null, ...extra,
});
const FAILED = build("failed", { finishedAt: "2026-10-26T00:02:00Z", errorCode: "environment_build_script_failed", errorMessage: "The init script failed at line 2: false (exit status 1)" });
const MANIFEST = {
  schemaVersion: 1,
  binaries: { ffmpeg: { path: "/usr/local/bin/ffmpeg", version: "ffmpeg version 9.0.1" }, node: { path: "/usr/local/bin/node", version: "v22.23.2" } },
  dpkg: [{ name: "jq", version: "1.6-2.1+deb12u3" }, { name: "libgl1", version: "1.6.0-1" }],
  pip: [{ interpreter: "/opt/venv/bin/python3", prefix: "/opt/venv", packages: [{ name: "google-genai", version: "2.22.0" }, { name: "Pillow", version: "11.0.0" }] }],
  npm: { global: { "/usr/lib/node_modules": [{ name: "npm", version: "10.9.0" }] }, projects: { "/opt/oma-pi-tools": { dependencies: [{ name: "@earendil-works/pi-coding-agent", version: "0.83.0" }], lockedPackages: 120 } } },
};
const environment = (status: string, lastBuild: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: "env_own", ownerType: "tenant", name: "data", description: "", baseImage: "oma-base", status, image: OLD_IMAGE, manifest: MANIFEST,
  lastBuild, initScript: "set -x\nfalse\n", env: [], createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z", ...extra,
});

/** A Host whose build writes its log in two pages, then fails; the Environment follows. */
function host(options: { rebuild?: (init: RequestInit) => Response } = {}) {
  let logReads = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/environments/env_own/build" && init.method === "POST") {
      return options.rebuild?.(init) ?? Response.json(environment("pending", build("pending", { id: "envb_3", startedAt: null })), { status: 202 });
    }
    if (url.pathname === "/v1/environments/env_own/log") {
      const offset = Number(url.searchParams.get("offset"));
      if (url.searchParams.get("build_id") === "envb_3") return Response.json({ build: build("pending", { id: "envb_3", startedAt: null }), finished: false, text: "", offset: 0, nextOffset: 0, truncated: false });
      logReads++;
      return offset === 0
        ? Response.json({ build: build("running"), finished: false, text: "==> Pulling the Base Image\n", offset: 0, nextOffset: 27, truncated: false })
        : Response.json({ build: FAILED, finished: true, text: "[oma] init script failed at line 2: false (exit status 1)\n", offset, nextOffset: 85, truncated: false });
    }
    if (url.pathname === "/v1/environments/env_own") {
      return Response.json(logReads >= 2 ? environment("failed", FAILED) : environment("building", build("running")));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/environments/env_own"]}>
        <Routes><Route path="/environments/:id" element={<EnvironmentDetailPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const logCalls = (fetch: ReturnType<typeof host>) =>
  fetch.mock.calls.map(([url]) => new URL(String(url))).filter((url) => url.pathname.endsWith("/log")).map((url) => url.search);

it("follows the latest build's log every 2 s from its offset until it ends, then shows the failure and keeps the image", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = host();
  renderDetail();
  const panel = await screen.findByRole("region", { name: "Build" });
  await waitFor(() => expect(within(panel).getByLabelText("Build log").textContent).toBe("==> Pulling the Base Image\n"));
  expect(within(panel).getByText("Building")).toBeTruthy();
  expect(screen.getByText("New Sandboxes keep using this image until a new build succeeds.")).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await waitFor(() => expect(within(panel).getByLabelText("Build log").textContent).toBe(
    "==> Pulling the Base Image\n[oma] init script failed at line 2: false (exit status 1)\n"));
  expect(within(panel).getByText("Failed")).toBeTruthy();
  expect(within(panel).getByRole("alert").textContent).toBe("The init script failed at line 2: false (exit status 1)");
  expect(logCalls(fetch)).toEqual(["?build_id=envb_2&offset=0", "?build_id=envb_2&offset=27"]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await waitFor(() => expect(screen.getByText("Build failed")).toBeTruthy());
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(logCalls(fetch)).toHaveLength(2);
  expect(screen.getByText(OLD_IMAGE)).toBeTruthy();
});

it("rebuilds and follows the new build; an API error is surfaced", async () => {
  const fetch = host();
  renderDetail();
  fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Rebuild started"));
  expect(fetch.mock.calls.some(([url, init]) => String(url).endsWith("/v1/environments/env_own/build") && init?.method === "POST")).toBe(true);
  await waitFor(() => expect(logCalls(fetch)).toContain("?build_id=envb_3&offset=0"));
  expect(await screen.findByText("Queued")).toBeTruthy();

  cleanup();
  host({ rebuild: () => Response.json({ error: "Built-in Environments are read-only; copy it to customize it.", code: "environment_read_only" }, { status: 403 }) });
  renderDetail();
  fireEvent.click(await screen.findByRole("button", { name: "Rebuild" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Built-in Environments are read-only; copy it to customize it."));
});

it("lists the preinstalled software by kind, searchable", async () => {
  host();
  renderDetail();
  const manifest = await screen.findByRole("region", { name: "Preinstalled" });
  expect(within(manifest).getByRole("button", { name: "Commands 2" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(manifest).getByText("ffmpeg version 9.0.1")).toBeTruthy();
  fireEvent.click(within(manifest).getByRole("button", { name: "Python 2" }));
  expect(within(manifest).getByText("google-genai")).toBeTruthy();
  fireEvent.change(within(manifest).getByLabelText("Search preinstalled software"), { target: { value: "pill" } });
  expect(within(manifest).queryByText("google-genai")).toBeNull();
  expect(within(manifest).getByText("Pillow")).toBeTruthy();
  fireEvent.click(within(manifest).getByRole("button", { name: "npm 2" }));
  expect(within(manifest).getByText("No matching entries.")).toBeTruthy();
  expect(within(manifest).getByRole("button", { name: "System packages 2" })).toBeTruthy();
  expect(manifestItems({ pip: "not a list", npm: null, binaries: { tini: "0.19.0" } })).toEqual([{ kind: "binary", name: "tini", version: "0.19.0", where: undefined }]);
});
