// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ApiKeysPage from "@/pages/api-keys";
import type { ApiKeyListItem } from "@/lib/hooks/use-api-keys";

afterEach(cleanup);

it("shows token and cache usage for every API key", () => {
  const key: ApiKeyListItem = {
    id: "key_1",
    name: "Production",
    prefix: "oma_live",
    createdAt: "2026-07-14T00:00:00.000Z",
    revokedAt: null,
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 600,
      cacheWriteTokens: 50,
      totalTokens: 1500,
      cacheHitRate: 0.5,
    },
  };
  const revokedKey: ApiKeyListItem = {
    ...key,
    id: "key_2",
    name: "Retired integration",
    prefix: "oma_old",
    revokedAt: "2026-07-14T01:00:00.000Z",
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["api-keys"], [key, revokedKey]);

  render(
    <QueryClientProvider client={queryClient}>
      <ApiKeysPage />
    </QueryClientProvider>,
  );

  const row = screen.getByText("Production").closest("tr");
  expect(row).not.toBeNull();
  const cells = within(row!).getAllByRole("cell");
  expect(cells[3].textContent).toBe("1,200");
  expect(cells[4].textContent).toBe("300");
  expect(cells[5].textContent).toBe("600");
  expect(cells[6].textContent).toBe("50");
  expect(cells[7].textContent).toBe("50.0%");
  expect(within(row!).getByText("Active")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Revoke Production" }),
  ).toBeTruthy();

  const revokedRow = screen.getByText("Retired integration").closest("tr");
  expect(revokedRow).not.toBeNull();
  expect(within(revokedRow!).getByText("Revoked")).toBeTruthy();
  expect(
    within(revokedRow!).queryByRole("button", {
      name: "Revoke Retired integration",
    }),
  ).toBeNull();
});
