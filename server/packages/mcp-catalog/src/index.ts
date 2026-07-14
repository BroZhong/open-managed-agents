import type {
  AgentMcpServerConfig,
  ManagedMcpServerRef,
} from "@oma-server/store";
import type {
  HttpMcpServerConfig,
  McpServerConfig,
  StdioMcpServerConfig,
} from "@open-managed-agents/adapter-core";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ManagedMcpCatalogEntry {
  id: string;
  defaultName: string;
  defaultDescription: string;
  transport: "streamable-http" | "stdio";
  configurable: readonly ["name", "description"];
  requiredEnv: readonly string[];
}

export interface ManagedMcpTenantContext {
  tenantId: string;
}

/** A permanent policy/configuration refusal that a Turn must not retry. */
export class ManagedMcpResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedMcpResolutionError";
  }
}

interface PrivateManagedMcpCatalogEntry extends ManagedMcpCatalogEntry {
  connection:
    | Omit<HttpMcpServerConfig, "name">
    | Omit<StdioMcpServerConfig, "name">;
}

const RDS_CONNECTION = {
  url: "https://campaign.welltop.tech/agent/mcp/rds",
  transport: "streamable-http" as const,
  headers: { Authorization: "Bearer ${RDS_MCP_APIKEY}" },
};

const SUPABASE_SESSION_MCP = fileURLToPath(
  new URL("./supabase-session-mcp.ts", import.meta.url),
);
const TSX_IMPORT = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const CATALOG: readonly PrivateManagedMcpCatalogEntry[] = [
  {
    id: "rds-mcp",
    defaultName: "rds-mcp",
    defaultDescription: "Query authorized RDS resources through the managed gateway.",
    transport: "streamable-http",
    configurable: ["name", "description"],
    requiredEnv: ["RDS_MCP_APIKEY"],
    connection: RDS_CONNECTION,
  },
  {
    id: "aliyun-rds-supabase",
    defaultName: "aliyun-rds-supabase",
    defaultDescription: "Read recent tenant-scoped Sessions and bounded events from Alibaba Cloud Supabase.",
    transport: "stdio",
    configurable: ["name", "description"],
    requiredEnv: [
      "ALIYUN_ACCESS_KEY_ID",
      "ALIYUN_ACCESS_KEY_SECRET",
      "ALIYUN_REGION",
      "OMA_SUPABASE_ALLOWED_TENANTS",
    ],
    connection: {
      // The upstream interactive MCP mutates database grants/functions while
      // connecting. Unattended Loops instead get this Host-owned, SELECT-only
      // facade, which exposes one tenant-scoped query tool.
      command: process.execPath,
      args: ["--import", TSX_IMPORT, SUPABASE_SESSION_MCP],
      env: {
        ALIYUN_ACCESS_KEY_ID: "${ALIYUN_ACCESS_KEY_ID}",
        ALIYUN_ACCESS_KEY_SECRET: "${ALIYUN_ACCESS_KEY_SECRET}",
        ALIBABA_CLOUD_ACCESS_KEY_ID: "${ALIBABA_CLOUD_ACCESS_KEY_ID}",
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: "${ALIBABA_CLOUD_ACCESS_KEY_SECRET}",
        ALIYUN_REGION: "${ALIYUN_REGION}",
        ...(process.env.ALIYUN_SUPABASE_INSTANCE
          ? { ALIYUN_SUPABASE_INSTANCE: "${ALIYUN_SUPABASE_INSTANCE}" }
          : {}),
      },
    },
  },
];

const BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

function isSupabaseTenantAllowed(tenantId: string): boolean {
  const configured = process.env.OMA_SUPABASE_ALLOWED_TENANTS;
  if (!configured) return false;
  return configured
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .includes(tenantId);
}

function isCatalogEntryAvailable(
  entry: PrivateManagedMcpCatalogEntry,
  context: ManagedMcpTenantContext,
): boolean {
  return entry.id !== "aliyun-rds-supabase"
    || isSupabaseTenantAllowed(context.tenantId);
}

export function listManagedMcpCatalog(
  context: ManagedMcpTenantContext,
): ManagedMcpCatalogEntry[] {
  return CATALOG
    .filter((entry) => isCatalogEntryAvailable(entry, context))
    .map(({ connection: _connection, ...entry }) => ({
      ...entry,
      configurable: [...entry.configurable] as ["name", "description"],
      requiredEnv: [...entry.requiredEnv],
    }));
}

function isLegacyRds(value: Record<string, unknown>): boolean {
  const headers = value.headers;
  const keys = Object.keys(value).sort();
  return keys.length === 4
    && keys.join(",") === "headers,name,transport,url"
    && value.name === "rds-mcp"
    && value.url === RDS_CONNECTION.url
    && value.transport === RDS_CONNECTION.transport
    && !!headers
    && typeof headers === "object"
    && !Array.isArray(headers)
    && Object.keys(headers).length === 1
    && (headers as Record<string, unknown>).Authorization === RDS_CONNECTION.headers.Authorization;
}

/**
 * Serialize persisted Agent connections without exposing Host connection
 * definitions. Exact legacy RDS rows are represented as their managed catalog
 * reference; malformed legacy rows are omitted rather than leaked.
 */
export function publicManagedMcpRefs(
  refs: AgentMcpServerConfig[] | undefined,
): ManagedMcpServerRef[] | undefined {
  if (refs === undefined) return undefined;
  const publicRefs: ManagedMcpServerRef[] = [];
  for (const ref of refs) {
    if ("catalogId" in ref) {
      publicRefs.push({
        catalogId: ref.catalogId,
        name: ref.name,
        ...(ref.description === undefined
          ? {}
          : { description: ref.description }),
      });
    } else if (isLegacyRds(ref as unknown as Record<string, unknown>)) {
      publicRefs.push({ catalogId: "rds-mcp", name: "rds-mcp" });
    }
  }
  return publicRefs;
}

function validateName(value: unknown, index: number): string | { error: string } {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim())) {
    return { error: `mcpServers[${index}].name must use 1-64 letters, numbers, dot, underscore, or hyphen` };
  }
  return value.trim();
}

export function normalizeManagedMcpRefs(
  value: unknown,
  context: ManagedMcpTenantContext,
):
  | { refs: ManagedMcpServerRef[] }
  | { error: string } {
  if (!Array.isArray(value)) return { error: "mcpServers must be an array" };
  if (value.length > CATALOG.length) {
    return { error: `mcpServers may contain at most ${CATALOG.length} managed connections` };
  }

  const refs: ManagedMcpServerRef[] = [];
  const names = new Set<string>();
  const catalogIds = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { error: `mcpServers[${index}] must be an object` };
    }
    const record = candidate as Record<string, unknown>;
    const validatedName = validateName(record.name, index);
    if (typeof validatedName !== "string") return validatedName;
    if (names.has(validatedName)) {
      return { error: `mcpServers contains duplicate name: ${validatedName}` };
    }
    names.add(validatedName);

    if (typeof record.catalogId !== "string" || !BY_ID.has(record.catalogId)) {
      return { error: `mcpServers[${index}].catalogId is not in the managed MCP catalog` };
    }
    const entry = BY_ID.get(record.catalogId)!;
    if (!isCatalogEntryAvailable(entry, context)) {
      return { error: `mcpServers[${index}].catalogId is not available for this tenant` };
    }
    if (catalogIds.has(record.catalogId)) {
      return { error: `mcpServers contains duplicate catalogId: ${record.catalogId}` };
    }
    catalogIds.add(record.catalogId);

    const allowedKeys = new Set(["catalogId", "name", "description"]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      return { error: `mcpServers[${index}] may only configure catalogId, name, and description` };
    }
    if (record.description !== undefined && typeof record.description !== "string") {
      return { error: `mcpServers[${index}].description must be a string` };
    }
    if (typeof record.description === "string" && record.description.length > 500) {
      return { error: `mcpServers[${index}].description must be at most 500 characters` };
    }
    refs.push({
      catalogId: record.catalogId,
      name: validatedName,
      ...(record.description === undefined ? {} : { description: record.description }),
    } satisfies ManagedMcpServerRef);
  }
  return { refs };
}

export function resolveManagedMcpServers(
  refs: AgentMcpServerConfig[] | undefined,
  context?: { tenantId: string },
): McpServerConfig[] | undefined {
  if (!refs || refs.length === 0) return undefined;
  return refs.map((ref) => {
    if (!("catalogId" in ref)) {
      if (!isLegacyRds(ref as unknown as Record<string, unknown>)) {
        throw new ManagedMcpResolutionError(
          "Persisted MCP connection is not Host-managed",
        );
      }
      // Reconstruct the compatibility shape from the Host constant. Never
      // forward persisted extra fields: older API validation allowed them and
      // pi-mcp-adapter gives a `command` field precedence over `url`.
      return {
        name: "rds-mcp",
        ...RDS_CONNECTION,
        headers: { ...RDS_CONNECTION.headers },
      } satisfies HttpMcpServerConfig;
    }
    const entry = BY_ID.get(ref.catalogId);
    if (!entry) {
      throw new ManagedMcpResolutionError(
        `Unknown managed MCP catalog id: ${ref.catalogId}`,
      );
    }
    if (entry.id === "aliyun-rds-supabase") {
      if (!context?.tenantId) {
        throw new ManagedMcpResolutionError(
          "Managed Supabase MCP resolution requires a tenant",
        );
      }
      if (!isCatalogEntryAvailable(entry, context)) {
        throw new ManagedMcpResolutionError(
          "Managed Supabase MCP is not available for this tenant",
        );
      }
    }
    const connection = entry.connection;
    if ("command" in connection) {
      return {
        name: ref.name,
        ...connection,
        env: {
          ...connection.env,
          ...(entry.id === "aliyun-rds-supabase"
            ? { OMA_TENANT_ID: context!.tenantId }
            : {}),
        },
      } satisfies StdioMcpServerConfig;
    }
    return {
      name: ref.name,
      ...connection,
      headers: connection.headers ? { ...connection.headers } : undefined,
    } satisfies HttpMcpServerConfig;
  });
}
