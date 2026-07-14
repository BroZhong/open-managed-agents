import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface McpCatalogEntry {
  id: string;
  defaultName: string;
  defaultDescription: string;
  transport: "streamable-http" | "stdio";
  configurable: ["name", "description"];
  requiredEnv: string[];
}

export function useMcpCatalog() {
  return useQuery({
    queryKey: ["mcp-catalog"],
    queryFn: () =>
      apiFetch<{ data: McpCatalogEntry[] }>("/v1/mcp-catalog").then(
        (response) => response.data,
      ),
  });
}
