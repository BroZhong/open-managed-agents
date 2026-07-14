import RdsAiPackage, {
  DescribeAppInstancesRequest,
  DescribeInstanceAuthInfoRequest,
} from "@alicloud/rdsai20250507";

const INSTANCE_PAGE_SIZE = 50;
const MAX_INSTANCE_PAGES = 20;
const MAX_EVENT_DATA_CHARS = 2_000;
const MAX_QUERY_RESPONSE_BYTES = 25_000_000;

export interface RecentSessionsInput {
  days?: number;
  session_limit?: number;
  event_limit_per_session?: number;
}

interface ValidatedRecentSessionsInput {
  days: number;
  session_limit: number;
  event_limit_per_session: number;
}

export interface AliyunCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  regionId: string;
}

interface SupabaseInstance {
  instanceName?: string;
  status?: string;
  publicConnectionString?: string;
  regionId?: string;
}

interface RdsAiClientLike {
  describeAppInstances(request: DescribeAppInstancesRequest): Promise<{
    body?: {
      totalCount?: number;
      instances?: SupabaseInstance[];
    };
  }>;
  describeInstanceAuthInfo(request: DescribeInstanceAuthInfoRequest): Promise<{
    body?: {
      instanceName?: string;
      jwtSecret?: string;
      apiKeys?: {
        anonKey?: string;
        serviceKey?: string;
      };
      configList?: Array<{ value?: string }>;
    };
  }>;
}

export type RdsAiClientFactory = (
  credentials: AliyunCredentials,
  regionId: string,
) => RdsAiClientLike;

export interface SupabaseSessionEnvironment {
  tenantId: string;
  configuredInstance?: string;
  credentials: AliyunCredentials;
}

export interface SupabaseSessionReaderOptions {
  tenantId: string;
  configuredInstance?: string;
  credentialsProvider: () => Promise<AliyunCredentials>;
  clientFactory?: RdsAiClientFactory;
  fetchFn?: typeof fetch;
}

export interface RecentSessionsResult {
  window_days: number;
  session_limit: number;
  event_limit_per_session: number;
  event_data_truncated_at_chars: number;
  sessions: unknown[];
}

class SafeReaderError extends Error {}

function requiredEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function credentialEnvironmentValue(
  env: Record<string, string | undefined>,
  primaryName: string,
  fallbackName: string,
): string {
  const primary = env[primaryName]?.trim();
  if (primary) return primary;
  const fallback = env[fallbackName]?.trim();
  if (fallback) return fallback;
  throw new Error(`${primaryName} or ${fallbackName} is required`);
}

function assertSafeIdentifier(value: string, name: string, maxLength = 256): string {
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function loadSupabaseSessionEnvironment(
  env: Record<string, string | undefined>,
): SupabaseSessionEnvironment {
  const tenantId = assertSafeIdentifier(
    requiredEnvironmentValue(env, "OMA_TENANT_ID"),
    "OMA_TENANT_ID",
  );
  const regionId = requiredEnvironmentValue(env, "ALIYUN_REGION");
  if (!/^[a-z0-9-]{2,32}$/.test(regionId)) {
    throw new Error("ALIYUN_REGION is invalid");
  }
  const configuredInstanceRaw = env.ALIYUN_SUPABASE_INSTANCE?.trim();
  const configuredInstance = configuredInstanceRaw
    ? assertSafeIdentifier(configuredInstanceRaw, "ALIYUN_SUPABASE_INSTANCE")
    : undefined;
  return {
    tenantId,
    ...(configuredInstance ? { configuredInstance } : {}),
    credentials: {
      accessKeyId: credentialEnvironmentValue(
        env,
        "ALIYUN_ACCESS_KEY_ID",
        "ALIBABA_CLOUD_ACCESS_KEY_ID",
      ),
      accessKeySecret: credentialEnvironmentValue(
        env,
        "ALIYUN_ACCESS_KEY_SECRET",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
      ),
      regionId,
    },
  };
}

function boundedInteger(
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value === undefined ? defaultValue : value;
  if (!Number.isInteger(candidate) || typeof candidate !== "number"
    || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function validateInput(input: RecentSessionsInput): ValidatedRecentSessionsInput {
  return {
    days: boundedInteger(input.days, 7, 1, 30, "days"),
    session_limit: boundedInteger(input.session_limit, 25, 1, 100, "session_limit"),
    event_limit_per_session: boundedInteger(
      input.event_limit_per_session,
      50,
      1,
      200,
      "event_limit_per_session",
    ),
  };
}

function escapeSqlText(value: string): string {
  return `E'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Builds the one query this integration is allowed to issue. No SQL or table
 * name comes from a tool call; only validated integer bounds and the
 * Host-provided tenant id are interpolated.
 */
export function buildRecentSessionsSql(
  tenantId: string,
  input: RecentSessionsInput,
): string {
  assertSafeIdentifier(tenantId, "OMA_TENANT_ID");
  const validated = validateInput(input);
  const tenantLiteral = escapeSqlText(tenantId);
  return `
WITH recent_sessions AS (
  SELECT
    s.id,
    s.agent_id,
    s.status,
    s.title,
    s.created_at,
    s.updated_at
  FROM oma.sessions AS s
  WHERE s.tenant_id = ${tenantLiteral}
    AND s.created_at >= NOW() - (${validated.days} * INTERVAL '1 day')
  ORDER BY s.created_at DESC
  LIMIT ${validated.session_limit}
),
ranked_events AS (
  SELECT
    e.session_id,
    e.seq,
    e.type,
    e.ts,
    LEFT(COALESCE(e.data::text, 'null'), ${MAX_EVENT_DATA_CHARS}) AS data,
    ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.seq DESC) AS event_rank
  FROM oma.events AS e
  JOIN recent_sessions AS s ON s.id = e.session_id
)
SELECT
  s.id,
  s.agent_id,
  s.status,
  s.title,
  s.created_at,
  s.updated_at,
  COALESCE(
    json_agg(
      json_build_object(
        'seq', e.seq,
        'type', e.type,
        'data', e.data,
        'ts', e.ts
      ) ORDER BY e.seq
    ) FILTER (WHERE e.session_id IS NOT NULL AND e.event_rank <= ${validated.event_limit_per_session}),
    '[]'::json
  ) AS events
FROM recent_sessions AS s
LEFT JOIN ranked_events AS e
  ON e.session_id = s.id
  AND e.event_rank <= ${validated.event_limit_per_session}
GROUP BY
  s.id,
  s.agent_id,
  s.status,
  s.title,
  s.created_at,
  s.updated_at
ORDER BY s.created_at DESC
`;
}

const CENTER_UNIT_REGIONS = new Set([
  "cn-beijing",
  "cn-wulanchabu",
  "cn-hangzhou",
  "cn-shanghai",
  "cn-shenzhen",
  "cn-guangzhou",
]);

function defaultClientFactory(
  credentials: AliyunCredentials,
  regionId: string,
): RdsAiClientLike {
  const endpoint = CENTER_UNIT_REGIONS.has(regionId)
    ? "rdsai.aliyuncs.com"
    : `rdsai.${regionId}.aliyuncs.com`;
  const config = {
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    endpoint,
    regionId,
  };
  // The generated package is CommonJS but declares a default-exported client.
  // NodeNext surfaces either shape depending on the loader, so normalize it at
  // this single boundary and keep the rest of the reader structural/testable.
  const packageWithDefault = RdsAiPackage as unknown as { default?: unknown };
  const Client = (packageWithDefault.default ?? RdsAiPackage) as new (
    clientConfig: typeof config,
  ) => RdsAiClientLike;
  return new Client(config);
}

function chooseInstance(
  instances: SupabaseInstance[],
  configuredInstance: string | undefined,
): Required<Pick<SupabaseInstance, "instanceName" | "publicConnectionString" | "regionId">> {
  const running = instances.filter((instance) =>
    instance.status?.toLowerCase() === "running"
    && !!instance.instanceName
    && !!instance.publicConnectionString
    && !!instance.regionId
  );
  if (configuredInstance) {
    const selected = running.find((instance) => instance.instanceName === configuredInstance);
    if (!selected) throw new SafeReaderError("Configured Supabase instance is unavailable");
    return selected as Required<Pick<SupabaseInstance, "instanceName" | "publicConnectionString" | "regionId">>;
  }
  if (running.length === 0) {
    throw new SafeReaderError("No running Supabase instance is available");
  }
  if (running.length !== 1) {
    throw new SafeReaderError(
      "Multiple running Supabase instances are available; configure ALIYUN_SUPABASE_INSTANCE",
    );
  }
  return running[0] as Required<Pick<SupabaseInstance, "instanceName" | "publicConnectionString" | "regionId">>;
}

function postgresMetaQueryUrl(connectionString: string): string {
  const base = /^[a-z][a-z0-9+.-]*:\/\//i.test(connectionString)
    ? connectionString
    : `http://${connectionString}`;
  const url = new URL(base);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new SafeReaderError("Supabase endpoint is unavailable");
  }
  url.pathname = "/pg/query";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactInfrastructure(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .reduce(
        (redacted, secret) => secret
          ? redacted.split(secret).join("[REDACTED]")
          : redacted,
        value,
      );
  }
  if (Array.isArray(value)) return value.map((entry) => redactInfrastructure(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      redactInfrastructure(entry, secrets),
    ]));
  }
  return value;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_QUERY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new SafeReaderError(
          "Supabase session query response is too large",
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

export function createSupabaseSessionReader(options: SupabaseSessionReaderOptions) {
  const tenantId = assertSafeIdentifier(options.tenantId.trim(), "OMA_TENANT_ID");
  if (!tenantId) throw new Error("OMA_TENANT_ID is required");
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const fetchFn = options.fetchFn ?? fetch;

  return {
    async queryRecentSessions(input: RecentSessionsInput): Promise<RecentSessionsResult> {
      const validated = validateInput(input);
      try {
        const credentials = await options.credentialsProvider();
        const discoveryClient = clientFactory(credentials, credentials.regionId);
        const instances: SupabaseInstance[] = [];
        for (let pageNumber = 1; pageNumber <= MAX_INSTANCE_PAGES; pageNumber++) {
          const response = await discoveryClient.describeAppInstances(
            new DescribeAppInstancesRequest({
              appType: "supabase",
              pageNumber,
              pageSize: INSTANCE_PAGE_SIZE,
              regionId: credentials.regionId,
            }),
          );
          const page = response.body?.instances ?? [];
          instances.push(...page);
          const totalCount = response.body?.totalCount ?? instances.length;
          if (instances.length >= totalCount || page.length < INSTANCE_PAGE_SIZE) break;
          if (pageNumber === MAX_INSTANCE_PAGES) {
            throw new SafeReaderError("Supabase instance discovery returned too many results");
          }
        }

        const instance = chooseInstance(instances, options.configuredInstance);
        const authClient = instance.regionId === credentials.regionId
          ? discoveryClient
          : clientFactory(credentials, instance.regionId);
        const authResponse = await authClient.describeInstanceAuthInfo(
          new DescribeInstanceAuthInfoRequest({
            instanceName: instance.instanceName,
            regionId: instance.regionId,
          }),
        );
        const serviceKey = authResponse.body?.apiKeys?.serviceKey;
        if (!serviceKey) throw new SafeReaderError("Supabase read credentials are unavailable");

        const endpoint = postgresMetaQueryUrl(instance.publicConnectionString);
        const response = await fetchFn(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            "Content-Type": "application/json",
            apikey: serviceKey,
          },
          body: JSON.stringify({ query: buildRecentSessionsSql(tenantId, validated) }),
        });
        if (!response.ok) throw new SafeReaderError("Supabase session query failed");
        const responseText = await readBoundedResponseText(response);
        const parsed = JSON.parse(responseText) as unknown;
        if (!Array.isArray(parsed)) throw new SafeReaderError("Supabase session query returned invalid data");

        const infrastructureValues = [
          credentials.accessKeyId,
          credentials.accessKeySecret,
          instance.instanceName,
          instance.publicConnectionString,
          endpoint,
          serviceKey,
          authResponse.body?.apiKeys?.anonKey ?? "",
          authResponse.body?.jwtSecret ?? "",
          ...(authResponse.body?.configList ?? []).map((item) => item.value ?? ""),
        ];
        return {
          window_days: validated.days,
          session_limit: validated.session_limit,
          event_limit_per_session: validated.event_limit_per_session,
          event_data_truncated_at_chars: MAX_EVENT_DATA_CHARS,
          sessions: redactInfrastructure(parsed, infrastructureValues) as unknown[],
        };
      } catch (error) {
        if (error instanceof SafeReaderError) throw error;
        throw new SafeReaderError("Supabase session query failed");
      }
    },
  };
}
