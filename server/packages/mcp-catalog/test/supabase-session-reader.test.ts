import { describe, expect, it, vi } from "vitest";
import {
  buildRecentSessionsSql,
  createSupabaseSessionReader,
  loadSupabaseSessionEnvironment,
  type RdsAiClientFactory,
} from "../src/supabase-session-reader.js";

const INFRASTRUCTURE = {
  instanceName: "ra-supabase-sensitive-instance",
  publicConnectionString: "https://supabase-sensitive.example.test",
  serviceKey: "service-role-sensitive-key",
};

function fakeCloud(options?: {
  instances?: Array<{
    instanceName: string;
    status: string;
    publicConnectionString: string;
    regionId: string;
  }>;
  authError?: Error;
}) {
  const describeAppInstances = vi.fn(async () => ({
    body: {
      totalCount: options?.instances?.length ?? 1,
      instances: options?.instances ?? [{
        instanceName: INFRASTRUCTURE.instanceName,
        status: "Running",
        publicConnectionString: INFRASTRUCTURE.publicConnectionString,
        regionId: "cn-hongkong",
      }],
    },
  }));
  const describeInstanceAuthInfo = vi.fn(async () => {
    if (options?.authError) throw options.authError;
    return {
      body: {
        instanceName: INFRASTRUCTURE.instanceName,
        apiKeys: { serviceKey: INFRASTRUCTURE.serviceKey },
      },
    };
  });
  const clientFactory: RdsAiClientFactory = vi.fn(() => ({
    describeAppInstances,
    describeInstanceAuthInfo,
  }));
  return { clientFactory, describeAppInstances, describeInstanceAuthInfo };
}

function readerFixture(options?: Parameters<typeof fakeCloud>[0] & {
  tenantId?: string;
  configuredInstance?: string;
  response?: unknown;
}) {
  const cloud = fakeCloud(options);
  const fetchFn = vi.fn(async () => new Response(
    JSON.stringify(options?.response ?? [{ id: "session-1", events: [] }]),
    { status: 200, headers: { "content-type": "application/json" } },
  ));
  const reader = createSupabaseSessionReader({
    tenantId: options?.tenantId ?? "tenant-a",
    configuredInstance: options?.configuredInstance,
    credentialsProvider: async () => ({
      accessKeyId: "aliyun-access-key",
      accessKeySecret: "aliyun-secret-key",
      regionId: "cn-hongkong",
    }),
    clientFactory: cloud.clientFactory,
    fetchFn,
  });
  return { reader, fetchFn, ...cloud };
}

describe("tenant-scoped Supabase Session reader", () => {
  it("uses only read APIs and a fixed SELECT query with escaped tenant and bounded limits", async () => {
    const fixture = readerFixture({
      tenantId: "tenant\\path' OR TRUE --",
      response: [{
        id: "session-1",
        events: [{
          data: [
            INFRASTRUCTURE.publicConnectionString,
            INFRASTRUCTURE.serviceKey,
            INFRASTRUCTURE.instanceName,
            "aliyun-access-key",
            "aliyun-secret-key",
          ].join(" "),
        }],
      }],
    });

    const result = await fixture.reader.queryRecentSessions({
      days: 2,
      session_limit: 3,
      event_limit_per_session: 4,
    });

    expect(fixture.describeAppInstances).toHaveBeenCalledWith(expect.objectContaining({
      appType: "supabase",
      pageNumber: 1,
      pageSize: 50,
      regionId: "cn-hongkong",
    }));
    expect(fixture.describeInstanceAuthInfo).toHaveBeenCalledWith(expect.objectContaining({
      instanceName: INFRASTRUCTURE.instanceName,
      regionId: "cn-hongkong",
    }));
    expect(fixture.fetchFn).toHaveBeenCalledOnce();

    const [url, init] = fixture.fetchFn.mock.calls[0]!;
    expect(url).toBe(`${INFRASTRUCTURE.publicConnectionString}/pg/query`);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        apikey: INFRASTRUCTURE.serviceKey,
      },
    });
    const body = JSON.parse(String(init?.body)) as { query: string };
    expect(body.query.trimStart()).toMatch(/^WITH\s/i);
    expect(body.query).toContain("FROM oma.sessions");
    expect(body.query).toContain("FROM oma.events");
    expect(body.query).toContain("E'tenant\\\\path'' OR TRUE --'");
    expect(body.query).toContain("2 * INTERVAL '1 day'");
    expect(body.query).toContain("LIMIT 3");
    expect(body.query).toContain("event_rank <= 4");
    expect(body.query).toContain("LEFT(COALESCE(e.data::text, 'null'), 2000)");
    expect(body.query).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|NOTIFY|COPY|CALL|DO)\b/i);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(INFRASTRUCTURE.publicConnectionString);
    expect(serialized).not.toContain(INFRASTRUCTURE.serviceKey);
    expect(serialized).not.toContain(INFRASTRUCTURE.instanceName);
    expect(result).toMatchObject({
      window_days: 2,
      session_limit: 3,
      event_limit_per_session: 4,
      sessions: [{ id: "session-1" }],
    });
  });

  it.each([
    [{ days: 0, session_limit: 1, event_limit_per_session: 1 }, "days"],
    [{ days: 31, session_limit: 1, event_limit_per_session: 1 }, "days"],
    [{ days: 1.5, session_limit: 1, event_limit_per_session: 1 }, "days"],
    [{ days: 1, session_limit: 0, event_limit_per_session: 1 }, "session_limit"],
    [{ days: 1, session_limit: 101, event_limit_per_session: 1 }, "session_limit"],
    [{ days: 1, session_limit: 1, event_limit_per_session: 0 }, "event_limit_per_session"],
    [{ days: 1, session_limit: 1, event_limit_per_session: 201 }, "event_limit_per_session"],
  ])("rejects invalid bounded input %#", async (input, field) => {
    const { reader, fetchFn } = readerFixture();
    await expect(reader.queryRecentSessions(input)).rejects.toThrow(String(field));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("chooses the explicitly configured running instance without exposing identities", async () => {
    const instances = [
      {
        instanceName: "first-sensitive-instance",
        status: "Running",
        publicConnectionString: "https://first-sensitive.example.test",
        regionId: "cn-hongkong",
      },
      {
        instanceName: INFRASTRUCTURE.instanceName,
        status: "Running",
        publicConnectionString: INFRASTRUCTURE.publicConnectionString,
        regionId: "cn-hongkong",
      },
    ];
    const fixture = readerFixture({ instances, configuredInstance: INFRASTRUCTURE.instanceName });

    await fixture.reader.queryRecentSessions({ days: 7, session_limit: 10, event_limit_per_session: 20 });

    expect(fixture.fetchFn.mock.calls[0]?.[0]).toBe(`${INFRASTRUCTURE.publicConnectionString}/pg/query`);
  });

  it("requires exactly one running instance when none is configured and sanitizes selection errors", async () => {
    const identities = ["first-sensitive-instance", "second-sensitive-instance"];
    const { reader } = readerFixture({
      instances: identities.map((instanceName) => ({
        instanceName,
        status: "Running",
        publicConnectionString: `https://${instanceName}.example.test`,
        regionId: "cn-hongkong",
      })),
    });

    let message = "";
    try {
      await reader.queryRecentSessions({ days: 7, session_limit: 10, event_limit_per_session: 20 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Multiple running Supabase instances are available; configure ALIYUN_SUPABASE_INSTANCE");
    for (const identity of identities) expect(message).not.toContain(identity);
  });

  it("never reflects upstream errors, URLs, keys, or instance identity", async () => {
    const leaked = [
      INFRASTRUCTURE.publicConnectionString,
      INFRASTRUCTURE.serviceKey,
      INFRASTRUCTURE.instanceName,
      "aliyun-secret-key",
    ];
    const { reader } = readerFixture({
      authError: new Error(`failure ${leaked.join(" ")}`),
    });

    let message = "";
    try {
      await reader.queryRecentSessions({ days: 7, session_limit: 10, event_limit_per_session: 20 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Supabase session query failed");
    for (const secret of leaked) expect(message).not.toContain(secret);
  });

  it("does not reflect a postgres-meta error body", async () => {
    const cloud = fakeCloud();
    const responseBody = `failed ${INFRASTRUCTURE.publicConnectionString} ${INFRASTRUCTURE.serviceKey}`;
    const reader = createSupabaseSessionReader({
      tenantId: "tenant-a",
      credentialsProvider: async () => ({
        accessKeyId: "aliyun-access-key",
        accessKeySecret: "aliyun-secret-key",
        regionId: "cn-hongkong",
      }),
      clientFactory: cloud.clientFactory,
      fetchFn: async () => new Response(responseBody, { status: 500 }),
    });

    let message = "";
    try {
      await reader.queryRecentSessions({ days: 7, session_limit: 10, event_limit_per_session: 20 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Supabase session query failed");
    expect(message).not.toContain(responseBody);
  });

  it("cancels an oversized streaming query response before reading it all", async () => {
    const cloud = fakeCloud();
    const oneMegabyte = new Uint8Array(1_000_000);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(oneMegabyte);
        if (pulls === 40) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = createSupabaseSessionReader({
      tenantId: "tenant-a",
      credentialsProvider: async () => ({
        accessKeyId: "aliyun-access-key",
        accessKeySecret: "aliyun-secret-key",
        regionId: "cn-hongkong",
      }),
      clientFactory: cloud.clientFactory,
      fetchFn: async () => new Response(body, { status: 200 }),
    });

    await expect(reader.queryRecentSessions({
      days: 7,
      session_limit: 10,
      event_limit_per_session: 20,
    })).rejects.toThrow("Supabase session query response is too large");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(40);
  });
});

describe("reader configuration", () => {
  it("requires tenant and credentials from environment, with instance optional", () => {
    expect(loadSupabaseSessionEnvironment({
      OMA_TENANT_ID: "tenant-a",
      ALIYUN_ACCESS_KEY_ID: "ak",
      ALIYUN_ACCESS_KEY_SECRET: "sk",
      ALIYUN_REGION: "cn-hongkong",
      ALIYUN_SUPABASE_INSTANCE: "instance-a",
    })).toEqual({
      tenantId: "tenant-a",
      configuredInstance: "instance-a",
      credentials: {
        accessKeyId: "ak",
        accessKeySecret: "sk",
        regionId: "cn-hongkong",
      },
    });
    expect(() => loadSupabaseSessionEnvironment({
      ALIYUN_ACCESS_KEY_ID: "ak",
      ALIYUN_ACCESS_KEY_SECRET: "sk",
      ALIYUN_REGION: "cn-hongkong",
    })).toThrow("OMA_TENANT_ID is required");
  });

  it("falls back to the Codex wrapper's Alibaba Cloud credential aliases", () => {
    expect(loadSupabaseSessionEnvironment({
      OMA_TENANT_ID: "tenant-a",
      ALIYUN_ACCESS_KEY_ID: "   ",
      ALIYUN_ACCESS_KEY_SECRET: "",
      ALIBABA_CLOUD_ACCESS_KEY_ID: "alias-ak",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "alias-sk",
      ALIYUN_REGION: "cn-hongkong",
    })).toEqual({
      tenantId: "tenant-a",
      credentials: {
        accessKeyId: "alias-ak",
        accessKeySecret: "alias-sk",
        regionId: "cn-hongkong",
      },
    });
  });

  it("emits only a SELECT-only SQL template", () => {
    const query = buildRecentSessionsSql("tenant-a", {
      days: 7,
      session_limit: 100,
      event_limit_per_session: 200,
    });
    expect(query).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|NOTIFY|COPY|CALL|DO)\b/i);
  });
});
