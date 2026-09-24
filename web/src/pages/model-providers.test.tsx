// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ModelProvidersPage from "./model-providers";
const model = {
  id: "private-model-a",
  name: "Private Model A",
  contextWindow: 32768,
  maxTokens: 4096,
  reasoning: false,
  input: ["text"],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(providers: unknown[] = []) {
  const cache = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  cache.setQueryData(["model-providers"], providers);
  cache.setQueryData(["provider-protocols"], {
    protocols: [
      { id: "openai-completions", name: "OpenAI Chat Completions" },
      { id: "anthropic-messages", name: "Anthropic Messages" },
    ],
  });
  render(
    <QueryClientProvider client={cache}>
      <ModelProvidersPage />
    </QueryClientProvider>,
  );
}
function fillConnection() {
  fireEvent.click(screen.getByRole("button", { name: "Add Provider" }));
  fireEvent.change(screen.getByLabelText("Provider name"), {
    target: { value: "Gateway" },
  });
  fireEvent.change(screen.getByLabelText("Base URL"), {
    target: { value: "https://models.example.com/v1" },
  });
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "secret" },
  });
}
it("fetches endpoint models before selection, then tests and saves the chosen model", async () => {
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/discover")) return Response.json({ data: [model] });
    if (url.endsWith("/test"))
      return Response.json({
        verificationToken: "proof",
        testedAt: new Date().toISOString(),
      });
    if (init?.method === "POST") return Response.json({ id: "custom-one" });
    return Response.json({ data: [] });
  });
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Private Model A/ }),
  );
  expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
    api: "openai-completions",
    baseUrl: "https://models.example.com/v1",
    apiKey: "secret",
  });
  expect(
    (screen.getByRole("button", { name: "Save provider" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.change(screen.getByLabelText("Provider name"), {
    target: { value: "Renamed" },
  });
  expect(
    (screen.getByRole("button", { name: "Save provider" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen.getByRole("checkbox", { name: /Private Model A/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Test selected models" }));
  await screen.findByText(/All selected models responded/);
  fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([url, init]) =>
          url.endsWith("/model-providers") && init?.method === "POST",
      ),
    ).toBe(true),
  );
  const saved = request.mock.calls.find(
    ([url, init]) =>
      url.endsWith("/model-providers") && init?.method === "POST",
  )!;
  expect(JSON.parse(String(saved[1]?.body))).toMatchObject({
    verificationToken: "proof",
    models: [model],
  });
});
it.each(["Base URL", "API key", "Protocol"])(
  "clears endpoint results and selected models when %s changes",
  async (field) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [model] })),
    );
    setup();
    fillConnection();
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Private Model A/ }),
    );
    if (field === "Protocol") {
      fireEvent.click(screen.getByLabelText("Protocol"));
      fireEvent.click(
        screen.getByRole("button", { name: "Anthropic Messages" }),
      );
    } else
      fireEvent.change(screen.getByLabelText(field), {
        target: {
          value:
            field === "Base URL"
              ? "https://other.example.com/v1"
              : "another-key",
        },
      });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("Selected models (0/10)")).toBeTruthy();
  },
);
it("shows fetch errors and empty lists without falling back to static models", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Endpoint rejected key" }, { status: 422 }),
    )
    .mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByText("Endpoint rejected key");
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByText("The endpoint returned no models for this API key.");
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("refreshes the list and removes selections no longer returned by the endpoint", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [model] }))
    .mockResolvedValueOnce(
      Response.json({ data: [{ ...model, id: "model-b", name: "Model B" }] }),
    );
  vi.stubGlobal("fetch", request);
  setup();
  fillConnection();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Private Model A/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByRole("checkbox", { name: /Model B/ });
  expect(screen.getByText("Selected models (0/10)")).toBeTruthy();
});
it("uses stored credentials for discovery while editing", async () => {
  const request = vi.fn(async () => Response.json({ data: [model] }));
  vi.stubGlobal("fetch", request);
  setup([
    {
      id: "custom-one",
      name: "Gateway",
      api: "openai-completions",
      baseUrl: "https://models.example.com/v1",
      models: [model],
      hasApiKey: true,
      testedAt: new Date().toISOString(),
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Edit Gateway" }));
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  await screen.findByRole("checkbox", { name: /Private Model A/ });
  expect(request).toHaveBeenCalledOnce();
});
