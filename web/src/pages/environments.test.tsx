// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import EnvironmentsPage from "./environments";
import EnvironmentDetailPage from "./environment-detail";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SECRET = "typed-secret-value";
const build = { id: "envb_1", status: "pending", createdAt: "2026-10-26T00:00:00Z", startedAt: null, finishedAt: null, errorCode: null, errorMessage: null };
const builtIn = {
  id: "env_video_production", ownerType: "platform", name: "video-production", description: "Video tools", baseImage: "oma-media",
  status: "ready", image: "registry/oma-environments@sha256:abc", manifest: null, lastBuild: { ...build, status: "succeeded" },
  initScript: "apt-get install -y libgl1\n", createdAt: "2026-10-26T00:00:00Z", updatedAt: "2026-10-26T00:00:00Z",
  env: [{ name: "HTTP_PROXY", value: "http://proxy:7890" }, { name: "GEMINI_API_KEY", secretRef: { source: "platform", key: "GEMINI_API_KEY" } }],
};
const own = {
  ...builtIn, id: "env_own", ownerType: "tenant", name: "data", description: "", baseImage: "oma-base", status: "pending", image: null,
  lastBuild: build, initScript: "pip install requests\n",
  env: [{ name: "A", value: "1" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
};

function host(overrides: (url: URL, init: RequestInit) => Response | undefined = () => undefined) {
  const environments = new Map<string, Record<string, unknown>>([[builtIn.id, builtIn], [own.id, own]]);
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const answer = overrides(url, init);
    if (answer) return answer;
    const id = url.pathname.split("/")[3];
    if (url.pathname.endsWith("/log")) {
      const found = environments.get(id) as { lastBuild: unknown } | undefined;
      return Response.json({ build: found?.lastBuild, finished: false, text: "", offset: 0, nextOffset: 0, truncated: false });
    }
    if (url.pathname === "/v1/environments" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const source = body.from ? environments.get(body.from) : {};
      const created = { ...own, ...source, ...body, id: "env_new", ownerType: "tenant", name: body.name ?? `${source?.name}-copy`, status: "pending" };
      environments.set("env_new", created);
      return Response.json(created, { status: 201 });
    }
    const summary = (env: Record<string, unknown>) => Object.fromEntries(Object.entries(env).filter(([key]) => !["initScript", "env", "manifest"].includes(key)));
    if (url.pathname === "/v1/environments") return Response.json({ data: [...environments.values()].map(summary) });
    if (init.method === "POST") {
      const updated = { ...environments.get(id)!, ...JSON.parse(String(init.body)) };
      environments.set(id, updated);
      return Response.json(updated);
    }
    if (init.method === "DELETE") { environments.delete(id); return Response.json({ type: "environment_deleted", id }); }
    const found = environments.get(id);
    return found ? Response.json(found) : Response.json({ error: "Environment not found", code: "environment_not_found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/environments" element={<EnvironmentsPage />} />
          <Route path="/environments/:id" element={<EnvironmentDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const sentBodies = (fetch: ReturnType<typeof host>, method: string) =>
  fetch.mock.calls.filter(([, init]) => init?.method === method).map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined }));

it("lists built-ins first with their tag and every Environment's build status", async () => {
  host();
  renderAt("/environments");
  const cards = await screen.findAllByRole("region");
  expect(cards.map((card) => within(card).getByRole("link").textContent)).toEqual(["video-production", "data"]);
  expect(within(cards[0]).getByText("Built-in")).toBeTruthy();
  expect(within(cards[0]).getByText("Ready")).toBeTruthy();
  expect(within(cards[1]).queryByText("Built-in")).toBeNull();
  expect(within(cards[1]).getByText("Pending build")).toBeTruthy();
  expect(within(cards[0]).queryByRole("button", { name: "Delete video-production" })).toBeNull();
  expect(within(cards[1]).getByRole("button", { name: "Delete data" })).toBeTruthy();
});

it("creates an Environment with plain variables and a secret, then shows it pending", async () => {
  const fetch = host();
  renderAt("/environments");
  fireEvent.click(await screen.findByRole("button", { name: "New Environment" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "scraper" } });
  fireEvent.change(screen.getByLabelText("Init script"), { target: { value: "pip install httpx\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Base Image" }));
  fireEvent.click(screen.getByRole("button", { name: "oma-media (with FFmpeg and CJK fonts)" }));
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
  fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "FOO" } });
  fireEvent.change(screen.getByLabelText("Value of FOO"), { target: { value: "bar" } });
  fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
  fireEvent.change(screen.getAllByLabelText("Variable name")[1], { target: { value: "API_KEY" } });
  const secret = screen.getByLabelText("Value of API_KEY") as HTMLInputElement;
  expect(secret.type).toBe("password");
  fireEvent.change(secret, { target: { value: SECRET } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("heading", { name: "scraper" })).toBeTruthy();
  expect(sentBodies(fetch, "POST")[0].body).toEqual({
    name: "scraper", description: "", baseImage: "oma-media", initScript: "pip install httpx\n",
    env: [{ name: "FOO", value: "bar" }, { name: "API_KEY", secretRef: { source: "environment", key: "API_KEY" }, value: SECRET }],
  });
  expect(screen.getByText("Pending build")).toBeTruthy();
});

it("shows secrets by name only and keeps a stored secret when its field is left blank", async () => {
  const fetch = host();
  renderAt("/environments/env_own");
  expect(await screen.findByText("Secret ••••")).toBeTruthy();
  expect(screen.getByText("pip install requests")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Value of TOKEN") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Value of A"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sentBodies(fetch, "POST")).toHaveLength(1));
  expect(sentBodies(fetch, "POST")[0]).toEqual({
    url: "http://localhost:3000/v1/environments/env_own",
    body: {
      name: "data", description: "", baseImage: "oma-base", initScript: "pip install requests\n",
      env: [{ name: "A", value: "2" }, { name: "TOKEN", secretRef: { source: "environment", key: "TOKEN" } }],
    },
  });
  expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
});

it("keeps built-ins read-only, offers a copy and surfaces API errors", async () => {
  const fetch = host((url, init) =>
    url.pathname === "/v1/environments/env_own" && init.method === "POST"
      ? Response.json({ error: "An Environment named \"video\" already exists.", code: "environment_name_conflict" }, { status: 409 })
      : undefined);
  renderAt("/environments/env_video_production");
  expect(await screen.findByText("Provided by platform ••••")).toBeTruthy();
  expect(screen.getByText("Built-in")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete Environment" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy to a custom Environment" }));
  expect(await screen.findByRole("heading", { name: "video-production-copy" })).toBeTruthy();
  expect(sentBodies(fetch, "POST")[0].body).toEqual({ from: "env_video_production" });

  cleanup();
  renderAt("/environments/env_own");
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "video" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("already exists");
});

it("deletes an Environment after confirmation", async () => {
  const fetch = host();
  renderAt("/environments/env_own");
  fireEvent.click(await screen.findByRole("button", { name: "Delete Environment" }));
  expect(sentBodies(fetch, "DELETE")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(sentBodies(fetch, "DELETE").map((call) => call.url)).toEqual(["http://localhost:3000/v1/environments/env_own"]));
  expect(await screen.findByRole("button", { name: "New Environment" })).toBeTruthy();
});
