import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decodeJwt } from "jose";
import { createApp } from "../src/app.js";
import {
  InMemoryUserStore,
  InMemoryApiKeyStore,
  InMemoryEventLogStore,
} from "@oma-server/store-memory";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  delete process.env.AUTH_DISABLED;
  delete process.env.INVITE_CODE;
  delete process.env.AUTH_JWT_SECRET;
}

beforeEach(() => {
  resetEnv();
  // Exercise the real auth path.
  process.env.AUTH_DISABLED = "false";
  process.env.INVITE_CODE = "let-me-in";
  process.env.AUTH_JWT_SECRET = "test-secret-value";
});

afterEach(() => {
  resetEnv();
  process.env.AUTH_DISABLED = ORIGINAL_ENV.AUTH_DISABLED;
  process.env.INVITE_CODE = ORIGINAL_ENV.INVITE_CODE;
  process.env.AUTH_JWT_SECRET = ORIGINAL_ENV.AUTH_JWT_SECRET;
});

function build() {
  const userStore = new InMemoryUserStore();
  const apiKeyStore = new InMemoryApiKeyStore();
  const eventLogStore = new InMemoryEventLogStore();
  const app = createApp({
    apiKeyStore,
    fullApiKeyStore: apiKeyStore,
    userStore,
    eventLogStore,
  });
  return { app, userStore, apiKeyStore };
}

function post(app: ReturnType<typeof build>["app"], path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /auth/register", () => {
  it("registers a new user and returns a token", async () => {
    const { app } = build();
    const res = await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "let-me-in",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("rejects a wrong invite code with 403 invalid_invite_code and creates no user", async () => {
    const { app, userStore } = build();
    const res = await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "wrong",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("invalid_invite_code");
    expect(await userStore.findByUsername("alice")).toBeNull();
  });

  it("returns 403 registration_closed when INVITE_CODE is unset", async () => {
    delete process.env.INVITE_CODE;
    const { app } = build();
    const res = await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "anything",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("registration_closed");
  });

  it("returns 409 username_taken for a duplicate username", async () => {
    const { app } = build();
    await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "let-me-in",
    });
    const res = await post(app, "/auth/register", {
      username: "Alice",
      password: "password456",
      inviteCode: "let-me-in",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("username_taken");
  });

  it("returns 400 validation_error for a bad username", async () => {
    const { app } = build();
    const res = await post(app, "/auth/register", {
      username: "ab",
      password: "password123",
      inviteCode: "let-me-in",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("returns 400 validation_error for a short password", async () => {
    const { app } = build();
    const res = await post(app, "/auth/register", {
      username: "alice",
      password: "short",
      inviteCode: "let-me-in",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("validation_error");
  });

  it("returns 503 auth_unavailable when AUTH_JWT_SECRET is unset", async () => {
    delete process.env.AUTH_JWT_SECRET;
    const { app } = build();
    const res = await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "let-me-in",
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("auth_unavailable");
  });
});

describe("POST /auth/login", () => {
  async function register(app: ReturnType<typeof build>["app"]) {
    return post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "let-me-in",
    });
  }

  it("logs in with correct credentials", async () => {
    const { app } = build();
    await register(app);

    const res = await post(app, "/auth/login", {
      username: "alice",
      password: "password123",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe("string");
  });

  it("returns 401 invalid_credentials for a wrong password", async () => {
    const { app } = build();
    await register(app);

    const res = await post(app, "/auth/login", {
      username: "alice",
      password: "wrong-password",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("invalid_credentials");
  });

  it("returns 401 invalid_credentials for an unknown username", async () => {
    const { app } = build();
    const res = await post(app, "/auth/login", {
      username: "ghost",
      password: "password123",
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("invalid_credentials");
  });

  it("returns 503 auth_unavailable when AUTH_JWT_SECRET is unset", async () => {
    delete process.env.AUTH_JWT_SECRET;
    const { app } = build();
    const res = await post(app, "/auth/login", {
      username: "alice",
      password: "password123",
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("auth_unavailable");
  });
});

describe("register → token → authorize /v1 round-trip", () => {
  it("the Bearer session token authorizes /v1/api-keys and scopes to the same tenant", async () => {
    const { app } = build();

    const regRes = await post(app, "/auth/register", {
      username: "alice",
      password: "password123",
      inviteCode: "let-me-in",
    });
    expect(regRes.status).toBe(200);
    const { token } = await regRes.json();

    // Token carries a tenantId and can be decoded.
    const payload = decodeJwt(token);
    expect(typeof payload.tenantId).toBe("string");
    const tenantId = payload.tenantId as string;

    // login yields a token whose tenant matches the registered one.
    const loginRes = await post(app, "/auth/login", {
      username: "alice",
      password: "password123",
    });
    expect(loginRes.status).toBe(200);
    const { token: loginToken } = await loginRes.json();
    expect(decodeJwt(loginToken).tenantId).toBe(tenantId);

    // Create a key using the Bearer token.
    const createRes = await app.request("/v1/api-keys", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "console-key" }),
    });
    expect(createRes.status).toBe(201);

    // GET /v1/api-keys with the Bearer token lists the created key.
    const listRes = await app.request("/v1/api-keys", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].name).toBe("console-key");
  });

  it("rejects an invalid Bearer token with 401", async () => {
    const { app } = build();
    const res = await app.request("/v1/api-keys", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(res.status).toBe(401);
  });
});
